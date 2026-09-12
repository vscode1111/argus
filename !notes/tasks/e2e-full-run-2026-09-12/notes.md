# Full `yarn test:e2e` run, 2026-09-12

| | |
|---|---|
| Produced by | Claude Code, model claude-opus-5, user request "check yarn test:e2e" |
| Tree | `main`, working tree dirty (ask-submit-kills-daemon work: daemon.ts, session.ts, daemonHelpers.ts, ToolCall.tsx, CliProcessesModal.tsx) |

## Result

```
454 passed  ·  2 failed  ·  6 skipped  ·  10 did not run   (exit 1)
mock project: 333/333 green
```

Wall time ~150 min for the whole invocation (Playwright's own figure, 8.0m, counts only
the last project's worker time).

Raw log and Playwright artifacts: `artifacts/` in this folder (copied out **before** the
re-runs, since Playwright wipes `test-results/` at the start of every run, even a
single-spec one).

## Failure 1 - `effort-thinking-integration.spec.ts:185` (flaky, not reproduced)

"clicking thinking toggle in slash menu persists to config", `expect(afterReloadOn).toBe(!initialOn)`
got `true` where `false` was wanted: the toggle flipped visually (the 8s poll before it
passed), but after the reload it read as the old value.

- Re-run of the whole file alone: **16/16 passed in 30.6s**, including this test.
- The 10 "did not run" are the rest of this serial file, all green in that re-run.
- Not from the working tree: the diff touches `session.ts` only in `buildAskFollowUp`
  (the AskUserQuestion follow-up builder), and `daemon.ts`, which the e2e backend does not
  use - the shared `:3001` server is `server/index.ts`.

Mechanism **not** established. One candidate was checked and killed: `writeConfig` updates
`cachedConfig` without touching `cachedMtime`, but that errs toward re-reading from disk,
so it cannot serve a stale value.

It had already failed this way on 2026-09-11, so this is the **second** sighting and it is now
a standing flake rather than a one-off - recorded in
[common/e2e-testing.md](../../common/e2e-testing.md) ("Two flakes seen under full-suite load")
so the next full run does not re-derive it.

## Failure 2 - `usage-indicator-integration.spec.ts:110` (test bug, fixed)

"a modal fetch becomes the snapshot every other client reads", bare
`Test timeout of 30000ms exceeded`.

The tell is an asymmetry inside the same run: its two siblings (`:153`, `:224`) skipped
correctly on "live usage API unavailable", so the API was down for all three, yet only this
one hung instead of reaching its own `test.skip`. Reaching that skip needs **both** frames of
the two-phase reply, so the hang is about frame delivery, not about the API.

### The defect (demonstrated)

`waitForFrame` attached its `message` listener *inside* the promise, so nothing was listening
between one wait resolving and the next being made, and two frames sharing a TCP read cost the
second one. The general rule, the `session.ts:399-405` mechanism that lets the server write
both in one tick, and the two consequences for the helper (consume the buffer; a per-call
listener is the bug even with no replay involved) are written up once in
[common/e2e-testing.md](../../common/e2e-testing.md) -> "The upgrade is not the only place two
frames share a read". Only the evidence from this run is kept below.

`scripts/probe-frame-coalesce.js` shows the loss and the fix against a bare `ws` server (no
Argus), old helper vs new, with a 50ms-gap control standing in for a cold fetch:

```
old helper (per-call listener):
  back-to-back (phase 2 needs no work): HUNG -> no accountUsage frame within 2000ms
  50ms gap     (cold usage fetch)     : reached the skip check, windows=[]
new helper (buffered from construction):
  back-to-back (phase 2 needs no work): reached the skip check, windows=[]
  50ms gap     (cold usage fetch)     : reached the skip check, windows=[]
```

### What is NOT established

The end-to-end failure was **not** reproduced on demand. A red control - the pre-fix spec,
`--repeat-each=3`, warm server - passed every iteration. Coalescing depends on whether the OS
actually merges the two writes into one read, so it is a hazard that fires occasionally, which
matches one failure in a 472-test run. So: the defect is real and sufficient to produce exactly
this signature, but "this is what killed run 451" stays a hypothesis. A slow `claude auth
status` spawn (>30s under load) remains conceivable; nothing in the run supports it, and the
sibling test that spawns a whole daemon ran in 2.7s right afterwards.

Note this also undermines the *earlier* diagnosis recorded in the helper's own comment: the
`no accountUsage frame within 20000ms` it blames on a saturated box is equally well explained
by the dropped frame, so the 20s -> 45s raise it justified was probably treating the wrong cause.

The product side is correct throughout - the server sends both frames and the request/reply
invariant holds.

### Fix (applied)

- Frames are buffered from construction (`bufferFrames`, one listener per socket, attached in
  both `openClient` and the daemon describe's `openWs`); `waitForFrame` **consumes** the first
  match off that queue. Consuming matters: the two-phase reply is two waits for the same type,
  and a non-consuming search hands phase 1 back twice.
- Cap lowered `45_000` -> `25_000`. Above the project's 30s test timeout it was dead code -
  Playwright killed the test first, which is why the failure reported a bare
  `Test timeout of 30000ms exceeded` instead of naming the missing frame. No `test.setTimeout`
  added: with the real cause removed, speculative headroom would only re-hide the diagnostic.

Verified: `--repeat-each=3` over the whole file, 6 passed / 9 skipped, no hang; iterations 2
and 3 run against a warm usage state, which is the coalescing-prone condition.

## Housekeeping

- `e2e/argus.json` picked up `cliIdleTimeoutSec: 0` from the run (DEFAULT_CONFIG merge
  written back); reverted with `git checkout --`.
- `node scripts/test-clean.js --dry` reports nothing left running.
