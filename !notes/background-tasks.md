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

1. **Task tracking**: `pendingBgTasks` Set tracks active background tasks via `system/task_started` and `system/task_updated` events. Probed against a live CLI (2026-09-03): `task_started` fires **once** per task and is never re-emitted for a still-running task on a later turn, and `task_updated` fires **at completion** (0.1s before `task_notification`), not on incremental output - so deleting on it is safe. Scripts in [tasks/bg-task-indicators/scripts/](tasks/bg-task-indicators/scripts/)
2. **Autonomous turn detection**: when meaningful CLI events (`content_block_delta`, `assistant`, `message_start`) arrive while `cliDone === true`, the server resets turn state, sends `thinking_start` to the UI, and re-enables the watchdog. It also sets `autonomousTurn`, which is what marks the resulting turn as the CLI's own rather than the user's. Note the condition only ever matches on `assistant` in practice: with `--include-partial-messages` the other two arrive wrapped in `stream_event`
3. **Pending flag on done**: when `result` arrives with tasks still in `pendingBgTasks`, the `done` event includes `pendingBackgroundTasks: true`

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
4. **Timer**: shown like any other finished turn (the turn really did finish), in the green
   success colour - it describes how the turn ended, not what the tasks are doing
5. **Resolution**: when a later turn completes, every `background_waiting` message is resolved to
   `background_done`, which drops the note and keeps the timer
6. **Sound/notification**: fire normally on the turn that spawned the tasks, and again on the
   task-notification turn when it reports back
