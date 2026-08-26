# Empty "1s" turn, then the real answer starts 5-15s later

| | |
|---|---|
| Reported | 2026-08-26, from a live session in `d:\_Projects\CCS` |
| Produced by | Claude Code, model claude-opus-5 |
| Status | Fixed, not committed |

## Symptom

Sending a message sometimes commits an **empty assistant message with a ~1s green timer**
immediately, and only 5-15s later does the request actually start being processed, as a
second message. Two occurrences in one session: `1s (10:30:48)` and `1s (10:34:08)`.

## Root cause

The Claude CLI runs turns **of its own** for background-task notifications, and each one
emits a `result` event that is structurally identical to the end of a user turn.

One of those turns runs before the user is served. On `--resume` startup the CLI replays a
`task_notification` for every background shell task orphaned by the *previous* CLI process
("No completion record was found for this background shell command from the previous
session"), answers that notification, and emits its `result` - all while the user's message
is still sitting in the CLI's own queue (`queue-operation` records show the enqueue).

`handleResult` treated every `result` as the end of the user's turn:

- `s.cliDone = true` + broadcast `done` -> the reducer commits the streaming message. It has
  no blocks yet, so it renders as an empty bubble with `outcome: 'success'` and a ~1s timer.
- The user's real turn then arrives with `cliDone === true`, which trips the "autonomous
  turn" recovery branch at the top of `handleCliEvent` -> a second `thinking_start` -> the
  answer renders as a separate message.

Why it felt new and frequent: it needs an orphaned background task, and those accumulate -
every hard kill of the CLI (daemon respawn, `Stop all Claude CLI processes`, watchdog
retry) leaves one behind, and every subsequent fresh spawn replays it.

The 5-15s gap is the resumed transcript load (1.7 MB session) plus the model's first token,
not anything Argus does. It looks longer than it is because the recovery branch only fires
on the `assistant` event: with `--include-partial-messages` the deltas arrive wrapped in
`stream_event`, so the branch's `content_block_delta` / `message_start` conditions never
match and nothing renders until the message completes.

## Evidence

The turn-boundary rule this produced is reusable beyond this ticket and lives in
[../../common/cli-turn-boundaries.md](../../common/cli-turn-boundaries.md); the table below is
the measurement it rests on.

Measured against a real CLI with no Argus code in the request path (`scripts/`):

| Turn | `num_turns` | `origin` | `result` |
|---|---|---|---|
| orphan-replay notification (spurious) | 0 | `{kind: 'task-notification'}` | `""` |
| background task finished while idle (legitimate) | 1 | `{kind: 'task-notification'}` | `"Background task finished successfully…"` |
| ordinary user turn | 1-2 | absent | the answer |

The middle row is why `origin.kind` alone cannot be the test: Argus **must** keep ending
that turn, or the spinner never stops. Assuming otherwise would have shipped a hang.

## Fix

`src/backend/cliHandler.ts`, `handleResult`: ignore a `task-notification` result when the
turn in flight is the user's, keyed on a new `SessionState.autonomousTurn` flag -
`handleSend` clears it, the recovery branch sets it. Who started the turn is the only sound
discriminator, and it does not depend on the CLI's internal turn counting.

Side effect, all good: the user's turn is never closed, so the real answer streams into the
message the user is already watching. No second bubble and no recovery turn at all, and the
timer measures send -> answer honestly.

## Verification

- `e2e/task-notification-result.spec.ts` (mock, 4 tests) - drives the compiled
  `handleCliEvent` with the captured payloads. Confirmed red without the fix, failing on
  the premature `done` assertion; green with it. Full mock suite: 246 passed.
- `scripts/verify-fix-e2e.js` - raw WS -> `startServer` -> real CLI, orphaning a background
  task by hard-killing the CLI subtree between turns. Fixed build: one `thinking_start`,
  one `done`, `done` after the content. Control run with the guard disabled: `done` at
  +1577ms with no content, answer at +3179ms - the bug, through the real server.

## Follow-up: two integration failures on the full run (same day)

`image-recognize-integration` and `session-active-marker-integration` failed on the full
suite run made *after* this fix. Neither is a regression from it, on two independent
grounds: the guard logs when it fires and `Ignoring task-notification` appears **zero**
times in either artifact, and the only behavioural change in `handleResult` lives inside
that guard. Evidence kept in `failure-artifacts.md`.

Both were the repo's own documented anti-pattern, asserting on model-owned output. The
reusable half of each (turn *duration* is model-owned; tighten the prompt instead of loosening
the assertion) is now in [../../common/e2e-testing.md](../../common/e2e-testing.md):

- **session-active-marker** - `LONG_PROMPT` ("list the numbers from 1 to 300") is meant to
  keep the turn alive while a modal opens and a session list loads off disk, but the model
  abbreviates: 6s, ~610 output tokens. At failure time the page had only a Send button and
  a committed `6s (23:26:46)` timer, so the turn was over and the marker was correctly
  absent. Both tests in the file flake this way, alternating (one on the missing dot, one
  on the row not being listed yet). Fixed by holding the turn open with a foreground
  `sleep 10` Bash call instead of a generation-length prompt. 8/8 green on `--repeat-each=4`,
  and faster (15.7s vs 37s).
- **image-recognize** - asserts four exact identifiers (`finalMessage`, `showWarningMessage`,
  …) are transcribed out of the screenshot, but the prompt only said "Recognize text", so
  the model summarised and then editorialised about the doc looking outdated. Fixed by
  asking for a verbatim transcription and nothing else, which leaves every assertion
  intact. 3/3 green on `--repeat-each=3`.

## Full suite after the fixes

`379 passed, 5 skipped (9.2m)`. Skip accounting: 3 are the permanent documented skips
(`ask-dialog-integration` x1, `ask-dialog-selection-integration` x2 - current models decline
to call AskUserQuestion in `--print` mode), the other 2 are the conditional "live usage API
unavailable" guards.

Caveat, also captured in [../../common/e2e-testing.md](../../common/e2e-testing.md): re-running
`usage-indicator-integration` + `account-usage-integration` straight after a full suite
gets `HTTP 429` and 2 of those tests **fail rather than skip**. Their guards are not quite
airtight - `liveUsageAvailable()` is evaluated once, and the real fetch a moment later can
still 429, so the header shows its `.iconOnly` fallback while the test expects bars. That is
a pre-existing gap in the test guard, not a product bug (the fallback is the designed
behaviour), and it needs the quota to recover before it can be re-measured. Not fixed here.

## Scripts

| Script | Purpose |
|---|---|
| `scan-transcript.js` | Compact timeline of a CLI transcript in a local-time window |
| `repro-orphan-notification.js` | Orphans a background task, then shows the premature `result` on a fresh `--resume` |
| `probe-bgtask-completion.js` | Control: what a *legitimate* background-task turn's result looks like |
| `verify-fix-e2e.js` | The whole path, raw WS through the real server |
| `sync-index-rows.js` | Writes the same Summary cell into `common/INDEX.md` and the root `INDEX.md` in one idempotent run, so the two copies cannot drift |
| `check-escaped-backticks.js` | Flags a literal `\` + backtick in markdown (a nested code span escaped by hand renders the backslash); a file, not a one-liner, because Git Bash degrades that pattern to a plain backtick match and reports hundreds of false hits |

## Remaining work

- Not committed.
- **The running daemon must be restarted** for the fix to take effect (it serves the
  compiled build it was launched from). See `!notes/common/backend-restart.md`.
- Untouched, cosmetic: the orphan replay also broadcasts `tool_end` frames for tool ids
  from the dead session (visible as two stray frames at +1.5s in the verify run). They
  match no block in the current UI, so nothing renders.
