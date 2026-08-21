# A send right after a manual stop was swallowed, ending the new turn instantly

Worked on `main` (no ticket), 2026-08-22. User report: "Sometimes session is finished immediately after previous session manual termination" - a turn started right after pressing Stop completed in ~1s with no output.

## Root cause

`handleStop` killed the CLI but left `s.currentProc` pointing at it. `close` arrives a beat later (killProc is a `taskkill` on Windows, the pipe teardown is asynchronous), and **until it does, the dying process still reports `stdin.writable === true`**. A send landing inside that window hit `handleSend`'s first branch:

```ts
if (s.currentProc?.stdin?.writable && !s.cliDone && ...) // -> mid-turn inject
```

so the user's message was written into a pipe nobody reads (`EPIPE`), and the pending `close` of the killed process - still `isActiveProc`, since nothing had detached it - broadcast `done`, ending a turn that had never started. The width of the window is the whole "sometimes": with a ~1.2s gap between stop and send the same sequence spawns normally and answers.

Measured with [scripts/probe.js](scripts/probe.js) (own daemon, private port, throwaway config):

```
8015ms -> stop
8015ms -> send #2
8137ms [log] Mid-turn inject: 107 bytes to stdin
8138ms [log] stdin error (CLI likely crashed): write EPIPE
8139ms [log] claude exited with code 1
8140ms <- done                       # 219ms, zero text chunks
```

The second, quieter half of the same defect: the killed process's buffered stdout and its `close` handler still wrote into the session state that now belonged to the *next* turn - `s.watchdog.state.active = false` ran unconditionally, so a stopped proc disarmed the new turn's watchdog.

## Fix

- **`src/backend/session.ts` (`handleStop`)** - detach before killing, exactly like the `/clear` handler already did: clear `currentProc`/`currentProcKey`, set `cliDone`, `killProc(proc)`, then broadcast `done` directly instead of waiting for the close event to do it. A detached proc can be neither reused nor injected into, and its late `close` is a no-op.
- **`src/backend/cliHandler.ts` (`attachProcHandlers`)** - a `detached()` helper (`s.currentProc !== proc`) now guards stdout, stderr accumulation, and the whole `close` body. The spawn path assigns `s.currentProc` before attaching handlers, and a reused proc keeps the same reference, so nothing legitimate is dropped.
- **`s.userStopped` removed** (`sessionState.ts`, `session.ts`, `cliHandler.ts`): it existed only to let the close handler emit the stop's `done`, which `handleStop` now does itself. Nothing set it any more.

## Tests

- `e2e/stop-then-send-integration.spec.ts` (new): drives a raw WS against the shared `:3001` server in its own temp workspace dir, streams a real turn, stops, and sends again **in the same tick**. Asserts the second turn produces output, is not swallowed as a `user_inject`, spawns a new CLI, and finishes. A browser round trip would add exactly the delay that hides the race, which is why this one is not a UI test.
- Red verified twice: the probe on the pre-fix build swallowed the message (`done=false` after 22s, no output), and answers on the fixed build with a 0ms gap.
- The new spec was run 3x consecutively (green each time) before trusting it, since it exercises a race.
- Full suite after the change - it touches the stop path, which several specs depend on: **329 passed, 3 skipped, 0 failed** (6.2 min, mock + integration).

## Files changed

| Path | What |
|------|------|
| `src/backend/session.ts` | `handleStop` detaches + kills + broadcasts `done`; `userStopped` gone |
| `src/backend/cliHandler.ts` | `detached()` guard on stdout/stderr/close; close body simplified |
| `src/backend/sessionState.ts` | dropped the `userStopped` field |
| `e2e/stop-then-send-integration.spec.ts` | new regression spec |
| `!notes/tasks/stop-then-send-race/scripts/probe.js` | reproduction harness |

## Gotchas

- **The probe's first "green" was a false negative.** After the fix it still reported NO OUTPUT, because it counted the `done` that `handleStop` now broadcasts *immediately* as the second turn's ending. The give-away was in the timestamps: that `done` arrived **before** the turn's own `thinking_start`. Both the probe and the spec now only count a `done` once `thinking_start` for that turn has been seen. This is the same trap as the e2e rule about gating on app-owned state - a signal that exists in both the good and bad case proves nothing about which one you are in.
- **A leftover Vite from the interrupted run made the spec fail for an unrelated reason.** `reuseExistingServer` matches on `:5173` only, so Playwright adopted a half-dead dev server (Vite alive, backend on `:3001` gone) and every attempt to reach the backend failed. `yarn test:clean` fixed it. The spec now polls `/nonce` before connecting, since Playwright's readiness check watches Vite, not the backend - any future spec that talks to `:3001` directly needs the same.
- **One unexplained failure remains unreproduced.** On the first run against a freshly started backend, the "a new CLI should be spawned" assertion failed - no `Spawning claude` **and** no `Reusing claude process` log in the window, yet text chunks arrived and nothing was injected, which the code paths do not obviously allow. Three subsequent runs passed. The artifact was lost to those re-runs (the `test-results/` wipe rule bit again). The assertion now prints the log lines it did see, so a recurrence is diagnosable. Not claimed as fixed.

## Decisions

- **Broadcast `done` from `handleStop` rather than from the close handler.** The old flow made the UI wait for the process to actually die before the turn ended; the new one is immediate, idempotent, and does not depend on a flag surviving until an async event.
- **Guard on identity (`s.currentProc !== proc`), not on a flag.** A flag has to be set correctly at every kill site (`stop`, `/clear`, respawn-on-args-change, watchdog retry, AskUserQuestion); the identity check is automatically right for all of them.

## Remaining work

None for the reported bug. The unexplained cold-start failure above is worth re-checking if it ever shows up again.
