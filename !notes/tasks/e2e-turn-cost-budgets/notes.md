# Integration specs budgeted for turns that no longer exist

| | |
|---|---|
| Reported | 2026-09-06, as a stream of unrelated-looking e2e failures pasted one at a time |
| Produced by | Claude Code, model claude-opus-5 |
| Status | Seven spec files rebudgeted and verified green. The systemic decision is still open |

## Problem

A run of `yarn test:e2e` failed one or two integration tests, a different pair each time.
Every failure looked like a separate bug and none of them was: they were all
`Test timeout … exceeded` while waiting for a real CLI turn, and **not one failed on the
assertion the test exists for**.

The specs were budgeted when a turn here cost a few seconds. That stopped being true.

## Root cause

A **fresh** session in this workspace (no `--resume` in the spawn line) starts at
**77,346 input tokens** - this repo's `CLAUDE.md` is 193KB, roughly 48k tokens, and the CLI
system prompt and memory carry the rest. The context pill reads 39% before anything is typed.

From the debug log of a real failure (`artifacts/token-spending-failure/error-context.md`),
for the prompt `Reply with just the single word "yes"`:

```
12:45:03.942  Spawning claude …                      fresh session, no --resume
12:45:03.958  stdin: 119 bytes
12:45:06.852  event: system {"subtype":"init"}       +2.9s   CLI startup
              (nothing)
12:45:23.113  event: rate_limit_event                +16.3s  waiting on the API
12:45:24.424  stream_event … "text_delta":"yes"      first token, 20.5s total
```

Argus does nothing in the 17.6s gap. Against a flat 30s test budget that also pays for the
page load and a "New chat" click, whichever test drew the slowest latency died.

`!notes/common/e2e-testing.md:8` still justifies the flat 30s with "a real CLI turn in these
tests normally finishes in a few seconds". That premise expired as `CLAUDE.md` grew.

## Three budgets can bind, and raising the wrong one changes nothing

This is the reusable part and it lives in
[common/e2e-testing.md](../../common/e2e-testing.md) (timeout section):

1. the **test** timeout (flat 30s) - what a multi-turn test runs out of;
2. an **assertion** cap below a turn's cost - fails on its own however generous the test budget is;
3. a **hand-rolled deadline in the test body** - which no config change can reach.

Variant 3 was the one worth finding. `log-autoscroll` polls
`while (stopBtn.count() > 0)` against `Date.now() + 15_000` and failed **by 90ms**. Grepping
`Date.now() +` for the same shape then explained an earlier unexplained failure:
`usage-indicator`'s `waitForFrame` defaults to 20s, which is exactly the
`no accountUsage frame within 20000ms` it died on in a full run and passed alone.

## Changes made

All test-only. No product code was touched by this work.

| File | Change |
|---|---|
| `e2e/token-spending-integration.spec.ts` | file-level `test.setTimeout(90_000)` (its assertions already asked 90s) |
| `e2e/new-chat-integration.spec.ts` | `test.setTimeout(90_000)` - two whole turns in one test |
| `e2e/session-browse-during-stream-integration.spec.ts` | `sendAndWait` cap 20s -> 45s; the `modal green highlight` test 30s -> 90s |
| `e2e/send-while-streaming-integration.spec.ts` | describe-level `test.setTimeout(90_000)` |
| `e2e/log-autoscroll-integration.spec.ts` | `test.setTimeout(90_000)`, hand-rolled deadline 15s -> 60s |
| `e2e/usage-indicator-integration.spec.ts` | `waitForFrame` default 20s -> 45s |

Verified after each change: token-spending 4 passed, new-chat passed, session-browse 3 passed,
send-while-streaming 2 passed (1.3m), log-autoscroll 1 passed (11.3s), usage-indicator +
effort-thinking 21 passed (55.4s).

Two full-suite runs during the work: **398 passed / 3 failed** (8.8m) and **396 passed /
1 failed** (8.3m). The full suite has **not** been re-run since the last two fixes, so
"green" is expected but unproven.

## Gotchas

- **Do not debug the test named in the report.** It is whichever one drew the slowest
  latency. Two consecutive runs of the same file killed two different tests.
- **Read the page snapshot in `error-context.md` before touching anything.** In the
  `new-chat` failure the reply on screen was `NO MEMORY` with the token absent - exactly what
  the test asserts. The feature worked and only the clock ran out. That is the cheapest proof
  that a failure is budget rather than logic.
- **Measure the test alone.** `modal green highlight` runs in **12.4s** in isolation and blew
  past 60s inside its file. The cause is in the file: `startStreaming` returns as soon as Stop
  appears and never waits, so every test using it leaves a live CLI process for its neighbours
  to compete with.
- **A serial file multiplies one failure.** `effort-thinking` and `usage-indicator` are
  `test.describe.configure({mode:'serial'})`, so a single failure took 10 tests with it as
  "did not run". Both passed in isolation (16/16 and 21/21).
- **`no accountUsage frame` is not a turn timeout.** Phase 1 of that reply waits on a
  `claude auth status` subprocess, which is what a box carrying ~70 node processes is slowest
  to spawn - the neighbourhood of the `spawn UNKNOWN` failure already in CLAUDE.md.
- **Clean before a suite run.** `yarn test:e2e` does **not** auto-clean. A dry run before the
  second suite found a stale playwright-runner plus four dev-server processes left by the
  first; `yarn test:clean` protects the real daemon's subtree, verified by checking its pid
  after.
- Wrong turn taken: after the first two fixes I assumed the remaining failures were the same
  binding constraint and would fall to the same lever. Variant 3 (the hand-rolled deadline)
  disproved that, and it was only found by reading the failing line rather than the summary.

## Remaining work

- **Decide the systemic lever** (open, needs the user): raise the `integration` project
  timeout to 60s once in `playwright.config.ts` instead of per-spec overrides. Roughly seven
  specs are still on the old assumption (`session-history`,
  `session-history-line-count`, `chat`, `image-recognize`, `session-deep-link`,
  `session-info`, and `effort-thinking`'s neighbours). This reverses a documented decision,
  so it was not done unasked. Note it would **not** reach variant 3.
- **The durable fix is cost, not clock.** 193KB of `CLAUDE.md` is what puts every turn at 77k
  input tokens. Trimming it speeds up every integration turn and every real Argus turn, and
  lowers token spend on every message.
- Re-run the full suite once to confirm green after the last two fixes.
