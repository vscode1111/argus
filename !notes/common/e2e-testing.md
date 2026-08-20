# E2e testing (Playwright) conventions and gotchas

Two-project Playwright setup in `playwright.config.ts`: `mock` (no `-integration` suffix, fast, injects messages client-side, no Claude CLI) and `integration` (`*-integration.spec.ts`, real backend + CLI, runs after `mock` via `dependencies: ['mock']`).

## One flat timeout for every test (one place)

- Global `timeout: 30_000` applies to **both** projects, mock and integration alike. `retries: 0` on the `integration` project so a hang isn't paid twice.
- This replaced an earlier `integration`-only override of `timeout: 90_000`. That 90s cap was too generous: a real CLI turn in these tests normally finishes in a few seconds, so anything actually hanging still burned close to a minute and a half before being reported. At a flat 30s the full 112-test integration run (108 passed, 4 known skips) completes in ~5 min when the backend is healthy - faster than the old 90s-tiered run, not slower, because nothing was legitimately using the extra headroom.
- **A per-test `test.setTimeout(...)` override is allowed, but only as a rare, explicit, commented exception** for a test that provably needs more than 30s (e.g. `session-browse-during-stream-integration.spec.ts`'s three-real-CLI-turn test uses `test.setTimeout(60_000)`). This reverses the earlier blanket "never add per-test overrides" rule from when the project timeout was 90s - at 90s nothing needed one, so the rule was easy to keep; at a flat 30s a handful of genuinely multi-turn tests do. The bar stays high: justify it in a comment, don't reach for it to paper over a slow/flaky assertion.

## Guard against a reused dev server with the wrong config

`webServer.reuseExistingServer: true` (`playwright.config.ts`) means a `yarn dev` the user already had running gets adopted as the backend instead of Playwright starting its own. If that process was launched from a plain shell (no `ARGUS_CONFIG`), it reads and **writes** the real `~/.claude/argus.json` instead of `e2e/argus.json` - tests that change settings through the UI corrupt the user's actual config, and tests that depend on `e2e/argus.json` values (`showLogs`, `effort`, `allowedOrigins`, ...) fail against values they never set. This looks like several unrelated product bugs, not one environment problem.

`e2e/global-setup.ts` catches it before any test runs: it hits a loopback-only `GET /health` on the dev server (`src/backend/index.ts`, added for this - returns `{ configPath, pid }` only to `127.0.0.1`/`::1`, 403 otherwise) and compares `configPath` against the resolved `e2e/argus.json` path (case-insensitive on `win32`, where the drive letter's case is launch-dependent). A mismatch throws immediately with a message naming the offending pid and telling the user to `yarn dev:stop` first. If the server isn't reachable yet (Playwright's `webServer` start order relative to `globalSetup` is version-dependent), that's treated as fine - only a live mismatch is fatal, since a server Playwright starts itself always gets the right env via `webServer.env`.

**The `mock` project is not immune to the wrong config**, which is easy to assume since mock specs inject their own data. Observed on 2026-08-21 running the mock suite against a dev server on the real `~/.claude/argus.json` (`model: "claude-opus-5"`) instead of `e2e/argus.json` (`model: ""`): 193 passed and `model-picker.spec.ts` "a dated list id highlights when the active model is the dateless alias" failed, because the active-model checkmark comes from the server's `workspaceInfo`, not from the injected `modelList`. `getModels` is in `MOCK_SUPPRESSED`, `getInfo` is not. A single mock failure in a settings-reading spec is therefore worth checking against `/health` before it is debugged as a product bug.

### Running mock specs without stopping the user's dev server

The guard is a hard stop, and stopping a `yarn dev` the user is actively working in (or reconnecting every open Argus panel to a restarted backend) is a real cost for a one-file mock run. [scripts/playwright.mock-only.ts](scripts/playwright.mock-only.ts) is the escape hatch: the root config minus `globalSetup` and minus the `integration` project, with `channel: 'chrome'` so it also survives the chromium revision drift below.

```bash
node node_modules/@playwright/test/cli.js test \
  --config "!notes/common/scripts/playwright.mock-only.ts" e2e/<file>.spec.ts
```

Limits, in order of how badly they bite:

- **Never point it at `*-integration.spec.ts`.** Those patch `e2e/argus.json` through the UI, which is precisely what the guard protects; the project filter drops them, so an explicit path just matches nothing.
- **"Mock" still talks to a real backend** (same point as the destructive-action section below). It is safe only because no mock spec writes server settings - re-check rather than assume, with `grep -L integration e2e/*.spec.ts | xargs grep -l "updateSettings\|switchModel\|switchEffort\|switchThinking\|restartDaemon\|killAllClaude"`. As of 2026-08-21 only `kill-all-claude.spec.ts` matches, and it never clicks its confirm step.
- **Results are still config-dependent** - the `model-picker.spec.ts` failure above is exactly what running this way looks like. A failure here has to be diffed against the two configs before it is believed.
- Inherited relative paths (`testDir`, `outputDir`, `webServer.cwd`) resolve against the **config file's own directory**, so they are re-anchored at the repo root inside it; moving that file means fixing the `../` depth.

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

### Not every mass failure is the cascade: back-to-back runs fight over the dev server

Extends the company-level [playwright-run-hygiene.md](../../../!notes/common/playwright-run-hygiene.md), which covers the mechanism (`reuseExistingServer: true` also adopts the still-shutting-down server of *your own previous run*, and the output dir is wiped at each run start). Here is how the two failure modes look **in this repo**, because they are easy to confuse:

- **Cascade**: the page loads and shows `"Disconnected, reconnecting..."` - only the backend on `:3001` died, Vite is fine. `node scripts/test-clean.js --dry` usually finds leaked CLI processes.
- **Server handover**: `page.goto` itself is refused (`net::ERR_CONNECTION_REFUSED at http://localhost:5173/`), so Vite is gone too, and `test-clean --dry` reports nothing to clean. The remedy is patience, not cleanup: `netstat -ano | grep -E ":5173 .*LISTENING|:3001 .*LISTENING"` must print nothing before the next run (`TIME_WAIT` rows are harmless).

Seen 2026-08-21 running one spec three times in a row: 3/3 green, 3/3 red, then 3/3 green again with nothing changed but the wait between runs.

**Before re-running anything, copy the failure artifact out of `test-results/`**, which the next run empties: `mkdir -p tmp && cp -r "test-results/<folder>" tmp/` (`tmp/` is gitignored and does not exist until you create it). The `error-context.md` a11y snapshot includes the app's **Debug Log panel** here, i.e. the raw CLI stdout events with timestamps (spawn args, `event: stream_event ... text_delta`, `event: result`) - usually enough to tell an app bug from CLI/model behaviour with no re-run at all. That is how the `streaming-partial` failure was identified as correct-but-2-frames rather than broken streaming; and how the flaky `account-usage.spec.ts:92` was *not* identified, its artifact having been wiped by a re-run of a different spec.

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
- **Put a threshold at the real boundary, not at a comfortable-looking number.** If a behaviour is binary in the code, find the value that separates the two branches and assert *that*; anything above it is a second, unstated assertion about model speed. `streaming-partial-integration.spec.ts` required `>= 3` `text_chunk` frames when the code's actual boundary is 1 (with `--include-partial-messages` off, `handleAssistant` sends a single frame with the whole text via `!s.receivedDeltas`). Frames beyond the second only count how long generation lasted, since the CLI flushes deltas on a ~0.8s timer - so a correct 2-frame run failed. Where a small count is unavoidable, also **size the prompt so the effect is observable**: 80 numbers generate in under a second and yield 2 frames, 200 numbers yield 5-6.

### Run the red before trusting a regression test

A test written after the fix has never been shown to catch the bug. Revert the fix (or
re-create the broken structure in the live DOM), run it, and read **which assertion**
fails and with what value. Two things this catches, both hit while writing
`e2e/code-copy-button.spec.ts`:

- **Failing on shape instead of behavior.** The first version located the scroll container
  as `page.locator('.code-block-wrapper').locator('pre')`, which only exists after the fix
  restructured the DOM. Against the old code it failed with a 30s locator timeout - red,
  but for the wrong reason, and it would have failed the same way for any future refactor.
  Locating by content instead (`page.locator('pre').filter({ hasText: 'scub-value-0' })`)
  made the red the actual assertion: `expect(Math.abs(after.x - before.x)).toBeLessThan(1)`
  → `Received: 3453`.
- **A test that passes on the broken code.** The companion "copy still works after
  scrolling" test passed against the bug too, because Playwright scrolls a target into view
  before clicking, so it never sees the button parked off-screen. That does not make it
  useless - it guards the restructure - but its comment must say what it guards, or the
  next reader will trust it as regression cover it does not provide.

### Gotcha: reading the clipboard right after clicking a copy button

`navigator.clipboard.writeText()` resolves a round trip after the click, and the app's
`CopyButton` (`webview/src/utils/markdown.tsx`) has no `.catch()` on it. So
`click()` → `page.evaluate(() => navigator.clipboard.readText())` is a race: lose it and
the clipboard still holds its previous value, and the failure reads as a wrong/empty
string rather than as a timing problem. Gate on the app's own confirmation first - these
buttons swap their glyph to `✓` when the write resolves:

```ts
await btn.click();
await expect(btn).toHaveText('✓', { timeout: 5_000 });   // write resolved
const text = await page.evaluate(() => navigator.clipboard.readText());
```

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

## Mock data clobbered by real backend replies

The "mock" project still runs against a live backend, so a component that fires a data query (`getModels`, `getServerInfo`, ...) gets a **real** reply alongside the test's injected one - and whichever lands last wins. The failure is load-dependent (the real reply's timing shifts under 4 parallel workers), so the spec passes in isolation and flakes in the full run.

Three independent fixes, pick per constraint:

1. **Suppress the outgoing query globally** by adding its type to `MOCK_SUPPRESSED` in `webview/index.html` - then no real reply ever exists. This is how `getSkills`, `listSessions`, and `getModels` are handled. Not always possible: `getServerInfo` cannot go there because `kill-all-claude.spec.ts` asserts on the outgoing send itself (a `WebSocket.prototype.send` interception).
2. **Drop the outgoing query per-spec** when the global list is off-limits: `page.addInitScript` patches `WebSocket.prototype.send` to swallow just that message type before the app scripts load (see `version-skew.spec.ts`'s `beforeEach`). This is how version-skew was deflaked - its failures were invisible while the real `serverVersion` happened to equal the mocked one and went guaranteed-red after the 0.0.81 bump made them diverge.
3. **Re-dispatch until observed**: when the consuming component registers its `message` listener in a `useEffect` (after paint), a single dispatch can also be lost outright. Wrap dispatch + a cheap visibility assert in `expect(...).toPass()` (see `deliverModelList` in `model-picker.spec.ts`, same pattern as `clickAndWaitForModal` in file-path-links).
4. **Wait for the real reply, then dispatch over it**: `openModal` in `account-usage.spec.ts` blocks until `Loading...` clears - which means a real `claude auth status --json` spawn has answered (15s budget) - so the injected message is the last write. It needs no global suppression, but it makes a *mock* spec depend on backend latency. `account-usage.spec.ts:92` flaked once in a full run and then passed 5/5 in isolation; load-dependent timing is the natural suspect, though the artifact was wiped before anyone read it. Prefer 1-3 wherever the query can be suppressed.

## `e2e/argus.json` drifts during integration runs

Features that persist runtime data into the config (e.g. `getModels` caching the fetched list into `modelListCache`) write into whatever config the server runs under - for integration runs that is the checked-in fixture `e2e/argus.json`. After a suite run, `git status` shows it modified with runtime fields. This is benign; `git checkout -- e2e/argus.json` before reviewing or committing so the diff carries only intentional changes.

## Child processes started from a test come back ANSI-coloured

Playwright sets `FORCE_COLOR` in the worker environment, and it is inherited by anything the test
spawns. A helper child that ends with `console.log(someNumber)` then returns
`"[33m1000000[39m"`, because `util.inspect` colourises numbers when it believes stdout
is a TTY - so `Number(out.toString().trim())` is `NaN` and the assertion fails with a value that
looks like nothing was printed at all.

Print a string, never a raw number or object: `console.log(String(n))`, or `JSON.stringify(obj)`
(which is why `runBuilder` in `workspace-info-config-integration.spec.ts` never hit this). Parsing
helpers should also reject non-finite results with the raw output in the message, otherwise the
failure surfaces as a bare `NaN` with no clue where it came from.

This applies to the child-process idiom generally: backend functions that read `ARGUS_CONFIG` must
be exercised in a child (`config.ts` resolves the path once at import time, and Playwright reuses
workers), so any spec doing that inherits this gotcha.

## Chromium revision drift breaks every browser test at once

`package.json` pins `"@playwright/test": "^1.59.0"`, so a `yarn install` can move the runner to a
new minor that expects a **newer chromium revision** than the one in
`~/AppData/Local/ms-playwright/`. Every browser-based test then fails identically before its body
runs:

```
browserType.launch: Executable doesn't exist at ...\chromium_headless_shell-1217\...
```

Distinguishing signal: the failure is in `browserType.launch`, not in any assertion, and
non-browser tests in the same file (pure child-process ones) still pass. Check the mismatch with:

```bash
node -e "console.log(require('./node_modules/@playwright/test/package.json').version)"
node -e "for (const b of require('./node_modules/playwright-core/browsers.json').browsers) if (/chromium/.test(b.name)) console.log(b.name, b.revision)"
ls ~/AppData/Local/ms-playwright/
```

Fix with `node scripts/install-browsers-manual.js`, **not** `npx playwright install` - the latter
deadlocks on this machine (see
[../../.claude/researches/playwright-install-hang.md](../../.claude/researches/playwright-install-hang.md)).
The manual installer reads the expected revision from the registry, so it needs no version argument.

## Never automate a real destructive OS-level action in a test

Some features (e.g. `killAllClaude`, see [../tasks/stop-all-claude-button/notes.md](../tasks/stop-all-claude-button/notes.md)) send a WS message whose handler runs a real OS command with effects outside this app - a process kill by image name, for instance. Mock's client-side message injection does **not** protect against this: the "mock" project still runs against a real live backend (`webServer`), and only a few message types are ever suppressed from actually reaching it (`webview/index.html`'s dev-mode `MOCK_SUPPRESSED = { getSkills: 1, listSessions: 1, getModels: 1 }`, there to stop async replies from clobbering injected mock data - it is not a safety allowlist). A test - or a manual click while iterating in a browser - that performs the real second step of such an action will actually execute it on whatever machine is running the suite, which can include a live `claude.exe` behind the very Claude Code session doing the work.

- Test the arming/UI-state-machine side of a two-step destructive action with real clicks (safe: it sends nothing).
- Test the result-rendering side by simulating the reply (`window.dispatchEvent`, above) rather than by letting the real action fire.
- Verify the underlying OS command's mechanics (parsing, counting, success/failure paths) against a **decoy target** (e.g. a throwaway `notepad++.exe`), not the real one, before trusting it in the shipped code.
- If a feature like this ever needs a true integration test, it must not run against this dev machine's ambient processes - spawn and target a disposable child process created by the test itself.
