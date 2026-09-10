# E2e testing (Playwright) conventions and gotchas

Two-project Playwright setup in `playwright.config.ts`: `mock` (no `-integration` suffix, fast, injects messages client-side, no Claude CLI) and `integration` (`*-integration.spec.ts`, real backend + CLI, runs after `mock` via `dependencies: ['mock']`).

## One flat timeout for every test (one place)

- Global `timeout: 30_000` applies to **both** projects, mock and integration alike. `retries: 0` on the `integration` project so a hang isn't paid twice.
- This replaced an earlier `integration`-only override of `timeout: 90_000`. That 90s cap was too generous: a real CLI turn in these tests normally finishes in a few seconds, so anything actually hanging still burned close to a minute and a half before being reported. At a flat 30s the full 112-test integration run (108 passed, 4 known skips) completes in ~5 min when the backend is healthy - faster than the old 90s-tiered run, not slower, because nothing was legitimately using the extra headroom.
- **A per-test `test.setTimeout(...)` override is allowed, but only as a rare, explicit, commented exception** for a test that provably needs more than 30s (e.g. `session-browse-during-stream-integration.spec.ts`'s three-real-CLI-turn test uses `test.setTimeout(60_000)`). This reverses the earlier blanket "never add per-test overrides" rule from when the project timeout was 90s - at 90s nothing needed one, so the rule was easy to keep; at a flat 30s a handful of genuinely multi-turn tests do. The bar stays high: justify it in a comment, don't reach for it to paper over a slow/flaky assertion.

### An assertion timeout above 30s is dead text, and it hides which specs are at the cliff

Twenty assertions across the integration specs still pass `{ timeout: 60_000 }` or
`{ timeout: 90_000 }`, left over from when the project timeout was 90s. The test timeout
always wins, so those numbers do nothing except make the failure message misleading: the log
reports `Expect "toHaveCount" with timeout 90000ms` directly above `Test timeout of 30000ms
exceeded`, which reads as if the wait was generous when it was cut at a third of that.

The measurement that matters, taken from the debug log of a real failure
(`!notes/tasks/e2e-turn-cost-budgets/artifacts/token-spending-failure/`): **a turn in this
workspace is not "a few seconds"**. A *fresh* session (no `--resume` in the spawn line) starts
at **77,346 input tokens** - this repo's `CLAUDE.md` alone is ~190KB - so
`Reply with just the single word "yes"` cost 2.9s of CLI startup plus **17.6s to first
token**, ~20s total, against a 30s budget that also pays for the page load and "New chat".

The symptom that identifies this class: **which test fails changes between runs, and it is
never the assertion the test is about.** Five distinct tests died this way across four runs
on 2026-09-06 (`send-while-streaming`, two in `token-spending`, `new-chat`,
`session-browse-during-stream`), every one at `toHaveCount(0)` on the Stop button, not one on
its own subject. Whichever test draws the slowest API latency dies, so **do not debug the
test named in the report**.

The cheapest way to confirm it before touching anything: **read the page snapshot in
`error-context.md` and check whether the thing the test asserts had already happened.** In
the `new-chat` failure the reply on screen was `NO MEMORY` with the token absent, which is
precisely what that test exists to prove - the feature worked and only the clock ran out.
A snapshot showing the finished state is proof of a budget failure, not a logic one.

Three different budgets can bind, and raising the wrong one changes nothing:

- the **test** timeout (flat 30s), which is what a multi-turn test runs out of - `new-chat`
  does two whole turns, so it now carries `test.setTimeout(90_000)`;
- an **assertion** cap below the cost of a turn, which fails on its own however generous the
  test budget is - `session-browse-during-stream`'s `sendAndWait` capped the wait at 20s
  against turns that run 5-20s, raised to 45s. Raising a cap only extends the runs that
  need it, so it costs nothing on healthy ones;
- a **hand-rolled deadline inside the test body**, which no config change can reach.
  `log-autoscroll` polls `while (stopBtn.count() > 0)` against `Date.now() + 15_000` and
  failed by **90ms** on an 80-line answer. Such a bound exists to catch a stall, so it has to
  sit *above* what a real turn costs and *below* the test timeout; at 15s it was neither, and
  had become the thing that fails. Now 60s inside a 90s test. **Grep for `Date.now() +` and
  bare `deadline` when rebudgeting a spec** - raising the project timeout would not have
  touched this one.

**Measure the test alone before believing it is slow.** `modal green highlight moves to the
browsed session` failed twice at the file level, and it runs in **12.4s in isolation** - a 5x
gap. The cause is inside the file rather than the test: `startStreaming` returns as soon as
the Stop button appears and deliberately never waits for the turn, so **every test using it
leaves a live CLI process behind**, and later tests in the same file compete with them.
Budget accordingly (this one now matches its siblings at 90s) or stop the leftover turns;
what does not work is treating the test that happens to run last as the slow one.

`token-spending-integration.spec.ts` now carries a file-level `test.setTimeout(90_000)`,
making the intent its assertions already stated actually true. Still silently capped and
worth watching, all waiting out a real turn on a 60-90s assertion inside a 30s test:
`new-chat`, `send-while-streaming` (observed failing this way once), `session-history`,
`session-history-line-count`, `chat`, `effort-thinking`, `image-recognize`,
`session-deep-link`, `session-info`.

Note the second-order effect: anything that grows `CLAUDE.md` raises the floor under every
integration turn in this workspace, since it is re-read on every spawn.

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
- **"Mock" still talks to a real backend** (same point as the destructive-action section below). It is safe only because no mock spec writes server settings - re-check rather than assume, with `grep -L integration e2e/*.spec.ts | xargs grep -l "updateSettings\|switchModel\|switchEffort\|switchThinking\|restartDaemon\|stopDaemon\|killAllClaude"`. As of 2026-08-21 only `kill-all-claude.spec.ts` and `stop-daemon.spec.ts` match, and neither clicks its confirm step (both buttons are two-click armed, and the arming click sends nothing).
- **Results are still config-dependent** - the `model-picker.spec.ts` failure above is exactly what running this way looks like. A failure here has to be diffed against the two configs before it is believed.
- Inherited relative paths (`testDir`, `outputDir`, `webServer.cwd`) resolve against the **config file's own directory**, so they are re-anchored at the repo root inside it; moving that file means fixing the `../` depth.

If you stop the dev server instead, the prior question is not cost but **safety**: when the run is driven from inside an Argus conversation, check that the answering CLI is not a descendant of the process about to be killed, or the kill aborts the turn doing it. The `:3001` dev server and the daemon are different pids and usually only one of them is your parent - the ancestor-chain probe is in [backend-restart.md](backend-restart.md). Also read this section *before* reaching for `yarn dev:stop`: on 2026-08-27 the guard fired, the server was stopped and later restored, and the escape hatch above was only noticed afterwards. For the single-file run it was the cheaper route; for the full 250-test mock suite stopping was still the right call, since `model-picker.spec.ts` reads server settings and fails against the real config.

### Do not edit `src/backend/` (or `server/`) while a suite is running

`scripts/dev.js` watches both folders and restarts the backend on save, so a source edit made
during a run reconnects every client mid-test. The failure it produces is a WS drop, i.e. the
signature of [the cascade](../issues/integration-suite-cascade-crash.md) and of an ordinary
flake, in a spec that has nothing to do with the file that was edited. An 8-10 minute
integration run is long enough that continuing to work feels natural, which is exactly why
this needs saying.

Measured 2026-09-07: a `session.ts` edit landed ~65 tests into a 140-test run and the run
still came back green, so the hazard is real but not deterministic - which makes it worse,
not better, since a green run teaches the habit. Park edits until the run reports, or drive
the run from a second checkout. Editing `webview/src/` is safe for the **mock** project only
in the sense that Vite serves from source (no backend restart); a mid-run HMR update still
changes the app under an assertion, so the rule is the same.

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
- **Half-dead adoption**: Vite is listening on `:5173` but the backend on `:3001` is not - typically after a run was killed rather than finishing (an interrupted `yarn test:e2e` orphans `scripts/dev.js`'s children unevenly). `webServer.url` only checks `:5173`, so Playwright adopts it and starts testing against a backend that does not exist. Here `yarn test:clean` **is** the fix (unlike the handover case). Check both ports, not just the one Playwright checks.

**A spec that talks to `:3001` directly must poll it first.** Playwright's readiness gate is Vite; the backend comes up alongside and can lag it, which a browser spec never notices (the page's WS just reconnects) but a raw `fetch`/`ws` client fails on immediately. Poll `GET /nonce` until it answers before connecting - see the helper at the top of `stop-then-send-integration.spec.ts`.

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
- **How long a turn lasts is model-owned too - hold it open with a tool call, not a long prompt.** A spec that needs the turn still running while a modal opens and a list loads off disk cannot buy that with "list the numbers from 1 to 300": the model abbreviates rather than emitting 300 lines, so the turn came back in 6s / ~610 output tokens and `session-active-marker-integration.spec.ts` flaked on *both* its tests, alternating between them (one on the marker already gone, one on the row not listed yet). Neither failure names the cause - what you get is "expected 1, received 0", and only the artifact's Send-button-with-a-committed-timer shows the turn was already over. Ask for a foreground `sleep` via Bash instead, which pins the live window regardless of model speed (``Run exactly `sleep 10` with the Bash tool, in the foreground, then reply DONE``). Bash is in `ALLOWED_TOOLS` so it needs no approval, Stop kills the process tree with it, and the spec got *faster* (15.7s vs 37s) because it no longer waits on generation. Keep the sleep well under the flat 30s timeout.
- **When exact wording is load-bearing for the assertion, demand it in the prompt.** `image-recognize-integration.spec.ts` asserts four exact identifiers are transcribed out of a screenshot but only asked to "Recognize text", so the model summarised ("plus streaming/tool-approval/no-Python conventions") and then editorialised about the doc looking outdated - failing on output the prompt never required. Asking for a verbatim transcription and nothing else fixes it without weakening a single assertion. Tightening the prompt beats loosening the expectation.
- **An event both the healthy and the broken path emit needs an ordering gate, not just a wait.** `done` is the trap: `stop` broadcasts one immediately, and a turn that never started also produces one, so "wait for `done` after sending" is satisfied in every case and measures nothing. Anchor it to the start of the turn you mean - record `thinking_start` first and only then accept a `done`:
  ```ts
  if (e.type === 'thinking_start') started = true;
  else if (e.type === 'done' && started) done = true;
  ```
  Without that gate, `stop-then-send-integration.spec.ts` reported a fixed build as still broken (the stop's own `done`, arriving *before* the new turn's `thinking_start`, was read as the new turn ending in 200ms). The timestamps were what exposed it - an out-of-order pair in the frame log, not a wrong value.
- **To prove data came from a background job, assert its age at request time - not an absolute cutoff.** When a feature's whole point is that the server produced something *before* anyone asked (a poller, a cache, a warm snapshot), the reply looks identical to an on-request fetch; only its timestamp separates them. The first attempt at `usage-indicator-integration.spec.ts` took a cutoff right after the daemon started listening and required `fetchedAt < cutoff`. It failed on a working build: the startup poll is a network round trip that completes a few hundred ms **after** the listen callback, so its own data is stamped later than the cutoff. Record the instant of the *request* instead and assert the data is already older than it by a margin, retrying until the background job lands:
  ```ts
  const reqAt = Date.now();
  ws.send(JSON.stringify({ type: 'getUsageLimits' }));
  const msg = await waitForFrame(ws, 'usageLimits');
  return reqAt - (msg.fetchedAt as number) > 1_500;   // predates the request => not fetched for it
  ```
  Pair it with a **control that disables the background job** and asserts the opposite (age ≈ 0). Without the control, "any reply at all" satisfies the test and a poller that never ran still passes. Diagnosing the failed first attempt is also a case for probing the unit directly (`!notes/tasks/usage-limits-indicator/scripts/probe-poller.js` showed the poller filling its snapshot in ~340ms, which located the bug in the assertion rather than the feature).
- **Put a threshold at the real boundary, not at a comfortable-looking number.** If a behaviour is binary in the code, find the value that separates the two branches and assert *that*; anything above it is a second, unstated assertion about model speed. `streaming-partial-integration.spec.ts` required `>= 3` `text_chunk` frames when the code's actual boundary is 1 (with `--include-partial-messages` off, `handleAssistant` sends a single frame with the whole text via `!s.receivedDeltas`). Frames beyond the second only count how long generation lasted, since the CLI flushes deltas on a ~0.8s timer - so a correct 2-frame run failed. Where a small count is unavoidable, also **size the prompt so the effect is observable**: 80 numbers generate in under a second and yield 2 frames, 200 numbers yield 5-6.
  - The same trap in its **off-by-one** form, and it hides behind a cache. `usage-indicator-integration.spec.ts` asserted `reqAt - snap.fetchedAt > 0` to prove a snapshot predates the request that read it. The real boundary is "not fetched **after** the request", i.e. `>=`: `publishUsageWindows` stamps `fetchedAt = Date.now()` and the reply goes out immediately after, so over localhost `reqAt` lands in the **same millisecond** and the difference is exactly `0`. Nothing was lost by relaxing it - a genuine on-request fetch costs a round trip to the usage API and lands tens of ms on the wrong side. What made it look random is that it is **conditional on cache state**, not timing luck: with a warm snapshot (inside the 60s refresh floor) `fetchedAt` is seconds old and it passes, so it fails on the *first* usage call of a suite and passes on every re-run - the worst possible signal, since re-running is the first thing anyone tries.

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
- **Reverting a webview fix means rebuilding, not just stashing.** The browser loads
  `media/webview.js`, a build artifact - stashing `webview/src/**` and re-running leaves the
  *fixed* bundle in place, so the "red" run is silently still green. The sequence is
  `git stash push -- <files>` -> `yarn build` -> run -> `git stash pop` -> `yarn build`.
  Note `git stash push -- <pathspec>` **stages every other modified file** as a side effect;
  `git reset` afterwards to restore the index.
- **Keep the controls that pass in both states, they localize the bug.** In
  `modal-persistence.spec.ts` four cases went red on the old code and two stayed green
  (mid-stream events, next turn starting). That split is the finding: the modal was not being
  closed by "some event during streaming" but specifically by the turn-commit boundary. A
  spec that only asserts the broken cases proves less than one that also pins down where the
  breakage stops.
- **A polling assertion cannot catch a *later* overwrite.** `toContainText` / `toHaveText`
  retry until they match and stop at the first success, so asserting right after triggering
  a fetch passes on the value that is momentarily correct and never sees the real reply land
  330ms later. A probe written that way "proved" the `getInfo` clobber did not exist and
  nearly closed the investigation; rewritten as `waitForTimeout(1500)` then read
  `innerText()`, the same probe printed `0.0.91` without the fix and `0.0.79` with it. When
  the bug *is* a late overwrite, wait first and read once - do not poll for the value you
  expect to survive.
- **When the fix *creates* the function under test, mutate instead of reverting.** Extracting a
  pure seam while fixing a bug (`applyRefreshResult` in `model-data-refresh.spec.ts`) leaves
  nothing to revert to: the old tree has no such export, so a "red" run is a module error, not a
  failing assertion, and proves nothing. Put the **old behaviour** back inside the new function
  instead (one line, marked `TEMPORARY MUTATION`), run, then restore and assert the marker count
  is 0 so the mutation cannot be committed. The red there was 3 failed / 7 passed with the
  failures confined to the persistence tests, which is the same localisation signal as the bullet
  above.

### `-integration` means a real CLI or backend, not merely "not a UI test"

The suffix routes the file into the serial `workers: 1` project, so it is a cost, not a label.
A test that exercises **compiled backend code as plain functions** drives no CLI and no server,
so it belongs in `mock`, which is parallel and runs first: `model-data-refresh.spec.ts` was
briefly named `-integration` out of habit before being moved.

Related, and easy to cargo-cult in the other direction: the child-process ceremony in
`context-window-integration.spec.ts` and `workspace-info-config-integration.spec.ts` exists only
because the functions they test read `ARGUS_CONFIG`, which `config.ts` resolves at **import**
time. A function that takes the config as an argument has no such coupling and can be called
directly with `require()` on the `out/` bundle, guarded by a `yarn compile` in `beforeAll`.

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

### Gotcha: you cannot wait on a list that is only fetched once

`SessionHistoryModal` reads its rows **once on mount**. So
`await expect(row).toBeVisible({ timeout: 15_000 })` can never see a session whose
transcript the CLI has not written yet: nothing inside that 15s re-reads the directory, and
the row only appears if some later `sessionList` push happens to land. The row does not
"take a while to show up", it will not show up at all - the long timeout just makes the
failure slower and disguises it as flakiness.

`session-active-marker-integration.spec.ts` failed exactly this way, and its failure
**screenshot showed the row present**, which is the tell: it arrived after the assertion
gave up (transcript created at 00:36:08, assertion window 00:35:45-00:36:00). Fix: drive the
re-fetch instead of waiting for one, via the modal's own Refresh button
(`aria-label="Refresh sessions"`, which disables itself in flight, so `click()` waits it
out):

```ts
await expect(async () => {
  await dialog.getByRole('button', { name: 'Refresh sessions' }).click();
  await expect(row).toBeVisible({ timeout: 2_000 });
}).toPass({ timeout: 15_000 });
```

Proving this needs a **constructed** red - both forms pass whenever the transcript happens
to exist already. A throwaway spec that opens the modal and writes a transcript 4s later
failed on the plain assertion and passed on the loop.

More generally: before writing a long timeout, ask what would make the value appear. If the
answer is "another request that nobody is going to send", the timeout is not the fix.

### Gotcha: an open centered modal blocks every click on the app behind it

The centered-modal shell (Session History, Workspace History, Account & Usage, Settings) renders a full-viewport `.overlay` (`position: fixed; inset: 0`) as its click-outside-to-close catcher. It sits above the whole app, so **no** app control can be clicked while a dialog is open, however visible that control looks.

The failure does not read like a layout problem. Playwright resolves the target, reports it visible, enabled and stable, scrolls it into view, and only then fails the hit test, retrying until the test times out:

```
locator resolved to <button title="Stop" aria-label="Stop" ...>
  - element is visible, enabled and stable
  - <div aria-hidden="true" class="_overlay_k6a4k_6"></div> intercepts pointer events
```

Close the dialog first (`page.keyboard.press('Escape')`, then assert `toHaveCount(0)`), or drive the action from a second page in the same context when the point of the test is to watch the open list react. Neither is a weakened assertion: a user cannot click through the overlay either.

The same overlay is `aria-hidden`, which is why role-based locators cannot see inside these modals and have to go through `[role="dialog"]` (see `preview-navigation.spec.ts`).

Found in `session-active-marker-integration.spec.ts`; full write-up in [../tasks/session-active-marker/notes.md](../tasks/session-active-marker/notes.md).

## A spec that depends on a live external API

Two separate obligations, and the second is the one that gets skipped.

**The spec must skip, not fail, when the API is unavailable.** Probe the dependency first and `test.skip(...)` on a bad answer, so a `429` is reported as "not exercised" rather than as a broken feature (`account-usage-integration.spec.ts` and `usage-indicator-integration.spec.ts` both do this). Then make sure *something* still runs unconditionally: assert the round trip in a form that holds when the API is down - one request yields exactly one reply, carrying either data or a stated `error`. Otherwise every assertion about that path evaporates precisely when the environment is degraded, and a wiring regression looks like a rate limit.

**The probe is not the fetch, so the skip guard has a race.** `test.skip(!(await liveUsageAvailable()))` is evaluated once; the request the test actually asserts on happens a moment later and can `429` on its own. Then the test **fails instead of skipping**, and it fails on correct product behaviour - the header renders its `.iconOnly` fallback (the designed no-data state) while the spec expects bars. Two of `usage-indicator-integration.spec.ts`'s tests do this reliably if you re-run that spec straight after a full suite has already spent the quota, which makes it look like the full run left something broken. Practical rule: **do not re-run usage-dependent specs back-to-back with the suite**, and read a failure there as "quota", not "regression", until the quota recovers. Re-running to confirm only deepens the `429`.

**The suite must not be what exhausts the quota.** Anything the server does on a timer runs for the whole suite, multiplied by every reconnect. Argus's usage poller is disabled for tests in two places - `ARGUS_USAGE_POLL: '0'` in `playwright.config.ts`'s `webServer.env` (the dev server on `:3001`) and in `e2e/daemonHelpers.ts` (spawned daemons) - after a day of runs put the account into a sustained `429` that then made the API-dependent specs skip. A background job added to `startServer` needs the same treatment, or it silently degrades every later run.

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

### Measuring in the same `evaluate` that dispatched reads the *previous* render

The dispatch is synchronous, the React re-render is not, so anything reading geometry or text in that
same callback sees the DOM as it was before the message landed. Specs avoid this by construction -
`background-tasks.spec.ts`'s `send()` resolves only after two `requestAnimationFrame`s, and every
locator assertion retries - but **manual verification through the Playwright MCP does not**, and that
is where it bites, because a hand-run `evaluate` looks like it proves something.

It cost a wrong conclusion on 2026-09-09: a flex fix was measured at `140px` against a predicted
`519px` and nearly rewritten as broken. The `140px` was the width of the *previous* injection's first
row, still on screen; reading `getComputedStyle` a moment later reported `flex: 0 0 auto`,
`max-width: 45%`, `519.297px`, exactly as designed. Prefer the **computed style** over a bounding box
when the question is "did this rule apply", and when a hand measurement contradicts a confident
prediction, suspect the timing before suspecting the code.

## Mock data clobbered by real backend replies

The "mock" project still runs against a live backend, so a component that fires a data query (`getModels`, `getServerInfo`, ...) gets a **real** reply alongside the test's injected one - and whichever lands last wins. The failure is load-dependent (the real reply's timing shifts under 4 parallel workers), so the spec passes in isolation and flakes in the full run.

Three independent fixes, pick per constraint:

1. **Suppress the outgoing query globally** by adding its type to `MOCK_SUPPRESSED` in `webview/index.html` - then no real reply ever exists. This is how `getSkills`, `listSessions`, and `getModels` are handled. Not always possible: `getServerInfo` cannot go there because `kill-all-claude.spec.ts` asserts on the outgoing send itself (a `WebSocket.prototype.send` interception).
2. **Drop the outgoing query per-spec** when the global list is off-limits: `page.addInitScript` patches `WebSocket.prototype.send` to swallow just that message type before the app scripts load (see `version-skew.spec.ts`'s `beforeEach`). This is how version-skew was deflaked - its failures were invisible while the real `serverVersion` happened to equal the mocked one and went guaranteed-red after the 0.0.81 bump made them diverge. **Fixing one message type does not fix the spec.** That same spec kept the identical hole on its *other* row for another ten versions: the client version is injected as `workspaceInfo`, and `getInfo` was never dropped, so the backend's real reply won whenever it landed last. It went red at 0.0.91 with `expected "0.0.79 (stale)", received "0.0.91"` - precisely the shape its own comment had predicted. When applying this fix, enumerate **every** query whose reply overlaps the injected state, not only the one that flaked. Observing it costs one page listener: log every inbound `workspaceInfo` and the real one shows up on mount *and* ~330ms after each `getInfo`.
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

**Both directions are testable without ever aiming at a real target** (added 2026-09-11, the per-pid `killCliProcess`):

- **Negative path: aim the guard at the test runner's own pid.** `killCliProcess(process.pid)` must be refused, because the runner is a `node.exe` and not the target image. A build that dropped the check would try to terminate the process running the suite - impossible to miss, and it needs no decoy at all.
- **Positive path: manufacture a decoy that genuinely matches.** Copy `node.exe` into a temp dir **under the target name** (`claude.exe`) and run it: the listing accepts it as a CLI and the real button really kills it, while every genuine session is untouched. This is what makes the success path verifiable at all - a decoy of a *different* name only ever exercises the refusal.
- **Suppression is the third lever, and it is worth adding for safety even though the list exists for a different reason.** `killCliProcess` was added to `MOCK_SUPPRESSED` so a mock spec can click the real button and assert the optimistic row removal without the message ever reaching the backend. That is strictly safer *and* better tested than the `killAllClaude` approach above, which cannot click at all.

## Asserting inside a sandboxed iframe, and what the fixture has to prove

Added 2026-09-02 (`html-preview` task). The previewer renders `.html` in
`<iframe srcDoc sandbox="">`, and testing that has three traps:

- **Playwright reaches inside it.** `page.frameLocator('[data-testid="..."]')` and
  `locator.evaluate()` both work; `sandbox=""` blocks the page's own scripts, not CDP. No
  need to fall back to attribute checks.
- **Assert the computed value, not the declaration.** The injected theme sheet exists to
  *win a cascade*, so the fixture paints itself the opposite colour and the assertion reads
  `getComputedStyle(body).backgroundColor` from inside the frame. Checking that the
  `<style>` element is present passes on a build where the sheet never applied - verified
  by mutating `srcDoc={htmlDoc}` back to `srcDoc={code}`, where only that test went red.
- **Prove the sandbox by behaviour.** Put a `<script>` in the fixture that would insert a
  marker element and assert the marker is absent. `toHaveAttribute('sandbox', '')` only
  restates the source.

## A fixture's own escaping is part of the test

Same task. A probe built its input with `String.raw`, where `` \` `` stays a literal
backslash-backtick - so the case labelled "in a code span" was escaped into prose, and both
cases exercised the same path. It still found a bug, which is what made it convincing, but
not the reported one, and the intended case went untested until the strings were rebuilt by
concatenation.

Print the input, or assert something that can only be true in the intended context (here:
the rendered text keeps its backslashes, which only happens inside a code span). A fixture
that quietly becomes a different fixture is indistinguishable from a passing test.

## Never run a mock spec while the integration project is running

Two Playwright runners share one dev server, and the second one costs twice:

- **It wipes `test-results/` on start**, so the artifacts of a failure the integration run
  produced minutes earlier are gone before they can be read. Observed 2026-09-08: a
  verify-red mock run destroyed the `error-context.md` of an integration failure that had
  just happened, leaving only the summary line to reason from.
- **It is exactly the resource contention `workers: 1` exists to avoid.** The integration
  project is serialised because a real CLI plus a Chromium per test already saturates the
  machine; adding a second runner is the same overload with a different name, and it shows up
  as a turn that never starts (Stop button never appears) or a model answer that never lands
  inside the budget, i.e. as a *product* bug in a spec unrelated to the change.

Wait for the run, or use a throwaway backend on a private port. The same applies to probes
that spawn a real CLI.

## A hand-built state mimic breaks silently when the real shape changes

The bundle-driving specs (`bg-task-counting`, `synthetic-user-message`, `task-notification-result`)
feed the compiled `handleCliEvent` a `SessionState` built as an untyped object literal - untyped by
necessity, since the spec sits across the frontend/backend tsconfig boundary and stubs half the
interface. The cost: when a real field's *shape* changes, `tsc` says nothing and the mimics fail at
runtime, or worse, keep passing. On 2026-09-09 `pendingBgTasks` went `Set` -> `Map` (the elapsed-time
note needs launch timestamps); every `src/` call site was audited as compatible, but all three mimics
still said `new Set()`. Two `bg-task-counting` tests died on `.set is not a function` - and the other
two specs stayed green only because their payloads never reach `addBgTask`, which is silence, not
compatibility. When changing the shape of any `SessionState` field, grep `e2e/` for the field name
and fix every mimic, including the ones that still pass.

## A payload copied from a transcript is not evidence about the stream

The two look interchangeable and are not: the CLI records things in
`~/.claude/projects/**.jsonl` that it never writes to stdout. A background task's
`<task-notification>` prompt is one of them, so a live handler gated on it
(`origin.kind === 'task-notification'` in `handleUserEvent`) was **dead code with a passing
test** - the spec fed it a record lifted from a transcript, which is a fixture asserting our
own belief back at us. Measured 2026-09-08: a full background-task cycle emits three `user`
events, all `tool_result`, none carrying `origin`
([../tasks/bg-turn-cause-marker/scripts/probe-notification-event.js](../tasks/bg-turn-cause-marker/scripts/probe-notification-event.js)).

Worse, it had an explanation attached ("nothing renders it live because the event lands
before `thinking_start`"), which predicted the observed behaviour correctly for the wrong
reason and survived a review pass for that exact reason.

So: when a spec's payload came from a transcript, a log, or a note rather than from the
process under test, say so in the comment, and spend the ninety seconds of real CLI time
before building on it. The probe pattern that works here is to spawn the CLI with the same
args `session.ts` uses (stream-json both ways, so the process stays alive between turns) and
hold stdin open through the event you are waiting for.

## Quote the `-g` pattern when a script shells out to Playwright

`spawnSync('npx', ['playwright', 'test', '-g', 'a marker with no turn behind it'], {shell:true})`
joins the array **without quoting**, so the pattern breaks into shell tokens: the run greps
for `does`, matches three unrelated tests, and reports `3 passed`. In a verify-red harness
that prints as a verdict about the test ("still green, proves nothing") when it is a verdict
about the harness. A second case matched nothing at all and printed `0 tests`.

Pass one quoted command string, and keep an explicit "no tests ran" branch - without it the
empty-grep case reads as a pass. Same family as the CRLF anchor no-op in
[development.md](development.md): a verification step that silently verifies nothing is worse
than no step, because it is recorded as evidence.

## A raw WS client must buffer from construction, not from `await open`

The idiom `const ws = await openClient(...); const seen = record(ws);` drops frames, and the
loss is silent. Joining a channel entry that already has state makes the server replay
`sessionLoaded` **synchronously during the upgrade** (`joinEntry` -> `replayToClient` in
`channel.ts`), so that frame can arrive in the same TCP read as the handshake response. The
`ws` library then emits `'open'` and `'message'` in one synchronous callback, while the
`await` continuation - where `record()` attaches its listener - only runs in the microtask
that follows. The frame is gone before anything is listening.

Nothing about it is probabilistic in a given run: it is missed **whenever the two reads
coalesce**, which depends on machine load, so it presents as a flake. Observed 2026-09-05 as
`browse-send-routing-integration.spec.ts` timing out on "the watcher to sync" (15s waiting
for `sessionLoaded || thinking_start`), passing on an immediate re-run.

Fix by buffering inside `openClient` from the moment the socket is constructed and seeding
`record()` from that buffer; do the copy and the listener attach in the same synchronous
step so nothing is dropped or double-counted. **Green runs are not evidence here** - the
failure is intermittent by nature, so the argument has to be that the window no longer
exists, not that it passed N times.

Same shape wherever a raw `ws` client is used against a live entry:
`resume-live-session-integration.spec.ts`, `shared-channel-integration.spec.ts`,
`usage-indicator-integration.spec.ts` still use the unbuffered ordering.

## The list reporter marks failures with `x`, never `not ok`

Grepping a piped run log for `not ok` reports **zero failures no matter how many there
were**. Playwright's `list` reporter uses `ok` / `x` / `-` (passed / failed / skipped or did
not run). Observed 2026-09-11: a full-suite run was reported as clean four times in a row
while a failure was already on screen; the giveaway was that the `ok` count had fallen
behind the test number.

```bash
echo "passed: $(grep -cE '^  ok ' run.log) | FAILED: $(grep -cE '^  x ' run.log) | skipped: $(grep -cE '^  - ' run.log)"
```

A `serial` file turns one failure into a pile of `-` "did not run" - so a sudden jump in the
skipped count is itself a failure signal, not a sign that specs are being skipped by design.

## Two flakes seen under full-suite load, both green in isolation

Recorded 2026-09-11 so the next full run does not re-diagnose them from scratch. Both failed
in one run, passed alone (17/17), then passed again **in place** in a second full run
(458 passed, 0 failed):

- **`stop-then-send-integration.spec.ts:41`** failed with `a new CLI should be spawned; saw: []`
  - an **empty** log array while the turn itself streamed and was not swallowed. That is the
  documented raw-`ws` recorder-attach race (a replay sent during the upgrade can share a TCP
  read with the handshake and be emitted before `record()` attaches), which is load-sensitive
  by construction.
- **`effort-thinking-integration.spec.ts:185`** (thinking toggle persists across reload).
  Serial file, so its failure also produced the run's ten "did not run".

**"Passes on a re-run" is not by itself evidence of a flake** - this repo has two failure
shapes that mislead exactly that way. What settled it was adding evidence a re-run cannot
give: neither spec touches the code that changed, and the session's one plausible mechanism
(a newly added reaper timer that kills idle CLIs) was **proved inert** for the whole run -
`e2e/argus.json` carries `cliIdleTimeoutSec: 0` and `readConfig` merges `DEFAULT_CONFIG`, so
every sweep hit `!(0 > 0)` and returned. Find the mechanism by which your change *could*
have caused it and kill that, rather than re-running until it is green.
