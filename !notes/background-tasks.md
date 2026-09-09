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

1. **Task tracking**: `pendingBgTasks` (a `Map<string, number>` since 2026-09-09, id -> `Date.now()` at insert; it was a `Set<string>` until the note needed to say *how long* a task had been running, not merely that it was) tracks active background tasks via `system/task_started` and `system/task_updated` events. **`task_started` is not a background-task signal: the CLI raises it for every Bash tool call.** Measured 2026-09-08 with a run whose only command was a plain `echo scub-hello` with no `run_in_background`, which produced `task_started` and, two seconds later, `task_notification` ([tasks/bg-turn-cause-marker/scripts/probe-foreground-bash.js](tasks/bg-turn-cause-marker/scripts/probe-foreground-bash.js)). Counting it made the `✻ N` pill blink on and off for every command the agent ran (reported as "появляется и исчезает"; a probe run with one real background task and three foreground `echo`s produced the sequence 1 → 2 → 1 → 2 → 1). Membership is therefore gated by two discriminators, and both are needed: `run_in_background` on the tool input, which is what the model asked for, and `Command running in background with ID: <task-id>` in the tool result, which is what the CLI did. Only the second catches a command the CLI backgrounds on its own, and those are real background tasks: one such command in a reported session had no `run_in_background`, came back with that exact string, and its notification arrived five minutes later and woke an autonomous turn. The id inside the string is the same `task_id` the system events carry, verified on a probe and on a transcript, so both paths feed one set. Probed against a live CLI (2026-09-03): `task_started` fires **once** per task and is never re-emitted for a still-running task on a later turn, and `task_updated` fires **at completion** (0.1s before `task_notification`), not on incremental output - so deleting on it is safe. Scripts in [tasks/bg-task-indicators/scripts/](tasks/bg-task-indicators/scripts/). Every real change to the set broadcasts `bgTasks {count}` (2026-09-07), and `getBgTasks` answers one client that just connected; the set is reaped when a **new** CLI process is spawned, not on every send, because a task only becomes unreportable when the process that owned it dies
2. **Autonomous turn detection**: when meaningful CLI events (`content_block_delta`, `assistant`, `message_start`) arrive while `cliDone === true`, the server resets turn state, sends `thinking_start` to the UI, and re-enables the watchdog. It also sets `autonomousTurn`, which is what marks the resulting turn as the CLI's own rather than the user's. Note the condition only ever matches on `assistant` in practice: with `--include-partial-messages` the other two arrive wrapped in `stream_event`
3. **Pending flag on done**: when `result` arrives with tasks still in `pendingBgTasks`, the `done` event includes `pendingBackgroundTasks: true`
3a. **The cause marker is raised only while the CLI is idle** (`s.cliDone`), because that is when the notification is about to wake a turn nobody asked for. A task finishing *during* a turn is folded into the running one, which already has a visible cause. The gate is deliberately `cliDone` rather than "was this a background task": every Bash call raises this event, so an ungated marker announced `echo one` / `echo two` / `echo three`, while gating on the background test would drop the marker for any task the two discriminators failed to classify, which is precisely the turn that appears out of nowhere
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
   background tasks still running · 12m 4s"). No spinner and no dots, since Argus cannot tell a
   build that will finish from a browser started for CDP that will not.
   **No denominator**: the old "2 of 3" form reported a total counted since the last per-send
   reset, which produced "2 of 9" on a turn that launched two. See
   [tasks/bg-task-indicators/notes.md](tasks/bg-task-indicators/notes.md)
3b. **Elapsed time is the deliberate exception to point 3, added 2026-09-09.** "No ticking timer"
   was one ban covering two different things: a spinner claims progress towards an end Argus cannot
   see, while a count-up from a launch that already happened claims nothing about the future. On a
   45-minute CI poller the old wording left the whole screen frozen - the reported session has the
   user typing "текущий статус CI" by hand six minutes in. The clock counts from the **task's
   launch**, not the turn's end (`done` carries `backgroundTasksSince` = `oldestBgTaskStart(s)`;
   the oldest is the one being waited on and the only choice that cannot jump backwards as tasks
   come and go), the reducer stores it as `UIMessage.bgTasksSince`, and the component owns its own
   1s interval so one element re-renders per second rather than the message list. No timestamp
   means **no clock at all**, because an older daemon sends none and a half-hour poller reported as
   "3s" is worse than no number. See [tasks/bg-task-elapsed-timer/notes.md](tasks/bg-task-elapsed-timer/notes.md)
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
   made of notification turns it appears nowhere. The pill stays a bare count with no clock of its
   own: it answers "how many", the note beside the turn answers "for how long" (point 3b), and two
   independent timers on one screen would only invite the reader to reconcile them.
