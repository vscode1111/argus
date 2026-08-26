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

1. **Task tracking**: `pendingBgTasks` Set tracks active background tasks via `system/task_started` and `system/task_updated` events
2. **Autonomous turn detection**: when meaningful CLI events (`content_block_delta`, `assistant`, `message_start`) arrive while `cliDone === true`, the server resets turn state, sends `thinking_start` to the UI, and re-enables the watchdog. It also sets `autonomousTurn`, which is what marks the resulting turn as the CLI's own rather than the user's. Note the condition only ever matches on `assistant` in practice: with `--include-partial-messages` the other two arrive wrapped in `stream_event`
3. **Pending flag on done**: when `result` arrives with tasks still in `pendingBgTasks`, the `done` event includes `pendingBackgroundTasks: true`

### UI (`webview/src/App.tsx`, types, components)

1. **Outcome**: `background_waiting` added to the `Outcome` type
2. **Done with pending tasks**: reducer commits the assistant message with `outcome: 'background_waiting'` and keeps `streaming` in a `backgroundWaiting` state (no timer, `isStreaming` stays true)
3. **Waiting indicator**: `StreamingMessage` renders a `WorkingIndicator` with "Waiting background task ..." text while `streaming.backgroundWaiting` is true
4. **Timer suppression**: `ChatMessage` hides the green response timer for messages with `outcome === 'background_waiting'`
5. **Resolution**: when the autonomous turn completes (second `done`), all `background_waiting` messages are resolved to `outcome: 'success'` and show their timers
6. **Sound/notification**: suppressed during the waiting phase (`isStreaming` stays true); fires only when the autonomous turn finishes
