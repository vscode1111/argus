# E2e: guard against a reused wrong-config dev server + flatten the timeout tiers

## Problem

Two separate reliability gaps in the integration e2e run, both making failures harder to
trust:

1. **A reused dev server can silently read/write the wrong settings file.**
   `playwright.config.ts`'s `webServer.reuseExistingServer: true` means a `yarn dev` the user
   already had running gets adopted as the backend instead of Playwright starting its own. If
   that process was launched from a plain shell (no `ARGUS_CONFIG`), it reads and **writes**
   the real `~/.claude/argus.json` instead of `e2e/argus.json`: tests that change settings
   through the UI corrupt the user's real config, and tests that depend on `e2e/argus.json`
   values (`showLogs`, `effort`, `allowedOrigins`, ...) fail against values they never set.
   This presents as several unrelated product bugs, not one environment problem.
2. **The 90s integration timeout tier was too generous to mean anything.** A real CLI turn in
   these tests normally finishes in a few seconds (confirmed by this task's own verification
   run: 108 passed in ~5 min, nothing near 90s). A genuine hang still burned close to 90s
   before being reported, and the blanket "no per-test `test.setTimeout`" rule that came with
   it assumed nothing would ever need more, which stopped being true once the cap dropped.

## Changes made

**Config-mismatch guard (`src/backend/index.ts`, `src/backend/config.ts`, `e2e/global-setup.ts`)**

- `config.ts` exports the existing `CONFIG_PATH` constant (was module-private).
- The shared HTTP server answers `GET /health` with `{ configPath, pid }`, gated to loopback
  (`127.0.0.1` / `::1` / `::ffff:127.0.0.1`) - 403 otherwise, so the path is never disclosed to
  a LAN client.
- `e2e/global-setup.ts` (new, wired via `playwright.config.ts`'s `globalSetup`) fetches
  `/health` before any test runs and compares `configPath` against the resolved
  `e2e/argus.json` (case-insensitive on `win32`, where the drive letter's case is
  launch-dependent). A mismatch throws immediately, naming the offending pid and telling the
  user to `yarn dev:stop` first. An unreachable server is not an error - Playwright's own
  `webServer` start order relative to `globalSetup` is version-dependent, and a
  Playwright-started server always gets the right env via `webServer.env` anyway; only a
  **live** mismatch is fatal.

**Flattened timeouts (`playwright.config.ts`)**

- Removed the `integration` project's `timeout: 90_000` override. Both projects now inherit
  the global `timeout: 30_000`.
- Three tests needed adjustment to fit the tighter budget:
  - `log-autoscroll-integration.spec.ts` - the mid-stream polling loop now has its own 15s
    deadline (`expect(Date.now(), ...).toBeLessThan(deadline)`) so a stream that never ends
    fails on that assertion with a clear message instead of running out the test timeout.
  - `network-access-integration.spec.ts` - `beforeAll` now resets `allowNetworkAccess: true,
    allowedOrigins: ''` before running (previously only snapshotted for restore), so the first
    test's baseline assertion (external origin rejected) can't be broken by a leftover
    `allowedOrigins` entry from an aborted earlier run - that failure mode would otherwise cost
    a full retry-and-diagnose cycle under the tighter budget.
  - `session-browse-during-stream-integration.spec.ts` - its third test (three real CLI turns
    plus two rename round-trips before the assertion even starts) gets an explicit
    `test.setTimeout(60_000)`. This is the one test in the whole suite that doesn't fit 30s;
    verified it actually needs the room (observed 20.9s in the passing run, leaving headroom
    for slower model responses) rather than raising the global cap for everyone to cover one
    test.
  - `openHistoryModal` (same file) also tightened its retry loop (`toPass({timeout: 12_000})`
    with a 4s per-attempt wait, was 30s/10s) - reopening the modal re-fires `listSessions`,
    which recovers a lost round-trip faster than sitting on one long wait.

## Files changed

- `src/backend/config.ts` - export `CONFIG_PATH`
- `src/backend/index.ts` - `GET /health` (loopback-only)
- `e2e/global-setup.ts` - new
- `playwright.config.ts` - `globalSetup` wiring; removed `integration` project's `timeout: 90_000` override
- `e2e/log-autoscroll-integration.spec.ts` - bounded mid-stream poll deadline
- `e2e/network-access-integration.spec.ts` - `beforeAll` resets gate state, not just snapshots it
- `e2e/session-browse-during-stream-integration.spec.ts` - `test.setTimeout(60_000)` on the 3-turn test; tightened `openHistoryModal` retry budget
- `!notes/common/e2e-testing.md`, `CLAUDE.md` - updated timeout tier docs, added the config-guard section

## Decisions

- **Loopback-only `/health`, not a dev-only conditional route.** The endpoint only ever
  discloses a local filesystem path and a pid, gated the same way other local-only concerns
  in this file are reasoned about. Simpler than threading a "test mode" flag through
  `startServer`, and harmless to leave in the daemon/production path.
- **Treat "server unreachable" as success, not failure, in `global-setup.ts`.** The guard's
  only job is to catch a *wrong* server, not to enforce that a server already exists -
  Playwright's own `webServer` supplies the right env when it starts one itself.
- **Per-test `test.setTimeout` allowed again, but only as a justified exception.** The
  previous rule ("never add per-test overrides") was correct under a 90s project timeout,
  where nothing needed one - it wasn't a principle so much as an observation that stopped
  holding once the cap moved to 30s.

## Verification

- `node node_modules/@playwright/test/cli.js test --project=mock` - 170 passed (32.7s),
  confirms `globalSetup` doesn't break the fast tier.
- `node node_modules/@playwright/test/cli.js test --project=integration --no-deps` - 108
  passed, 4 skipped (the known AskUserQuestion/usage-match skips), 0 failed, in 5.1 min -
  faster than the old 7-13 min baseline at the 90s tier, not slower. Full log:
  `scripts/integration-run-1.log`.
- Ran `node scripts/test-clean.js` first; a previous session had left 6 dev-server and 7
  claude-orphan processes running.

## Gotchas

- **Stale processes from an interrupted session look like "everything is broken" if you skip
  the clean step.** `test-clean.js --dry` found 12-14 leftover processes before this run
  (dev servers, orphaned `claude --print` CLIs, a stale Playwright runner) - almost certainly
  from a prior session that ended mid-suite. Always dry-run `test-clean.js` before trusting a
  fresh integration run's results.
- **The old `common/e2e-testing.md` rule against `test.setTimeout` was correct when written
  and became wrong when the project timeout changed underneath it** - a good reminder to
  re-check timeout-adjacent docs whenever the timeout itself changes, not just add a new
  section next to the stale one.

## Remaining work

- Not committed yet.
