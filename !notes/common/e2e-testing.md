# E2e testing (Playwright) conventions and gotchas

Two-project Playwright setup in `playwright.config.ts`: `mock` (no `-integration` suffix, fast, injects messages client-side, no Claude CLI) and `integration` (`*-integration.spec.ts`, real backend + CLI, runs after `mock` via `dependencies: ['mock']`).

## One flat timeout for every test (one place)

- Global `timeout: 30_000` applies to **both** projects, mock and integration alike. `retries: 0` on the `integration` project so a hang isn't paid twice.
- This replaced an earlier `integration`-only override of `timeout: 90_000`. That 90s cap was too generous: a real CLI turn in these tests normally finishes in a few seconds, so anything actually hanging still burned close to a minute and a half before being reported. At a flat 30s the full 112-test integration run (108 passed, 4 known skips) completes in ~5 min when the backend is healthy - faster than the old 90s-tiered run, not slower, because nothing was legitimately using the extra headroom.
- **A per-test `test.setTimeout(...)` override is allowed, but only as a rare, explicit, commented exception** for a test that provably needs more than 30s (e.g. `session-browse-during-stream-integration.spec.ts`'s three-real-CLI-turn test uses `test.setTimeout(60_000)`). This reverses the earlier blanket "never add per-test overrides" rule from when the project timeout was 90s - at 90s nothing needed one, so the rule was easy to keep; at a flat 30s a handful of genuinely multi-turn tests do. The bar stays high: justify it in a comment, don't reach for it to paper over a slow/flaky assertion.

## Guard against a reused dev server with the wrong config

`webServer.reuseExistingServer: true` (`playwright.config.ts`) means a `yarn dev` the user already had running gets adopted as the backend instead of Playwright starting its own. If that process was launched from a plain shell (no `ARGUS_CONFIG`), it reads and **writes** the real `~/.claude/argus.json` instead of `e2e/argus.json` - tests that change settings through the UI corrupt the user's actual config, and tests that depend on `e2e/argus.json` values (`showLogs`, `effort`, `allowedOrigins`, ...) fail against values they never set. This looks like several unrelated product bugs, not one environment problem.

`e2e/global-setup.ts` catches it before any test runs: it hits a loopback-only `GET /health` on the dev server (`src/backend/index.ts`, added for this - returns `{ configPath, pid }` only to `127.0.0.1`/`::1`, 403 otherwise) and compares `configPath` against the resolved `e2e/argus.json` path (case-insensitive on `win32`, where the drive letter's case is launch-dependent). A mismatch throws immediately with a message naming the offending pid and telling the user to `yarn dev:stop` first. If the server isn't reachable yet (Playwright's `webServer` start order relative to `globalSetup` is version-dependent), that's treated as fine - only a live mismatch is fatal, since a server Playwright starts itself always gets the right env via `webServer.env`.

## Integration concurrency: `workers: 1`

The `integration` project sets `workers: 1`. Each integration test drives a real Claude CLI **plus** a Chromium instance against the one shared `:3001` backend.

**Why not 2+?** With 2 workers the backend dies mid-run on this machine, causing a 40-test cascade. Two compounding causes:

1. **Resource exhaustion**: concurrent Claude CLI processes + Chromium instances push the machine past its limits. The backend stops responding, every later test sees `"Disconnected, reconnecting..."`.
2. **Concurrent writes to `e2e/argus.json`**: `effort-thinking-integration` and `network-access-integration` both write to this file directly from their worker processes (outside the backend). When they run in parallel their `fs.writeFileSync` calls race and can corrupt the JSON. The backend catches parse errors and falls back to `cachedConfig`, so it doesn't crash outright - but the combination with resource exhaustion kills it.

At `workers: 1` the full suite completes in ~7 min (vs ~10 min with cascades at `workers: 2`). Faster **and** reliable.

**If many integration tests fail at once, suspect the cascade before suspecting the tests.** The signature is that they share the page state `"Disconnected, reconnecting..."` and fail in run order from some point onward. See [../issues/integration-suite-cascade-crash.md](../issues/integration-suite-cascade-crash.md) for the full root-cause chain (leaked CLI processes -> resource exhaustion -> synchronous `spawn()` throw -> dead server).

### Run with the backend's stdout captured

Playwright's `webServer` swallows server output, which hides backend crashes and makes a cascade look like N assertion failures. For any non-trivial integration debugging, own the server yourself:

```bash
yarn dev > /tmp/be.log 2>&1 &
npx playwright test --project=integration --no-deps
```

Then check the log for `MemoryExhaustion` / `spawn UNKNOWN` / a `handleSend` stack, and `netstat -ano | grep ":3001 .*LISTENING"` to confirm the backend is still alive after the run.

## Writing stable integration assertions

Integration specs run against a real model, so an assertion is only stable if it depends on something the **app** guarantees rather than something the model chooses.

- **Do not gate on tool calls.** `locator('[class*="toolCall"]')` assumes the model decided to call a tool, and how fast. It intermittently never appears. Gate on the **Stop button** instead - it is rendered for every active turn, which is usually the actual precondition ("the turn is in flight"):
  ```ts
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 10_000 });
  await expect(stopBtn).toHaveCount(0, { timeout: 20_000 }); // turn finished
  ```
  Both numbers must fit under the flat 30s test timeout with room for everything else in the test - there is no longer a 90s tier to lean on.
- **Do not assume a stream is still live** when the assertion runs. A test that browses/interacts mid-stream should branch on whether the turn is still running rather than racing it. Use `waitFor`, not `isVisible({ timeout })` - `isVisible()` is an immediate check and the `timeout` option does not make it wait, so right after a UI transition it reports `false` for a stream that *is* live and sends the test down the wrong branch:
  ```ts
  const isLive = await stopBtn.waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true).catch(() => false);
  ```
- **Prefer app-owned state** (buttons, timers, committed message DOM) over model-owned output (specific wording, tool choice, response length) as a synchronisation point.

### Gotcha: the CLI's persistent memory pollutes "the model can't know this" tests

The Claude CLI auto-loads `~/.claude/projects/<encoded-cwd>/memory/` (and `CLAUDE.md`) into **every** new session, including the ones integration tests spawn. Any test asserting that a reset session has *forgotten* something must account for this:

- **Never hard-code the secret/token literal.** A hard-coded value can end up in that persistent memory and a correctly-reset session will then legitimately know it - the test fails for the wrong reason. Generate it per run:
  ```ts
  const token = `scub-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  ```
- **Never use the word "remember" in the prompt.** It reads as an instruction to persist, and the agent obeys by *writing the token into the memory file* - polluting the user's real memory and making the later recall assertion legitimately pass. Keep it conversational and explicit: `"My build tag for this conversation is X. Reply with just \"OK\" - do not save this anywhere."`
- **Forbid tools in the recall prompt** (`"Answer from conversation context only - do not read any files"`), otherwise the agent can go looking for the value on disk.

`e2e/new-chat-integration.spec.ts` is the worked example.

### Gotcha: a replayed transcript has no timers or token counts

`loadSession` (`src/backend/sessions.ts`) rebuilds messages from the `.jsonl` with only `outcome: 'success'` - it sets no `responseTime`, no `finishedAt`, and no token fields. So after a **disk replay** (opening or returning to a session that is not live in memory) there is no `[class*="responseTime"]` element in the DOM at all.

Consequence for tests that browse away mid-stream and come back: the "stream already finished" branch cannot assert token counts, because the data does not exist on that path. `session-browse-during-stream-integration.spec.ts` used to have such a branch and failed with `element(s) not found` whenever the model outran the browse round-trip (more likely since `--effort low`). The fix is to keep the live precondition (longer prompt) and `test.skip(!isLive, reason)` otherwise - never assert a state the architecture cannot produce. Branching to a second assertion "just in case" hides that the branch is impossible.

## Integration config: `e2e/argus.json`

- The integration dev server is started with `ARGUS_CONFIG=e2e/argus.json` (see the `webServer.env` in `playwright.config.ts`).
- This file is the server's **full** settings config. It is **not** limited to backend keys (model/watchdog/network) - it also carries the webview UI toggles (`showLogs`, `showTimer`, `verboseTools`, ...). All of these live in `src/backend/config.ts`'s `DEFAULT_CONFIG` and are returned to the webview.
- **Settings hydration:** `webview/src/contexts/SettingsContext.tsx` starts from its own `DEFAULTS`, posts `getSettings` on mount, and the server replies with a `settings` message that is merged **over** the defaults. So the server config (this file) wins over the webview defaults at runtime.

### Gotcha: `showLogs` must stay `true` here

- `log-autoscroll-integration.spec.ts` needs the debug log panel mounted (it asserts `[data-testid="log-list"]` is visible). The panel renders only when `showLogs` is true (`App.tsx`).
- If `e2e/argus.json` sets `showLogs: false`, the server tells the webview to hide the panel and that test **hangs** until timeout waiting for the log-list locator. This actually happened once when the key was flipped while adding the network-access settings - restore it to `true`.
- **Client-side injection does not fix it reliably.** Dispatching a synthetic `settings {showLogs:true}` message after `waitForApp` races the real `getSettings` reply, which can arrive later and re-hide the panel mid-test. Fix the config file (the source of truth), don't fight the server.
- Toggling `showLogs` through the Settings UI is also wrong here: `updateSettings` writes the key back into the shared `e2e/argus.json`, leaking into other tests. The `network-access-integration` spec mutates this file too, but it snapshots it in `beforeAll` and restores verbatim in `afterAll`.

## Message injection idiom

Mock specs (and any client-side override) inject an incoming server message with:
```ts
await page.evaluate(() => {
  window.dispatchEvent(new MessageEvent('message', { data: { type: '...', /* ... */ } }));
});
```
This simulates a server->webview message; it does not get re-sent to the backend.

## Never automate a real destructive OS-level action in a test

Some features (e.g. `killAllClaude`, see [../tasks/stop-all-claude-button/notes.md](../tasks/stop-all-claude-button/notes.md)) send a WS message whose handler runs a real OS command with effects outside this app - a process kill by image name, for instance. Mock's client-side message injection does **not** protect against this: the "mock" project still runs against a real live backend (`webServer`), and only two message types are ever suppressed from actually reaching it (`webview/index.html`'s dev-mode `MOCK_SUPPRESSED = { getSkills: 1, listSessions: 1 }`, there to stop async replies from clobbering injected mock data - it is not a safety allowlist). A test - or a manual click while iterating in a browser - that performs the real second step of such an action will actually execute it on whatever machine is running the suite, which can include a live `claude.exe` behind the very Claude Code session doing the work.

- Test the arming/UI-state-machine side of a two-step destructive action with real clicks (safe: it sends nothing).
- Test the result-rendering side by simulating the reply (`window.dispatchEvent`, above) rather than by letting the real action fire.
- Verify the underlying OS command's mechanics (parsing, counting, success/failure paths) against a **decoy target** (e.g. a throwaway `notepad++.exe`), not the real one, before trusting it in the shipped code.
- If a feature like this ever needs a true integration test, it must not run against this dev machine's ambient processes - spawn and target a disposable child process created by the test itself.
