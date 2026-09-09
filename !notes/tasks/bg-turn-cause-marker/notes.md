# A turn appears with no visible cause, and closes in success green

**Status:** implemented 2026-09-08, not committed. Follow-up round to
[bg-turn-completion-noise](../bg-turn-completion-noise/notes.md), reopened by the user
against the build that fixed it.

| Produced by | Claude Code, model claude-opus-5, investigation and fix |
|---|---|

Reported with a screenshot of the Settings Info tab (Client 0.0.94 / Server 0.0.94 boxed in
red) and two sentences: "Баг все равно появляется завершение сессия (зеленый текст) во время
работы сессии", then, when told the turn was real, the decisive one:

> Но ты видишь, что у типа следующей сессии не было моего запроса, как эти сессия могли быть
> реальны?

Source transcript:
`C:\Users\Admin\.claude\projects\d---Projects-GMTrade\b23de33a-599d-44bf-b888-e4d94fbae546.jsonl`

## The turns are real, and the report is still right

| turn | started | ended | started by |
|---|---|---|---|
| 1 | 11:47:11 | 11:48:49 (`1m 38s`) | the user: "Ok. fix PR description" |
| 2 | 11:51:47 | 11:52:45 (`55s`) | `<task-notification>`, nobody |

The CI watcher (`node !notes/tasks/CON-46/scripts/watch-ci.js`) was launched at 11:23:29 with
`run_in_background`, so turn 1 genuinely ended with a task still running, and at 11:51:47 the
CLI woke itself with a prompt it wrote to itself:

```xml
<summary>Background command "Watch CI until all checks complete" completed (exit code 0)</summary>
```

Turn 2 then read the output, checked the PR, edited notes and answered, spending 186,609 input
and 8,746 output tokens. Nothing about it is synthetic. What the user could not see is any of
that: the prompt is hidden, so a second answer simply appeared, worked, and closed with a
completion line identical to one he had asked for.

**Same session, second observation worth keeping:** the notification at 11:10:45 belongs to
`toolu_01UHdo...`, launched at 11:05:35 **without** `run_in_background` in its recorded input.
The CLI backgrounds a slow command on its own, so a user who never asked for a background task
can still get these turns.

## Killed first: "the fix is not deployed"

Both version rows reading 0.0.94 proves nothing on its own, since an extension packaged after
the bump but before the fix reports the same string. Checked instead of assumed: the daemon
(pid 4380) runs `C:\Users\Admin\.vscode\extensions\local.argus-0.0.94\out\backend\daemon.js`,
and that folder's `media\webview.js` is the 08.09 01:36 build containing the `bg-tasks-pill`
marker, byte-identical in that respect to the repo build. The previous round was live.

## Root cause, and it is the previous round's own fix

`isCliAuthoredUser` was widened to hide the notification prompt (it had been rendering as 42
user bubbles the user never typed) and **nothing was put in its place**. Hiding was right;
leaving the turn causeless was not. The green timer compounded it: `background_waiting` and
`background_done` both fell through to `responseTimeSuccess`, so "finished, nothing
outstanding" and "finished, a watcher is still running" were the same colour.

## What was done

1. **`src/backend/taskNotification.ts`** builds one `TaskNotice`
   (`taskId`/`toolUseId`/`outputFile`/`status`/`summary`) from either source, so the two paths
   cannot drift: `parseTaskNotification` reads the prompt (transcript), `noticeFromSystemEvent`
   reads the `system`/`task_notification` event's own fields (stream).
2. **Live** (`cliHandler.handleSystemEvent`, the `task_notification` branch): one `bg_notice`
   frame beside the `tool_end` that already updates the original Bash block. **Not**
   `handleUserEvent`, which is where this was first built and where it was dead code: see the
   probe below.
3. **Replay** (`sessions.loadSession`): the prompt becomes the first block of the turn it
   started. A real user message clears the pending notice, because the CLI answers some
   notifications with an empty turn (the orphan replay on `--resume`) and the marker must not
   drift onto the turn the user started next.
4. **Ordering** (`reducer.ts`): live the notice arrives *before* `thinking_start` (the
   recovery branch only raises the spinner on the first assistant event), so `pendingNotice`
   holds it and `thinking_start` seeds the turn's blocks with it. A task finishing mid-turn
   lands in the streaming blocks directly. `channel.applyMsg` mirrors all three, so a client
   joining mid-turn replays the cause too.
5. **Colour** (`ChatMessage.tsx`): both background outcomes render the neutral
   `msg.responseTime`. Green is the claim "nothing outstanding", and a turn that left work
   running cannot make it. Kept for the historical `background_done` as well: that a turn left
   a task running stays true afterwards, and reading back a wall of green completions during
   an hour-long watch is exactly what was reported.

## Verification

- `!notes/tasks/bg-turn-cause-marker/scripts/verify-red.js`, one revert at a time, restoring
  after each. All five red:

  | case | reverted | result |
  |---|---|---|
  | live-marker | the `bg_notice` broadcast | 1 failed |
  | replay-marker | the replay block push | 1 failed |
  | reducer-seeding | `thinking_start` seeding from `pendingNotice` | 1 failed |
  | notice-clearing | clearing on a user message | 1 failed |
  | timer-colour | the neutral branch | 2 failed |
  | count-gate | the `run_in_background` test on `task_started` | 1 failed |
  | auto-background | the result-text path | 1 failed |
  | marker-idle-gate | the `cliDone` test on the marker | 1 failed |

- Full `yarn test:e2e` (both projects), round 1: **417 passed, 6 skipped, 0 failed**, 8.1m
  (`scripts/full-suite.log`).
- Round 2 (the counting fix): mock **287 passed** (`scripts/mock-final.log`); integration
  **132 passed, 6 skipped, 2 failed** (`scripts/integration-final.log`). Both failures were
  self-inflicted, not the change: verify-red mock runs were executing *concurrently* with the
  integration project, which is the contention `workers: 1` exists to prevent, and which also
  wiped one failure's artifacts before they could be read. Re-run alone in silence, both specs
  pass (**17 passed**, `scripts/integration-rerun.log`), so all 134 are accounted for - though
  not yet all green inside one uninterrupted run. Lesson written up in
  [../../common/e2e-testing.md](../../common/e2e-testing.md).
- Three pre-existing assertions were updated deliberately, not worked around: two asserted
  `responseTimeSuccess` on turns that leave tasks behind, which is the behaviour being
  changed. The pair that replaced them pins both directions (neutral when tasks are pending,
  green when the chain ends), so a build that painted everything one colour fails one of them.

## The live path was dead code until a probe said so

Built first on `handleUserEvent`, testing `origin.kind === 'task-notification'`, with the
reasoning "the prompt is the turn boundary, so prefer it over the `system` event". The tests
passed, because **the spec's payload was copied from a transcript record**, and a transcript
record is not evidence about the stream. `scripts/probe-notification-event.js` spawns the CLI
exactly as `session.ts` does, launches one background task and holds stdin open through the
notification turn:

```
09:37:50 SYSTEM task_started task=baqv0e8j5
09:37:50 USER   origin=undefined  :: [tool_result]
09:37:56 RESULT origin=undefined num_turns=2 :: launched
09:38:12 SYSTEM task_notification task=baqv0e8j5 summary="Background command ... (exit code 0)"
09:38:19 USER   origin=undefined  :: [tool_result]
09:38:22 USER   origin=undefined  :: [tool_result]
09:38:24 RESULT origin={"kind":"task-notification"} num_turns=3
```

Three `user` events in the whole cycle, every one a `tool_result`, none carrying `origin`; the
single line mentioning `task-notification` anywhere in 75 lines of stdout is the `result`.
**The prompt exists only in the transcript.** So the live marker moved onto the `system` event,
which carries the same five fields verbatim, and the spec now drives that event with the
probe's capture.

This also corrects the previous round's explanation, repeated in CLAUDE.md until today: "live
nothing rendered it only by accident, the event lands before the recovery branch raises
thinking_start". There is no such event. The accident was imaginary and the code written to
handle it never ran.

## Round 2: the `✻ N` pill counted every Bash call

Reported the same day against the same build: "Bg indicator still flicks while bg count
disappears", then "✻ N появляется и исчезает". The answer to "indicator or count?" is **the
count**.

`task_started` is not a background-task event. A run whose only command was a plain
`echo scub-hello`, no `run_in_background` anywhere:

```
17:19:37 TOOL_USE Bash run_in_background=undefined cmd="echo scub-hello"
17:19:46 SYSTEM task_started       task=b6hrftz42
17:19:48 SYSTEM task_notification  task=b6hrftz42 summary="Echo scub-hello"
```

So every command the agent ran pushed the count up and dropped it a second later. A second
probe with exactly one real background task plus three foreground `echo`s recorded the count
as `1 → 2 → 1 → 2 → 1` (`scripts/probe-pill-flicker.log`). It also caught the same defect in
the marker shipped earlier in this task: it announced "Background task reported: Echo one".

Two discriminators now gate membership, and each covers a case the other misses:

| signal | what it means | case it catches |
|---|---|---|
| `run_in_background: true` on the tool input | the model asked for it | the ordinary launch, counted the moment `task_started` lands |
| `Command running in background with ID: <id>` in the tool result | the CLI actually did it | a command the CLI backgrounds **by itself**, whose input says nothing |

The second is not hypothetical: in the GMTrade session a Bash with no `run_in_background` came
back with exactly that string (`bsbym70eo`), and its notification arrived five minutes later
and woke an autonomous turn. The id in the string is the same `task_id` the system events
carry, checked on both a probe and that transcript, so either path feeds one set.

The marker is gated separately, on `s.cliDone`, since its job is to explain a turn that starts
by itself. Gating it on the background test instead would have silenced it for exactly the
tasks the discriminators failed to classify.

**Two hypotheses died first, both cheap to re-derive, so they are written down:**
`task_updated` does **not** fire on incremental output (probed with a task printing a line
every two seconds: one event, at completion, 0.1s before the notification, so the 2026-09-03
conclusion survives a harder case), and a long background task closes cleanly (`count=0` at
the moment it ends, then the autonomous turn).

## Gotchas

**A payload captured from a transcript proves nothing about the stream, and the test will not
tell you.** The live half was green, reviewed, and dead. What exposed it was asking "which of
these lines did I observe, and which did I infer" while the suite was already passing, then
spending ninety seconds of real CLI time on the answer. The general form is the
external-service-isolation rule in `~/.claude/instructions/rules/`: when the question is what
someone else's process emits, only that process can answer it, and a fixture is our own
belief with a timestamp on it.

**The CRLF anchor trap fired again, and the guard is what saved the round.** The
`auto-background` case anchored on `'  noteBackgroundLaunch(s, result);\n'`, which matches
nothing in a CRLF source file, exactly as [../../common/development.md](../../common/development.md)
says. It reported `ERROR: anchor matched 0 times` instead of a green run, because `patch()`
asserts the hit count rather than trusting `String.replace`. Without that assertion the case
would have printed "still green, the test proves nothing" and the real conclusion (the test is
fine, the harness never applied the revert) would have been inverted.

**The verify-red harness lied on its first run.** `spawnSync(cmd, argsArray, {shell:true})`
joins the array without quoting, so `-g a marker with no turn behind it` broke into shell
tokens: one case ran a grep of `does` (reporting "3 passed", i.e. three unrelated tests) and
another matched nothing at all. Both printed as *results* rather than as a broken harness, and
"3 passed" against a revert reads as "the test proves nothing" - a conclusion about the test
that was actually a conclusion about the quoting. The `NO TESTS RAN` guard is what caught it;
without that branch the second case would have been read as green. Same family as the CRLF
no-op patch from the previous round, now both in
[../../common/development.md](../../common/development.md).

**`channel.applyMsg` is a second reducer and it is easy to forget.** It re-implements the
webview reducer so late joiners can be replayed to, so every new streaming frame needs a case
there too, including the `pendingNotice` dance. Nothing failed when it was missing: the mock
tests drive the webview directly, and no integration test opens a second client mid
background-task turn. Found by reading, not by a red test, and it is still uncovered.

## Round 3 (2026-09-09): the user reported the ungated markers, from the deployed build

> I guess those massages are spare

A screenshot of one turn carrying three `✻` lines - `✻ Обновить описание PR`,
`✻ Проверить описание побайтово плюс структурные утверждения`, `✻ Постпубликационный аудит и CI` -
each repeating the `description` of the Bash row immediately above it. This is the defect the round-2
`s.cliDone` gate was written for, seen from the user's side, and it needed no new code.

Two things worth keeping from confirming it:

- **The report is evidence about the *deployed* build, not the working tree.** The gate was
  uncommitted at the time and already compiled into this repo's `out/`, but the daemon serving the
  user was `local.argus-0.0.95`, which predates it. Read the discovery file's pid and command line
  before concluding that a live report contradicts the code in front of you
  ([../../common/backend-restart.md](../../common/backend-restart.md)).
- **The transcript settles what the stream cannot.** All three Bash calls in
  `~/.claude/projects/d---Projects-GMTrade/baed4cb6-572e-49b8-9595-424a7d63ce23.jsonl` have
  `run_in_background: undefined` - plain foreground commands. That is the `echo one / echo two /
  echo three` case from round 2 occurring in real work, and it is the strongest evidence so far for
  gating on `cliDone`: a marker gated on "was this a background task" would also have suppressed
  these, but only by accident, and would still fire on the turn that appears from nowhere.

## Still open

- **Unanswered factual question**, asked twice: whether the `✻ 1` pill and the "1 background
  task still running" note were actually on screen between 11:23 and 11:51. If they were not,
  the pending set was emptied by a CLI respawn (the Info tab showed 11 launches), which would
  also have defeated the mid-chain silencing, and that is a separate bug from this one. The
  note cannot be recovered from the transcript, since the following turn rewrites it.
- `applyMsg`'s mirror has no test; the cheapest one is a second raw-WS client joining during a
  notification turn in `shared-channel-integration.spec.ts`.
- **Two tasks finishing before either turn starts show one marker, not two.** `pendingNotice`
  is a slot, so the second prompt overwrites the first and only the later summary opens the
  turn. Left as a slot deliberately: every session looked at so far is 1:1 (156 prompts, 156
  turns), so batching is a possibility rather than an observation, and the pill still reports
  the true count. If a real session ever shows two prompts against one turn, the slot becomes
  a queue in the reducer, `applyMsg` and the replay path together.

## Scripts

| script | what it does |
|---|---|
| `scripts/verify-red.js` | reverts each change in turn, asserts its test fails, restores |
| `scripts/probe-foreground-bash.js` | proves `task_started`/`task_notification` fire for a plain foreground Bash |
| `scripts/probe-task-updated.js` | kills the "`task_updated` fires on incremental output" theory, with a task that prints every 2s |
| `scripts/probe-pill-flicker.js` | end-to-end reproduction: a real server plus a real CLI, logging every `bgTasks` frame with a timestamp |
| `scripts/probe-notification-event.js` | spawns a real CLI with one background task and prints every `user` / `system` / `result` event; raw stdout kept as `probe-notification.out.jsonl` |
| `scripts/sync-index-rows.js` | rewrites the `cli-turn-boundaries` summary tail in both index copies at once |
| `scripts/sync-e2e-index-row.js` | appends this session's two e2e lessons to the `e2e-testing` row in both index copies |
| `scripts/sync-dev-index-row.js` | appends the backticks-in-`node -e` lesson to the `development` row in both index copies |

Run logs kept alongside: `full-suite.log` (417 passed / 6 skipped / 0 failed), `mock-rerun.log`
(283 passed, after the live path moved onto the `system` event), `verify-red.log` (the first,
mis-quoted round).
