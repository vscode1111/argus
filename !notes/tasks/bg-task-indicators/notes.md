# Background task indicators: "2 of 9 background tasks still running"

**Status:** fixed 2026-09-03, not committed. Denominator dropped, green timer kept.

| Produced by | Claude Code, model claude-opus-5 |
|---|---|

Reported from a real session with a screenshot: a finished turn showing a green
success timer, two green-pulsing `Out` links, and the note `✻ 2 of 9 background
tasks still running`.

Source transcript: `C:\Users\Admin\.claude\projects\d---Projects-GMTrade\eb8b36f4-ca72-44fa-ad86-321ee0f5fdc6.jsonl`

## What the transcript shows

The turn in the screenshot ran `16:31:31Z -> 16:35:40Z` (the timer's `4m 9s
(19:35:40)` matches that window exactly, local = UTC+3). Background launches in
the whole session, from `scripts/scan-bg-tasks.js`:

| launched | tool id | description |
|---|---|---|
| 16:10:20 | EkFgkJ63 | Run order module anchor tests with Pyth key |
| 16:10:46 | wUU7ybYt | Wait for test result line then report |
| 16:15:57 | 6MngVEin | Re-check CPU time after 20s |
| 16:29:09 | nbSXbM8p | Watch PR 428 check runs until completion |
| 16:29:52 | LmTv6qas | Wait 150s then report watcher progress |
| 16:30:06 | NaLDKPSE | Wait 4 min then report watcher progress |
| **16:35:08** | **nb8GL7v2** | **Run new test with the fix** |
| **16:35:14** | **krTXjY7V** | **Wait then report new test and CI status** |
| 16:37:51 | ZgUQGNjA | (after the screenshot) |
| 16:38:04 | WwiKh5bw | (after the screenshot) |
| 16:38:52 | w79fhsLr | (after the screenshot) |

**Exactly 2 background tasks were launched inside that turn**, yet the note's
denominator was 9. The transcript persists no `task_*` system events at all
(only `assistant`/`user`/`ai-title`/`last-prompt`/`queue-operation`/`attachment`
and 2 `system/api_error`), so the counters exist only in the live CLI stdout
stream that Argus consumes.

The agent's own prose in that same turn says **"Waiting on three detached tasks
(CI watcher, the new test run, a timed reporter)"**. The CI watcher `nbSXbM8p`
started at 16:29:09, i.e. *before* the turn, so Argus had already dropped it: the
numerator undercounts for the same reason the denominator overcounts.

## Two hypotheses tested and killed

Both were plausible enough to be worth a probe, and neither survived.

1. **"The CLI re-emits `task_started` for still-running tasks each turn"** -
   would inflate `totalBgTasks++` (cliHandler.ts:65) since `pendingBgTasks` is a
   Set (idempotent) but the total is a bare counter. **Dead.**
   `scripts/probe-task-started.js`: one process, two turns, a live `sleep 300`
   across the boundary -> 1 `task_started`, 1 unique task id.

2. **"`task_updated` fires on incremental output, so deleting from
   `pendingBgTasks` on it (cliHandler.ts:67) drops live tasks"**. **Not
   supported.** `scripts/probe-task-updated.js`: a task printing MARK-1 / MARK-2
   / MARK-3-FINAL over 20s produced *no* `task_updated` at the intermediate
   marks; the single `task_updated` landed at **33.5s**, 0.1s before
   `task_notification` at 33.6s, i.e. at completion.
   Note the script's own printed VERDICT is **wrong** - it classified that event
   as "early" because its `last-output` tail was empty, but the tail was empty
   because the event carries no `output_file`, not because the task was
   mid-flight. Read the timestamps, not the verdict line.

`task_notification` (the completion signal, and the one the `--resume` orphan
replay sends) only ever deletes, so it cannot inflate the total either.

## What is left, and what would settle it

The remaining mundane explanation is that the counters had not been reset since
a much earlier send: `pendingBgTasks.clear()` / `totalBgTasks = 0` run only in
the `/clear` handler (session.ts:219), `newSession` (session.ts:398) and
`handleSend` **after** its early returns (session.ts:571) - so a **mid-turn
inject returns before the reset**. Counting every `task_started` from the
16:07:19 send onward gives 8 launches, one short of 9 (a foreground Bash
auto-backgrounded by the CLI would supply the ninth, unverified).

This is *not* established. It also sits awkwardly against the timer matching
16:31:31 exactly, which suggests that send *did* start a turn. Settling it needs
Argus's own debug log for that session (`sendLog` writes "Spawning claude" /
"Reusing claude process" per send); the transcript cannot answer it.

**The recommendation below does not depend on resolving it** - under every
candidate mechanism the denominator counts "task_starteds since the last reset",
a window with no relationship to the message the note hangs on.

## The green timer is a fall-through, not a decision

`ChatMessage.tsx:186-193` colours the timer:

```
outcome === 'error'   ? responseTimeError
: outcome === 'stopped' ? responseTimeStopped
: outcome === 'retried' ? responseTimeRetried
: responseTimeSuccess
```

`background_waiting` is not in the chain, so it lands on `responseTimeSuccess`
(green) by default. The note itself is `var(--thinking-fg)` (muted, not green);
the pulsing green `Out` links are `toolOutLinkRunning` and were **correct** here
- those two tasks really were running.

## Recommendation

Keep the green timer (the turn genuinely finished - that is the documented
meaning of `background_waiting`, and the colour describes how the *turn* ended).
Drop the denominator: render `2 background tasks still running`, never `2 of 9`.

- The numerator is the live `pendingBgTasks` set and is the only number with a
  name the reader can state.
- The denominator invites the arithmetic "so 7 finished", which is not a fact
  Argus holds.
- Making the denominator *correct* means keeping tasks pending across turn
  boundaries, and the per-turn reset is what currently garbage-collects orphaned
  tasks whose notification never arrives (hard kill, daemon respawn, kill-all -
  see `!notes/tasks/empty-1s-turn/notes.md`). Removing it trades a wrong number
  for a note that can stick forever.

Undercounting stays (the CI watcher case) but is the safe direction for a
passive footnote.

## What shipped

Green timer kept, denominator removed, and the counter behind it deleted rather
than left dangling in the wire protocol where it would invite re-rendering.

| file | change |
|---|---|
| `webview/src/components/BackgroundTasksNote.tsx` | props `{completed,total}` -> `{pending}`; label is always `N background task(s) still running`; comment records why there is no denominator |
| `webview/src/components/ChatMessage.tsx` | passes `message.bgTasksPending` |
| `webview/src/types.ts` | `bgTasksCompleted`/`bgTasksTotal` -> `bgTasksPending` |
| `webview/src/reducer.ts` | stores the pending count directly instead of reconstructing it as `total - completed`; `done` action drops `totalBackgroundTasks` |
| `src/backend/cliHandler.ts` | `totalBgTasks++` gone; `done` payload carries only `pendingBackgroundTasks` |
| `src/backend/sessionState.ts` | `totalBgTasks` field gone |
| `src/backend/session.ts` | three `totalBgTasks = 0` resets gone; the surviving `pendingBgTasks.clear()` in `handleSend` gained a comment explaining it is orphan GC and why the undercount is accepted |
| `e2e/background-tasks.spec.ts` | `totalBackgroundTasks` stripped from every mock `done`; five `N of M` assertions rewritten; a `not.toContainText(' of ')` guard added |
| `e2e/task-notification-result.spec.ts` | `totalBgTasks: 0` dropped from the hand-built state |

**Verified red.** `toContainText('3 background tasks still running')` is a
substring of the old `"3 of 3 background tasks still running"`, so passing tests
alone proved nothing. Temporarily restoring a denominator (`${count} of 9 ...`)
turned 4 of the 19 specs red, including both rewritten assertions and the
` of ` guard; the fix was then restored and all 19 pass. `yarn compile` clean;
`webview` tsc has one pre-existing unrelated `SyntaxHighlighter` JSX error in
`FileViewerModal.tsx`.

## Still open

The green `Out` pulse was **correct** in the report: both boxed links were
genuinely running tasks. Untouched deliberately.

The numerator's undercount across turn boundaries is unfixed and now documented
rather than hidden. Fixing it properly means keeping `pendingBgTasks` across
turns plus a real orphan reaper (age-out, or reconciling against the CLI's own
`/tasks` set) instead of the per-send `clear()` that stands in for one today.

## Scripts

| script | what it does |
|---|---|
| `scripts/scan-bg-tasks.js` | background launches + completions timeline from a transcript |
| `scripts/turn-boundaries.js` | interleaves real user sends with launches, showing what each reset discards |
| `scripts/probe-task-started.js` | live CLI: is `task_started` re-emitted across turns? (no) |
| `scripts/probe-task-updated.js` | live CLI: does `task_updated` fire mid-run? (no, at completion) |
