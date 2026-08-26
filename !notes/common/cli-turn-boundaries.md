# When a CLI `result` event actually ends the user's turn

Argus drives the CLI as a stream of NDJSON events and treats `result` as "the turn is over"
(`handleResult` sets `cliDone` and broadcasts `done`, which is what commits the streaming
message in the reducer). **That equivalence is false.** The CLI runs turns of its own, and
each one emits a `result` that is structurally identical to the end of the user's turn.

Getting this wrong does not look like a stream bug. It looks like a UI bug: an empty
assistant message with a short green timer, and the real answer arriving later as a second
message.

## The three kinds of `result`

Measured against a real CLI (v2.1.197), scripts in
[../tasks/empty-1s-turn/scripts/](../tasks/empty-1s-turn/scripts/):

| Turn | `num_turns` | `origin` | `result` |
|---|---|---|---|
| ordinary user turn | 1-2 | absent | the answer |
| background task finished while idle | 1 | `{kind: 'task-notification'}` | "Background task finished successfully…" |
| orphaned-task replay at `--resume` startup | 0 | `{kind: 'task-notification'}` | `""` |

The last one is the trap. When a CLI process is hard-killed with a background shell task
still running (daemon respawn, "Stop all Claude CLI processes", watchdog retry), the task
is left with no completion record. The **next** `claude --resume` on that session replays a
`<task-notification>` for it at startup, answers it, and emits that `result` **before it
dequeues the user's message** - the transcript shows the user message enqueued, then a
`"model": "<synthetic>"` reply of `"No response requested."`, then the message re-queued.

## Why `origin.kind` alone cannot be the test

Rows 2 and 3 carry the **same** `origin.kind`. Filtering on it alone stops the spurious
`done` and also stops the legitimate one, so a background task that completes while the
session is idle leaves the spinner running forever. This is worth stating plainly because
`origin.kind === 'task-notification'` reads like exactly the discriminator you want, and the
control run is the only thing that says otherwise.

`num_turns === 0` separates them today, but it depends on the CLI's internal counting and
does not cover the synthetic-reply variant seen in a real session (where a no-op reply was
recorded, and whether that counts as a turn is the CLI's business, not ours).

## The rule

**Who started the turn** is the sound discriminator, and it is entirely ours:

- `handleSend` clears `s.autonomousTurn` - the turn in flight is the user's.
- The autonomous-turn recovery branch at the top of `handleCliEvent` sets it - the turn in
  flight is one the CLI started and Argus surfaced.
- `handleResult` ignores a `task-notification` result only when `!s.autonomousTurn`.

A useful side effect: the user's turn is never closed, so the real answer streams into the
message already on screen instead of a fresh one, and the recovery branch does not fire at
all for that case.

## The safety net, and why the failure is quiet

Ignoring a `result` risks a turn that never ends. The watchdog covers it (no events for
`watchdogTimeout`, default 120s, then retry or time out), which is why this is safe to do at
all. But note the shape of the bug if the rule is ever widened too far: the spinner runs for
two minutes and then *retries*, which reads as a slow model rather than as a logic error.

## Related

- Turn state and the recovery branch: `src/backend/cliHandler.ts`, `handleCliEvent`.
- The recovery branch only fires on the `assistant` event. With `--include-partial-messages`
  the deltas arrive wrapped in `stream_event`, so its `content_block_delta` / `message_start`
  conditions never match and nothing renders until the message completes. That is why a
  turn recovered this way appears to arrive in one lump after a long silence.
- Background-task feature behaviour (UI outcomes, waiting indicator): [../background-tasks.md](../background-tasks.md).
- Regression coverage: `e2e/task-notification-result.spec.ts`.
