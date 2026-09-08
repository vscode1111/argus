# Repeated "finished" turns during a background-task watch

**Status:** fixed 2026-09-07, not committed. Mock suite green (278/278), each of
the four changes verified red. The literal ask ("do not finish the turn") was
*not* implemented; see the reasoning below and what was done instead.

| Produced by | Claude Code, model claude-opus-5, investigation and fix |
|---|---|

Reported with a screenshot of five short green timers in a row (`1m 14s`, `16s`,
`18s`, `14s`, `17s`) and the words: "During long session with background tasks I
see regular finished of sessions which processed after several seconds. It is
better to show amount of bg process and don't finish session until all bg
finished or some external signal that real CLI was finished".

Source transcript:
`C:\Users\Admin\.claude\projects\d---Projects-GMTrade\a519d7b5-275e-4622-b156-d3f6d0360e7b.jsonl`

## The timers are correct. That is the whole point.

`scripts/turn-timeline.js` over the screenshot window (UTC, local is UTC+3):

| turn | start | end | dur | gap before | screenshot timer |
|---|---|---|---|---|---|
| user send "Да, следи" | 13:26:48 | | | | |
| 1 | 13:26:54 | 13:28:02 | 68.7s | 5.8s | `1m 14s (16:28:03)` |
| notification | 13:31:59 | | | 236.1s | |
| 2 | 13:32:03 | 13:32:20 | 17.0s | 5.0s | `16s (16:32:21)` |
| notification | 13:36:16 | | | 235.8s | |
| 3 | 13:36:20 | 13:36:38 | 18.1s | 4.1s | `18s (16:36:40)` |
| notification | 13:41:35 | | | 296.2s | |
| 4 | 13:41:39 | 13:41:53 | 14.1s | 4.6s | `14s (16:41:54)` |
| notification | 13:46:49 | | | 296.0s | |
| 5 | 13:46:55 | 13:47:12 | 17.1s | 5.3s | `17s (16:47:13)` |

Every wall-clock end matches its timer to the second. The agent's own waits
(`while [ $i -lt 4 ]; do sleep 59; done`) run with `run_in_background: true`, so
the tool returns at once, the turn genuinely ends after ~16s, and four to five
minutes later the CLI wakes itself with a `<task-notification>` prompt and runs
another ~16s turn. Argus is reporting reality; what the user reads as "the
session keeps finishing early" is one job spread over many short turns.

**Scale:** 156 `<task-notification>` turns in this single session.

## What the report is really about, and it is not the timer

Three consequences, in descending severity.

### 1. A completion sound and a Windows toast on every one of them

`webview/src/App.tsx:150` fires both on each `turnCompletions` increment, and
`reducer.ts:201` increments unconditionally in the `done` case; only `stopped` is
excluded. The user's own `C:\Users\Admin\.claude\argus.json` has
`soundOnComplete: true` and `notifyOnComplete: true`. So this session pinged him
up to 156 times, each toast titled with the project and bodied with the last real
user message ("Да, следи").

This is the direct cost of the [background-waiting-forever](../background-waiting-forever/notes.md)
fix (2026-08-27), which made such turns complete normally *precisely so* the
sound and notification would stop being suppressed. Both directions are
defensible; nobody weighed the polling session, where the same signal fires every
four minutes for a job the user already knows about.

### 2. The pending count is visible on exactly one message, ever

`reducer.ts:184` rewrites **every** `background_waiting` message to
`background_done` on the next `done`, and `ChatMessage.tsx:196` renders
`BackgroundTasksNote` only for `background_waiting`. So the note lives on the
newest message and vanishes the moment the next notification turn lands. In the
screenshot's history it is nowhere, which is exactly the "show amount of bg
process" ask: there is no durable place that says how many tasks are running.

### 3. Replay renders 42 raw `<task-notification>` blobs as user bubbles

Measured, not inferred, by running the compiled `loadSession` against this
transcript:

```
replayed messages: 220 | user bubbles: 115 | raw <task-notification> bubbles: 42
```

`isCliAuthoredUser` (`src/backend/sessions.ts:483`) tests only `isMeta` and
`isVisibleInTranscriptOnly`; a notification prompt carries neither. Its actual
mark is `origin: {"kind":"task-notification"}`, the same field
`handleResult` already trusts at `cliHandler.ts:262`. So opening this session
from Session History shows 42 XML messages the user never typed.

Live it does not happen, but only by accident: the notification `user` event
arrives while `cliDone` is still true, the recovery branch at
`cliHandler.ts:32` raises `thinking_start` only on an assistant/delta event, so
the `user_inject` hits `reducer.ts:104` with `streaming === null` and is
dropped. Anything that later raises the spinner earlier would surface all 156.
(**Superseded, see the block at the end of this file:** there is no such event on
the stream.)

## Why "don't finish until all bg finished" cannot be taken literally

It is the state that [background-waiting-forever](../background-waiting-forever/notes.md)
deleted, and the reason stands: a task that never ends (Chrome held open for CDP,
a dev server, a watcher) is indistinguishable from a 40-minute build, so the
spinner ran forever and Stop stayed armed on an idle session. Upstream agrees;
the CLI ends the turn and keeps `/tasks` as a passive list.

The user's own escape hatch, "or some external signal that real CLI was
finished", has no reliable referent either: the CLI process stays alive across
these turns by design, so "the real CLI finished" is not an event Argus receives.

## What was done

Split the ask by *who started the turn*, which Argus already knew
(`s.autonomousTurn`, `origin.kind`), rather than by whether tasks are pending.
The turn still finishes; only the claim on the user's attention is withheld.

### 1. A turn in the middle of an autonomous chain finishes silently

`handleResult` adds `autonomous: true` to `done` when `s.autonomousTurn` is set;
the reducer records it on the message; `App.tsx` skips the sound and the toast
for it, alongside the existing `stopped` exemption. `turnCompletions` still
increments, so nothing else in the app changes meaning. A mid-turn inject clears
`autonomousTurn` (that branch returns before the reset block that normally does),
because a turn the user has spoken into is theirs and must ring.

**Silencing every autonomous turn was the first shape of this and it was wrong.**
The final turn of a watch - "CI is green, all done" - is a task-notification turn
like the other 155, so a blanket rule suppresses precisely the ping the user sat
through the watch for. The discriminator is not who started the turn but whether
another one is coming: an autonomous turn that leaves **nothing** pending is the
end of the chain, since no task remains to wake the CLI, so it is the last output
the user will get. `midChain = autonomous && (bgTasksPending ?? 0) > 0`, and only
that is silenced. The same rule gives the right answer for a lone background task
finishing on an idle session ("your build is done"): zero pending, so it rings.

### 2. A live pending count, in one durable place

New `bgTasks {count}` frame, broadcast from `cliHandler` on every real change to
the pending set (`addBgTask`/`removeBgTask` skip no-op mutations) and answered
per client via `getBgTasks` on mount and on every reconnect, mirroring
`getActiveSessions`. Rendered by `InputArea` as `✻ N` beside the context pill
(`data-testid="bg-tasks-pill"`), static, hidden at zero. `done` carries the same
number, so an old daemon that predates the pushes still fills it in.

Gated in `SESSION_STREAM_EVENTS`: it counts the entry's tasks, not those of the
session a browsing client has on screen.

### 3. The per-send reset became a per-spawn reset

`handleSend` cleared `pendingBgTasks` on **every** send, which was tolerable for
a footnote and wrong for a live indicator: typing anything mid-watch zeroed it,
and nothing could restore it (`task_started` fires once per task and is never
re-emitted). It now clears only when a *new* CLI process is spawned. Every
orphan case the old comment named (hard kill, kill-all, daemon respawn) destroys
the process, so all three are still covered, and a reused process keeps the
tasks it genuinely owns.

### 4. Replay no longer shows notification prompts as user bubbles

`isCliAuthoredUser` now also tests `origin.kind === 'task-notification'`, and
the live `handleUserEvent` tests it too, so the live path is safe by rule rather
than by the accident described above.

That fix exposed a second defect in the same place: consecutive assistant
records merge until real user input, so hiding the prompt merged the entire
watch into one enormous message. `isTurnStartingPrompt` therefore calls
`finalize()` on a notification prompt: hidden, but still a turn boundary. The
distinction is load-bearing, because the *other* CLI-authored records (the image
note) land inside a turn, where finalizing would split one answer in two.

## What was deliberately not done

The literal "don't finish the session until all bg finished". It is the state
[background-waiting-forever](../background-waiting-forever/notes.md) deleted, and
the reason stands: a task that never ends (Chrome held open for CDP, a dev
server, a watcher) is indistinguishable from a 40-minute build, so the spinner
ran forever and Stop stayed armed on an idle session. Upstream ends the turn too
and keeps `/tasks` as a passive list. The "external signal that the real CLI
finished" has no referent either: the CLI process stays alive across these turns
by design.

## Gotchas

Wrong turns taken this session, each with the signal that made it look right.

**"The timers must be wrong."** Five short timers in a row under a session that had
visibly been working for twenty minutes reads as a measurement bug, and the report was
phrased that way ("finished ... which processed after several seconds"). The timeline
killed it in one pass: every timer matches its turn to the second, five for five. The
defect was a layer up - what the app *does* with a correct turn ending - and starting
from the transcript rather than from the reducer is what made that visible in minutes.

**Silencing every autonomous turn.** `s.autonomousTurn` already existed, it is exactly
"the user did not start this", and the ask was "stop telling me it is finished", so it
looked like a one-line fix that needed no thought. Walking the real scenario to its *end*
killed it: the final turn of a watch ("CI is green, all done") is a task-notification turn
like the other 155, so the rule suppresses precisely the ping the watch existed for. The
survivor gates on whether another turn is coming (`bgTasksPending > 0`), not on who
started this one. Caught by re-reading my own diff after the tests were green, which is
the only reason it did not ship.

**A `node -e` replacement that silently applied nothing**, making a verify-red run pass
while reverting nothing. Cause: source here is CRLF, the anchor ended in `\n`. The script
reported `patched: false` and it was read as a run to retry rather than as a finding -
the honest reading is that a green suite proved nothing that round. Now in
[../../common/development.md](../../common/development.md).

**Editing `src/backend/session.ts` while the integration suite was running.** `dev.js`
watches that folder, so the backend restarted under ~65 tests still to go. The run came
back green, which is the trap: the hazard is real and non-deterministic, so surviving it
teaches the wrong lesson. Now in [../../common/e2e-testing.md](../../common/e2e-testing.md).

## Files changed

| file | change |
|---|---|
| `src/backend/cliHandler.ts` | `broadcastBgTasks`/`addBgTask`/`removeBgTask`; `autonomous` on `done`; notification prompts treated as synthetic |
| `src/backend/session.ts` | `getBgTasks` handler; broadcast on `/clear` and `newSession`; per-spawn instead of per-send reset |
| `src/backend/channel.ts` | `bgTasks` added to `SESSION_STREAM_EVENTS` |
| `src/backend/sessions.ts` | `origin.kind` in `isCliAuthoredUser`; `isTurnStartingPrompt` finalizes the turn |
| `webview/src/{types,reducer,App}.tsx/.ts` | `autonomous` on the message, `bgTasks` state + action, silent autonomous completion, `getBgTasks` sync |
| `webview/src/components/InputArea.tsx` + `.module.css` | the `✻ N` pill |
| `webview/index.html` | `getBgTasks` in `MOCK_SUPPRESSED` |
| `e2e/{sound-complete,background-tasks,synthetic-user-message}.spec.ts` | 7 new tests |

## Verification

- `yarn test:e2e` (both projects, the canonical run): **413 passed, 6 skipped,
  0 failed**, 10.2m, exit 0. That is 279 mock + 134 integration, matching the
  two separate runs exactly. The 6 skips are the API-dependent usage-indicator
  cases, which skip on 429 by design.
- `e2e/argus.json` restored afterwards (integration writes runtime data into it);
  `node scripts/test-clean.js --dry` reports nothing left running.
- Verified red, one revert at a time, restoring after each:
  - drop the autonomous exemption -> both sound tests fail (the control fails on
    its *first* assertion, i.e. the autonomous turn did ring).
  - widen it to silence every autonomous turn -> "the last autonomous turn, with
    nothing left pending, does ring" fails, which is the case that made the
    blanket rule wrong.
  - `isCliAuthoredUser` -> `return false` -> the replay test fails, and the
    other four in that spec stay green, so the widening is scoped.
  - drop `bgTasks: action.pendingBackgroundTasks ?? 0` -> "a turn that ends with
    no tasks clears the pill" fails, the two push-driven pill tests stay green.
- `yarn compile` clean; `webview` tsc has only the pre-existing
  `SyntaxHighlighter` JSX error in `FileViewerModal.tsx`.

## Still open

- The count undercounts a task that outlived the process that started it, e.g.
  after a daemon respawn mid-watch. Reconciling against the CLI's own `/tasks`
  set is the real fix and needs a probe.
- A never-ending task now keeps the pill at 1 for as long as the process lives,
  which is true but has no "stop it" control. The CLI has `KillShell`.

## Scripts

| script | what it does |
|---|---|
| `scripts/turn-timeline.js` | turn boundaries, real vs autonomous sends, bg launches, gaps |

## Superseded

- **Was:** the notification prompt reaches Argus live as a `user` event, and nothing rendered
  it "only by accident" because that event lands while `cliDone` is still true; raising the
  spinner earlier would have surfaced all 156 as bubbles.
- **Actually:** the stream carries no such event. Three `user` events in a full
  background-task cycle, all `tool_result`, none with `origin`. The record exists only in the
  transcript, which is why the replay half of fix 4 was real and the live half was not.
- **Why it was wrong:** the payload was taken from a transcript record and assumed to hold
  for stdout, and the spec written for it reused that same payload, so a dead branch had a
  passing test. The predicted symptom (no bubbles) matched the observed one, which made the
  wrong mechanism feel confirmed.
- **Corrected by:** [bg-turn-cause-marker](../bg-turn-cause-marker/notes.md)
