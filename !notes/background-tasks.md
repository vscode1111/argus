# Background Task Support in Argus

## How it works

When Claude runs a Bash tool with `run_in_background: true`, the tool result returns immediately ("Command running in background with ID: ...") and the turn completes. Later, the CLI autonomously starts a new turn to report the result.

### Server (`src/backend/cliHandler.ts`, `src/backend/session.ts`)

> Path updated 2026-08-26: this doc was written against `src/argusServer.ts`, which no longer
> exists; the logic below now lives in `src/backend/`.
>
> **Not every `result` this produces ends the user's turn.** The CLI also answers notifications
> for tasks orphaned by a *previous* CLI process, at `--resume` startup, before the user's
> queued message is dequeued. Which `result` to act on, and why `origin.kind` is not enough to
> tell them apart, is in [common/cli-turn-boundaries.md](common/cli-turn-boundaries.md).

1. **Task tracking**: `pendingBgTasks` Set tracks active background tasks via `system/task_started` and `system/task_updated` events. Probed against a live CLI (2026-09-03): `task_started` fires **once** per task and is never re-emitted for a still-running task on a later turn, and `task_updated` fires **at completion** (0.1s before `task_notification`), not on incremental output - so deleting on it is safe. Scripts in [tasks/bg-task-indicators/scripts/](tasks/bg-task-indicators/scripts/). Every real change to the set broadcasts `bgTasks {count}` (2026-09-07), and `getBgTasks` answers one client that just connected; the set is reaped when a **new** CLI process is spawned, not on every send, because a task only becomes unreportable when the process that owned it dies
2. **Autonomous turn detection**: when meaningful CLI events (`content_block_delta`, `assistant`, `message_start`) arrive while `cliDone === true`, the server resets turn state, sends `thinking_start` to the UI, and re-enables the watchdog. It also sets `autonomousTurn`, which is what marks the resulting turn as the CLI's own rather than the user's. Note the condition only ever matches on `assistant` in practice: with `--include-partial-messages` the other two arrive wrapped in `stream_event`
3. **Pending flag on done**: when `result` arrives with tasks still in `pendingBgTasks`, the `done` event includes `pendingBackgroundTasks: true`
4. **The live announcement is `system`/`task_notification`, and it is the only one.** The CLI also writes itself a `<task-notification>` user-role prompt to start the turn, but **that record never reaches stdout** - it exists only in the transcript. Probed 2026-09-08 ([tasks/bg-turn-cause-marker/scripts/probe-notification-event.js](tasks/bg-turn-cause-marker/scripts/probe-notification-event.js)): a full cycle emitted three `user` events, all `tool_result`, none carrying `origin`, and the only line mentioning `task-notification` in 75 lines of stdout was the `result`. The `system` event carries everything the prompt does (`task_id`, `tool_use_id`, `output_file`, `status`, `summary`), so `handleSystemEvent` broadcasts `bg_notice` from it, beside the `tool_end` it already sends to fill in the original Bash block's result. Building this on the user event instead is dead code that still passes a transcript-derived test: [tasks/bg-turn-cause-marker/notes.md](tasks/bg-turn-cause-marker/notes.md)

### UI (`webview/src/App.tsx`, types, components)

> Rewritten 2026-08-27. Points 2-6 used to describe a synthetic streaming state that kept the
> app "busy" until some later turn ended; a task that never ends left it busy forever. See
> [tasks/background-waiting-forever/notes.md](tasks/background-waiting-forever/notes.md).

1. **Outcome**: `background_waiting` added to the `Outcome` type. It means "this turn finished
   and its tasks outlived it", not "still busy"
2. **Done with pending tasks**: reducer commits the assistant message exactly like any other
   turn (`streaming: null`, `isStreaming: false`, `turnCompletions + 1`); the only difference is
   `outcome: 'background_waiting'` plus `bgTasksPending` on the message
3. **Passive note**: `ChatMessage` renders `BackgroundTasksNote` under such a message ("3
   background tasks still running"). Static by design - no spinner, no dots, no ticking timer,
   since Argus cannot tell a build that will finish from a browser started for CDP that will not.
   **No denominator**: the old "2 of 3" form reported a total counted since the last per-send
   reset, which produced "2 of 9" on a turn that launched two. See
   [tasks/bg-task-indicators/notes.md](tasks/bg-task-indicators/notes.md)
4. **Timer**: shown like any other finished turn (the turn really did finish), but **not** in
   the success green. Amended 2026-09-08: green is the claim "finished, nothing outstanding",
   which a turn that left a watcher running cannot make, so `background_waiting` and
   `background_done` both render the neutral `msg.responseTime`. The earlier reading here
   ("it describes how the turn ended, not what the tasks are doing") is defensible in
   isolation and failed in aggregate: an hour-long watch reads back as a wall of identical
   green completions, which is what got reported twice
4a. **Cause marker**: a turn started by a notification opens with `BackgroundNoticeBlock`
   (`bg_notice`), a muted line carrying the CLI's own summary plus an `output` link. Without
   it the turn has no visible cause at all, since the prompt behind it is hidden - a second
   answer simply appears, works, and finishes. Live the marker rides the `system` event
   (point 4 of the server section); on replay it is the first block of the turn, parsed from
   the prompt. It arrives **before** `thinking_start`, so `AppState.pendingNotice` holds it
   until the turn opens, `channel.applyMsg` mirrors that for late joiners, and a user message
   clears it (some notifications get an empty turn and the marker must not open the next real
   one). See [tasks/bg-turn-cause-marker/notes.md](tasks/bg-turn-cause-marker/notes.md)
5. **Resolution**: when a later turn completes, every `background_waiting` message is resolved to
   `background_done`, which drops the note and keeps the timer
6. **Sound/notification**: fire on the turn that spawned the tasks, and on the **last**
   task-notification turn, but not on the ones in between. Amended 2026-09-07: they used to
   fire on all of them, a ding and an OS toast every few minutes throughout a watch (156 such
   turns in one reported session). `done` carries `autonomous: true` when `s.autonomousTurn`
   is set, the message records it, and `App.tsx` suppresses the alerts when that turn also
   leaves tasks pending - i.e. when another turn is still coming. A turn that leaves nothing
   pending ends the chain (nothing can wake the CLI again), so it rings: that is the "CI is
   green, all done" report, and the "your build finished" notification on an idle session.
   The turn always completes; only the claim on attention is withheld. See
   [tasks/bg-turn-completion-noise/notes.md](tasks/bg-turn-completion-noise/notes.md)
7. **Live count**: the `✻ N` pill in `InputArea` (`data-testid="bg-tasks-pill"`) is the durable
   home for "how many are running right now". The note at point 3 reports what one *finished*
   turn left behind and is stripped from every earlier message by point 5, so in a watch session
   made of notification turns it appears nowhere. Static for the same reason the note is
