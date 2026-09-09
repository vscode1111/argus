# A 45-minute background task, and nothing on screen moving

| | |
|---|---|
| Status | DONE / verified (23/23 mock specs green, two new, one of them a control) |
| Reported | 2026-09-09, by the user, screenshot plus the transcript that produced it |
| Produced by | Claude Code, model claude-opus-5 |

## Symptom

> And I like that caption but timer is not going on. It stoped on 57s

A CI poller launched with `run_in_background: true` was going to run for up to 45 minutes. The
turn that started it finished in 57s, and the note under it read `1 background task still running`.
Both were correct, and both were frozen, so the screen was indistinguishable from a dead session.

The transcript the user supplied
(`~/.claude/projects/d---Projects-GMTrade/baed4cb6-572e-49b8-9595-424a7d63ce23.jsonl`) corroborates
the complaint rather than just illustrating it:

| Time | Event |
|------|-------|
| 09:50:41 | `Запустить фоновый поллер CI`, `run_in_background: true` |
| 09:50:42 | `Command running in background with ID: b2fon9811` |
| 09:50:57 | turn ends, timer freezes at `57s` |
| 09:57:23 | user types **"Текущий статус CI"** by hand |
| 10:00:35, 10:00:50 | asks again, twice |

The task never reported back in-session at all - there is no `origin.kind === 'task-notification'`
record anywhere in the file - so the frozen state was not a brief gap, it was the whole session.
Asking was the only way to learn whether anything was happening.

## Root cause

Not a bug in any single line; a rule in [../../background-tasks.md](../../background-tasks.md) that
was written deliberately and drawn too wide:

> Static by design - no spinner, no dots, no ticking timer, since Argus cannot tell a build that
> will finish from a browser started for CDP that will not.

That reasoning holds for a **spinner**, which claims progress towards an end nobody can see. It was
applied to a **count-up from a launch that already happened**, which claims nothing about the future.
The two got banned together.

The state layer had already been shaped by that decision: `SessionState.pendingBgTasks` was a
`Set<string>` of ids, so nothing anywhere in the process knew *when* a task started. The elapsed
time was not withheld from the UI - it did not exist.

## Changes made

- `pendingBgTasks` is a `Map<string, number>` (id -> `Date.now()` at `addBgTask`). Every call site
  in `src/` was already Map-compatible (`has`/`delete`/`size`/`clear`); only `.add` changed. That
  audit was too narrow - see Gotchas for where the same field also lives outside `src/`.
- New `oldestBgTaskStart(s)`. **The oldest, not the newest**: it is the one being waited on, and it
  is the only choice that never jumps backwards as tasks come and go.
- `done` carries `backgroundTasksSince` alongside `pendingBackgroundTasks`; reducer stores it as
  `UIMessage.bgTasksSince`; `ChatMessage` passes it down.
- `BackgroundTasksNote` owns a 1s interval **itself**, so one element re-renders per second instead
  of the message list. Renders `· 6m 47s` after the count.
- `channel.ts`: `ChannelMessage` gained both fields and `applyMsg`'s `done` case fills them, so a
  client joining mid-watch replays the same note. It was previously dropping `bgTasksPending`
  entirely, which made a replayed note fall back to "1" regardless of the real count.

## Files changed

| File | Change |
|------|--------|
| `src/backend/sessionState.ts` | `Set<string>` -> `Map<string, number>` |
| `src/backend/cliHandler.ts` | timestamp on insert, `oldestBgTaskStart()`, `done` payload |
| `src/backend/channel.ts` | `ChannelMessage` fields + `applyMsg` mirror |
| `webview/src/types.ts` | `UIMessage.bgTasksSince` |
| `webview/src/reducer.ts` | action field, stored on the committed message |
| `webview/src/components/ChatMessage.tsx` | passes `since` |
| `webview/src/components/BackgroundTasksNote.tsx` + `.module.css` | the interval and the `·` separator |
| `e2e/background-tasks.spec.ts` | two tests |
| `CLAUDE.md`, `!notes/background-tasks.md` | the rule they stated is now the opposite of the code |

## Decisions

**The turn's own timer stays frozen.** The literal request was that the `57s` keep going. It is a
completed measurement of how long the turn took; making it tick would destroy a real fact to answer
a different question, and when the poller finally ended it would report a turn duration that never
happened. The counter went onto the note instead, one line below, and the user was told the
alternative is a two-line change if they meant the other reading.

**Counted from the task's launch, not the turn's end.** They differ by 15s here (09:50:42 vs
09:50:57) and by more whenever a turn keeps working after starting something. Only the launch is the
number a watcher wants.

**No timestamp means no clock**, rather than defaulting to the turn's end or to first render. An
older daemon sends no `backgroundTasksSince`, and a half-hour poller displayed as "3s" is worse than
no number at all. This is the second e2e test, and it is the one that matters: without it, "always
render a clock, starting at zero" passes the ticking test happily.

## Gotchas

**A hand measurement said the fix did not work, and it was the measurement that was wrong.** Reading
widths in the same `page.evaluate` that dispatched the mock messages returned `140px` where the rule
predicts `519px`, and the number was plausible enough (it is the width of a short description) to
look like proof. It was the *previous* injection's row, still on screen: the dispatch is synchronous,
the React re-render is not. `getComputedStyle` a moment later showed `flex: 0 0 auto`,
`max-width: 45%`, `519.297px`. Written up in
[../../common/e2e-testing.md](../../common/e2e-testing.md).

**The existing specs did not need touching.** All 21 of them assert with `toContainText` and none
send `backgroundTasksSince`, so they exercise the no-timestamp path and pass unchanged - which is
also what proves the old-daemon fallback works.

**Changing a state field's type breaks the specs that hand-build that state, and `tsc` cannot see
them.** Three bundle-driving specs (`bg-task-counting`, `synthetic-user-message`,
`task-notification-result`) mimic `SessionState` with an untyped object literal
(`Partial<Record<string, unknown>>`), each carrying `pendingBgTasks: new Set()`. The new
`addBgTask` calls `.set(id, Date.now())`, which `Set` does not have, so the two `bg-task-counting`
tests that reach `addBgTask` failed with a TypeError while the other two specs passed only because
their payloads never touch it. Found by the user running the suite, not by the build: the mimic is
untyped by design (it lives across the frontend/backend tsconfig boundary and stubs half the
interface), so the compiler had nothing to say. When changing any `SessionState` field's *shape*,
grep `e2e/` for the field name; compatible-looking passes from the other mimics are silence, not
evidence.

## Remaining work

None in the code. Not on the user's screen yet: their daemon runs from
`c:\Users\Admin\.vscode\extensions\local.argus-0.0.95\out\backend\daemon.js`, so this needs the
redeploy described in [../../common/backend-restart.md](../../common/backend-restart.md).

The `✻ N` pill in `InputArea` deliberately did not get a clock of its own (see
[../../background-tasks.md](../../background-tasks.md) point 7).
