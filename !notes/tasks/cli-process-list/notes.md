# CLI process list (Settings > Info > "CLI launches")

Worked on `main` (no ticket). Clicking the "CLI launches" number in Settings > Info now opens a modal listing every Claude CLI process on the server's machine with its pid, session, start time, uptime, CPU time, CPU % and memory.

## Why

The user asked for it directly, from a screenshot with the "CLI launches" value circled: "Show new modal form with list of all CLI processes with their PID, start time, running time CPU and MEM usage and so on when I click on that text". The row already existed but only ever showed a count, and the "Stop all Claude CLI processes" button two rows below it kills processes nobody could see first.

## Changes made

- **`src/backend/processes.ts`** (new) - `listCliProcesses(owned)`. One `powershell -Command Get-CimInstance Win32_Process -Filter "Name='claude.exe'"` per sample on Windows (`ps -eo pid=,ppid=,etime=,time=,rss=,comm=,args=` on POSIX), parsed into `{pid, ppid, startedAt, cpuSeconds, cpuPercent, memBytes, sessionId?, model?, command, ours, current}`. `sample()` holds a 1s cache + shared in-flight promise and calls `measureCpu()` once per OS read; `listCliProcesses` only maps and marks. `resetProcessSamples()` as a test seam.
- **`src/backend/cli.ts`** - extracted `CLAUDE_IMAGE_WIN` / `CLAUDE_PROC_POSIX` and reused them inside `killAllClaude`, so the listing and the kill cannot disagree about what a "Claude CLI process" is.
- **`src/backend/channel.ts`** - `listOwnedProcs(): Map<pid, sessionId>` over every entry of every workspace channel.
- **`src/backend/session.ts`** - `listCliProcesses` -> `cliProcessList {processes, error?, cores}`, per-client, both branches answering (request-reply invariant).
- **`webview/src/components/CliProcessesModal.tsx` / `.module.css`** (new) - the modal. Polls every 3s while open, ticks uptime locally every 1s, times out after 10s of silence into "the daemon may be older than this feature".
- **`webview/src/components/shared/Modal.tsx` + `centeredModal.module.css`** - new `elevated` prop -> `.overlayElevated` / `.modalElevated`.
- **`webview/src/components/SettingsModal.tsx`** - the value became a `role="button"` with `.addrLink`; `useEscapeKey` guarded while the list is open.
- **`webview/src/utils/time.ts`** - `formatUptime(ms)` ("45s" / "3m 20s" / "2h 51m"), used for both uptime and CPU time.
- **`webview/index.html`** - `listCliProcesses` added to `MOCK_SUPPRESSED`.

## Tests

- `e2e/cli-processes.spec.ts` (mock, 7 tests): the click asks the server, rows render their values, the null-CPU row renders `-` **with a control row that prints its percentage**, only the `current` row is badged, a failed listing shows its reason, an empty machine is not an error, Escape closes only the top modal.
- Verified red before trusting them: forcing `0%` for a null percentage failed with `Received: "0.0%"`, and reverting the Escape guard failed the Escape test.
- Full mock suite green afterwards (297 passed) - `Modal` and `SettingsModal` are shared, so the blast radius was wider than the new spec.
- Verified live against the real backend through Playwright MCP on the user's dev server: 8 real processes listed, then a real send made a 9th appear badged "this panel" (exactly one row, not all nine).

## Gotchas

- **Windows CPU time is FILETIME ticks, and the honest percentage needs two samples.** `KernelModeTime + UserModeTime` is a *total since start* in 100ns units, so the obvious `total / uptime` reports a lifetime average - a process that burned a core for ten minutes an hour ago reads "busy" while idle. The module keeps a per-pid baseline and divides deltas instead, which means the first sample of any pid has no percentage at all. It returns `null` there and the UI prints `-`: rendering `0%` would assert the process is idle, which is exactly the claim it cannot make yet. The e2e pair (null row + control row) exists because a build that simply never rendered a percentage would satisfy the first assertion alone.
- **Advancing the CPU baseline per *caller* silently blinded the second panel** - found by attacking the finished code, not by a test. The measurement was originally computed inside `listCliProcesses`, i.e. once per client, while the raw sample it reads is shared through a 1s cache. Two panels polling out of phase therefore hit the same cached rows: the first consumed the whole delta and reset the baseline to `now`, and the second measured against a baseline milliseconds old, tripped the `MIN_SAMPLE_GAP_MS` guard and rendered `-` on every row, permanently. A per-pid baseline belongs to the sample, so `measureCpu()` now runs inside `sample()`, once per OS read. Verified by asking twice inside one cache window and diffing: both callers now return identical, non-empty percentages.
- **"CPU %" needs its convention named or it looks broken.** Measured against a deliberate busy loop, share-of-one-core reads **98.6%** where Task Manager shows **4.1%** for the same process on this 24-core box. Share-of-one-core is the useful signal (a runaway single-threaded CLI pegs at 100), so that is what is reported, `cores` rides along in the payload, and the column tooltip states both. Reporting the Task Manager convention would have made every busy process look like a rounding error.
- **`ConvertTo-Json` has three output shapes.** Zero matches print *nothing* (`JSON.parse('')` throws), one match prints a bare object, several print an array. All three occur in practice - "no Claude CLI running" is a normal state.
- **On Windows the pid this server holds is not the CLI's.** `handleSend` spawns with `shell: IS_WIN`, so `currentProc.pid` is a `cmd.exe` and `claude.exe` is its child; ownership matching has to accept a process whose **ppid** is owned. Measured on the real tree: every `claude.exe` here is `cmd.exe` -> `Code.exe` (the daemon, running Electron-as-Node), and matching on pid alone marked nothing.
- **A brand-new conversation has no `--resume` to read the session from.** Extracting the id from the command line works only for resumed spawns; the first version showed `-` for the process the user had just started. `listOwnedProcs()` returns pid -> sessionId so the server fills that in from its own registry, which is also why it is a Map rather than the Set it started as.
- **The listing must not use the sync exec the kill path uses.** `killAllClaude` is `execFileSync` and that is fine for a one-shot button, but this call costs ~350-550ms and repeats every 3s while the modal is open; synchronous it would freeze the event loop, and with it every other client's stream, for that long each time.
- **A modal opened from inside another modal needs its own layer.** The shared shell puts the overlay at `z-index: 99` and the modal at `100`, so the new modal (later in DOM order) paints on top but its *overlay* sits **below** the Settings modal - leaving Settings' danger buttons clickable underneath a window covering them. Hence `elevated`. The same stacking creates the Escape problem: both modals listen on `window`, so one keypress closed both until SettingsModal's handler was guarded.
- **A suppressed message cannot be observed at the socket.** `listCliProcesses` is in `MOCK_SUPPRESSED` (so a mock run cannot be answered by the live backend with this machine's real processes), which means the `WebSocket.prototype.send` interception used by `kill-all-claude.spec.ts` sees nothing. The proof that the app asked is the shim's own `[mock] suppressed <type>` console line, the idiom `tool-image-preview.spec.ts` already uses.
- **The row's count and the modal's scope are deliberately different - and a footnote was not enough to carry that.** "CLI launches" counts this server's spawns since it started; the modal lists every Claude CLI on the machine, matching `killAllClaude` and the button below it. Shipped with only the modal's footer explaining it, and the user hit it within a minute: a freshly launched dev server showed **`CLI launches 0`** and opened a list of **ten** processes (all belonging to the daemon serving their VS Code panels - a different server process on the same machine). Both numbers were correct; the *pairing* was the defect, because a number that disagrees with what clicking it opens reads as a broken counter no matter how correct it is. Fix: a second Info row, "CLI processes", carrying the live machine-wide count directly beneath the launch count, fed by the **same `cliProcessList` reply the modal renders**, so the two cannot drift. The lesson generalises: when a control's label and its content have different scopes, the scopes have to be visible *together*, not one click apart with prose bridging them.
- **Putting the two numbers side by side was still not enough - the next question was "what is the difference between launches and processes?"** Adjacency shows *that* they differ; it does not say *how*, and the tooltips that did say how required a hover nobody performs. They differ on **two** axes at once, which is why a one-word label cannot carry it: scope (this server vs the whole machine) *and* kind (a lifetime tally of spawn events, which only rises and is reset by the kill button, vs a live count of processes, which rises and falls as CLIs exit). Both axes matter because the pair disagrees in both directions - `0 / 10` when a fresh dev server sits beside the daemon's running CLIs, `5 / 1` once four of this server's own turns have ended. Fix: a `.infoScope` qualifier line under each label ("this server, total" / "whole machine, now"). Sized to the constraint rather than hoped at: `nowrap` + `display: block` so the 340px modal cannot split the phrase, verified not to widen the modal (still 340px; the two rows grow 30px -> 43px).

## Follow-up: tree view (who started each CLI)

User asked whether the list could be organised as a tree showing the parent processes, "like in Process Explorer".

- **`resolveAncestry()`** in `processes.ts` walks up the ppid chain per CLI. The WMI query lost its `-Filter` (685ms/275KB unfiltered vs 461ms/6.6KB filtered, measured) because ancestors cannot be resolved without the rest of the machine, and WMI has no recursive parent lookup. Only the ancestors on a CLI's own chain are kept, so the WebSocket payload does not grow with the machine.
- **`groupByOwner()`** in `CliProcessesModal.tsx` buckets rows under their owner and nests CLI-under-CLI. Tree/Flat toggle in the header, tree by default.
- e2e: `cli-process-ancestry.spec.ts` (6 pure tests on the compiled bundle) + 4 UI tests in `cli-processes.spec.ts`. Verified red by emptying `SHELL_WRAPPERS`: the owner became the `cmd.exe` wrapper and 3 of 6 failed, the other 3 correctly unaffected.

### Gotchas

- **A literal Process Explorer tree was the wrong answer, and only measuring the real chains showed it.** Every CLI on this machine sits under a `cmd.exe` that Argus itself inserts (`spawn(..., { shell: IS_WIN })`), so a faithful tree spends an indent level on a wrapper with no stats and no meaning. Worse, one real chain ran **nine** deep - `sh.exe <- node.exe <- cmd.exe <- node.exe <- cmd.exe <- node.exe <- node.exe <- cmd.exe <- claude.exe`, the yarn/tsx wrapper stack of a `yarn dev` started from a Bash tool - which would indent one CLI nine times to convey nothing. The useful question is "which *meaningful* process owns this", so the walk skips wrappers and stops at the first ancestor worth naming, keeping the full chain as hover text: collapsed, not hidden.
- **`powershell.exe` is deliberately not a wrapper.** The skip list is only shells inserted programmatically. A CLI a person started by hand in a terminal genuinely is owned by that shell, and skipping it would attribute the process to WindowsTerminal.exe, hiding the distinction between "I ran this" and "something ran this".
- **`display: flex` on a `<td>` breaks the table it lives in.** The group header is a `colSpan={7}` cell, and flexing it took the cell out of table layout, so its colSpan stopped feeding the column-width algorithm - the table overflowed the modal and the Memory column disappeared behind a horizontal scrollbar. Fixed by moving the flex to an inner div. Caught by looking at the screenshot, not by any assertion; the subsequent check measures `scrollWidth > clientWidth` directly.
- **Nesting under a parent that is not in the list silently deletes rows.** `groupByOwner` only nests when the `parentCliPid` is actually present in the payload; otherwise the child becomes a root. Without that check, a CLI whose parent CLI exited between samples would vanish from the table rather than appear at top level - a disappearing row being far worse than a mis-parented one.
- **Pid recycling can close a cycle in the parent chain**, so the walk carries both a `seen` set and a depth cap. Windows reuses pids aggressively, and a stale ppid pointing at a descendant is a real (if rare) way to hang a server thread inside a `while`.
- **The CPU baseline is taken over CLIs only, not the whole machine.** The unfiltered query now returns ~556 processes; feeding all of them to `measureCpu` would grow `lastSample` with every transient build step and shell, for numbers never rendered.

## Follow-up: per-row terminate

User asked for a terminate button per process, "as Session history" - i.e. the same hover-revealed trash affordance as that modal's delete.

- **`killCliProcess(pid)`** in `processes.ts`, WS `killCliProcess` -> `cliProcessKilled {pid, killed, error?}`.
- Hover-revealed trash in its own column; optimistic row removal; refusal surfaced as an error line.
- e2e: `cli-process-kill.spec.ts` (guard, on the compiled bundle) + 3 UI tests. Verified red by deleting the listing check.

### Gotchas

- **The pid comes from a client, so it is a privilege-escalation vector.** Anything that can open a WebSocket to Argus (nonce + Origin, but that is the whole authorisation) could otherwise have the *server* terminate any process on the machine. Two independent guards: the pid must appear in the current listing as a CLI, and on Windows the kill itself carries `/FI "IMAGENAME eq claude.exe"`, so even in the sub-second window where a pid could die and be recycled, the OS refuses to kill the stranger that inherited it. The filter was verified against a node.exe decoy before being relied on: `taskkill /F /PID <decoy> /FI "IMAGENAME eq claude.exe"` declined and the decoy survived.
- **`taskkill` exits 0 when it killed nothing, and says so in the OS display language** ("Информация: не найдено процессов…" here). Neither the exit code nor the output can decide success, so it is decided by re-probing the pid with `process.kill(pid, 0)`.
- **The success path is not automated, on purpose.** A test that hunts for a real `claude.exe` to kill will eventually find a live session on whoever runs the suite - the same reasoning that keeps `kill-all-claude.spec.ts` from ever performing its second click. It was verified by hand against a **decoy**: `node.exe` copied to a temp dir as `claude.exe` and run, which the listing picked up as a CLI and the real button killed, while all ten genuine CLIs were left alone. `killCliProcess` was also added to `MOCK_SUPPRESSED`, which the existing comment there says is about clobbering - here it is also the only thing stopping a mock test's click from reaching the live backend.
- **The guard test aims the kill at the test runner itself.** `killCliProcess(process.pid)` must be refused; a build that dropped the listing check would attempt to terminate the process running the suite. Note the red run showed the runner *surviving* even then, because the image filter caught it - the two guards really are independent, and the test fails on the missing error message rather than by dying.
- **Removing the guard is also how a stale `out/` was caught.** The red run surfaced a TypeScript error in `session.ts` that had been sitting there since the WS handler was added: `(msg as { pid: number })` does not overlap the message union (the other handlers all cast to an *optional* field). It never failed anything because `tsc` emits despite type errors and the dev server runs through `tsx`, which does not typecheck at all. Lesson: after touching `src/backend/`, run `npx tsc -p ./ --noEmit` and not only the webview's.
- **An overlay button does not work in a table.** Session History positions its delete absolutely over the row, but a `<tr>` is not a reliable containing block and the button would land on the Memory figure, so the terminate button gets its own narrow column. It also needs `:focus-visible`, since a keyboard user never triggers `:hover` and would otherwise face a permanently invisible control.

## Follow-up: "Running" and "Last activity" columns

User asked for a last-activity time per session and a boolean for whether that CLI has a running session.

- **`sessionLastActivity(id)`** in `sessions.ts`: transcript mtime, resolved for any session id (path cached per id, negative cache expires after 30s).
- **`listOwnedProcs()`** now returns `{sessionId, running}`; `sessionRunning: boolean | null` on each row, `null` for a process this server did not spawn.
- e2e: two tests in `cli-processes.spec.ts`, the three-state one verified red by collapsing `null` into `no` (`Received: "no"`).

### Gotchas

- **The obvious implementation of "is it running" is wrong, and measuring killed it in one command.** The plan was transcript-mtime freshness: an active session writes constantly, so `now - mtime < N` means busy. Sampling a session that was *actively mid-turn* showed **zero writes in 10 seconds** (mtime aged 4.2s -> 29.9s). The CLI writes at message boundaries, so during a long tool call or a long think it writes nothing at all, and the heuristic would report the busy session as idle - a false negative on precisely the row the column exists for. The signal survives as "Last activity", which is all it ever honestly claimed.
- **CPU% was the other tempting proxy and is no better.** Idle CLIs sit at 0.0-1.1% and the working one measured 1.6-2.6%; the ranges overlap, so any threshold mislabels rows in both directions. Not used.
- **So `running` has exactly one honest source and it is not universal.** The server's own registry knows (`currentProc && !cliDone`), and nothing else can. A foreign process is `null` -> `-`, never `no`. This looked like a serious limitation while testing from a dev server panel (8 of 9 rows unknown), but it is an artefact of the test setup: in normal use the daemon serves every panel and therefore owns every row.
- **All three states were checked against ground truth before shipping**, which mattered: the first live check showed `no` on our own row and could easily have been read as working ("foreign is `-`, ours is `no`, looks right") when in fact the turn had simply ended before the modal opened. Pinning a turn open with a foreground `sleep 30` - turn duration is model-owned, so a long generation prompt is not reliable - produced a `yes` while the Stop button proved the turn was still live.
- **Ten columns fit at `width: 780`**, up from 640; verified no horizontal overflow rather than assumed, since the group header's `colSpan` had already caused exactly that failure once.

## Follow-up: idle CLI reaper (Settings > Watchdog)

User asked for a watchdog that terminates this server's CLI processes once their last activity passes a limit in seconds. Prompted by seeing two idle CLIs (247MB + 338MB) under "this Argus server" in the process modal.

- **`cliIdleTimeoutSec`** in `config.ts`, default **0 (off)**.
- **`reapIdleCliProcs(idleMs, now?)`** in `channel.ts`; swept from `startServer` every `CLI_REAP_SWEEP_MS` (60s), config re-read per sweep so a change applies with no restart.
- Settings > Watchdog field with an `.infoScope` qualifier, since the tab already contains a differently-scoped "watchdog".
- e2e: `cli-idle-reaper.spec.ts` (3 tests on decoys). Verified red by deleting the `!cliDone` guard: the mid-turn decoy was killed.

### Gotchas

- **The mid-turn guard is a correctness requirement, not politeness.** Reaping purely on elapsed time would kill CLIs that are mid-turn, and killing a CLI whose transcript ends on an unanswered user message makes the next `--resume` splice a synthetic "No response requested." assistant turn into the conversation, which the model then sees forever (see `no-response-requested`). An *idle* process has already answered, so its transcript ends on an assistant record and nothing is spliced - which is exactly why "only when idle" makes the whole feature safe rather than merely tidy.
- **`entry.lastActivityAt`, not the transcript mtime.** The previous follow-up established that mtime is written at message boundaries and cannot detect a busy session; here it would have been wrong in the other direction too. The in-memory stamp is updated on every applied broadcast and is precise for exactly the entries this reaper is allowed to touch.
- **`0` must mean off, and the guard has to be `> 0` rather than a falsy check on the *interval*.** A naive `now - last >= limit` with limit 0 reaps every idle process instantly, which is the opposite of the shipped default. The spec pins this against a far-future clock so a build that got it wrong cannot pass by accident.
- **Detach before kill, and keep the session id.** Both come from existing rules but are easy to drop: without the detach the close handler mutates an entry that no longer owns the process, and without the session id the user silently loses their conversation instead of merely paying for a `--resume`. Verified live end to end - the reaped session resumed and recalled its pre-reap turn.
- **Verifying this on a live dev server is initially vacuous.** The first attempt showed `ours: []` before and after: editing `src/backend/` had made `tsx watch` restart the server, so the CLIs it had spawned were orphaned and no longer owned by anyone. A real test has to *create* an owned CLI first (send a message, let the turn finish), then wait out the limit.
- **The Settings tab is persisted**, so a script that opens Settings expecting the Info tab can land on Watchdog and time out on a testid that is not rendered. Click the tab explicitly.

## Follow-up: "2 launched but I see none of mine"

Reported with a screenshot: Info tab said `CLI launches 2`, the process list showed 8 rows all under the daemon, and no group for this server.

**Not a bug - measured before answering.** All 8 live `claude.exe` descended from `Code.exe:4128` (the daemon); none descended from the dev server, and the reaper was off (`cliIdleTimeoutSec = 0`). The two launches were real, and both processes had been reaped during the idle-reaper verification a few minutes earlier, while the limit was still 20s (restored to 0 immediately after, but the second sweep had already run).

**The display was correct and still misleading, which is the point.** This is the same counter that caused the `0 launches / 10 processes` report earlier in the same session, now failing in the opposite direction: it counts spawn *events*, so it can only rise, while the processes it counted can vanish. Two rows showing scope were not enough; the missing fact was **how many of this server's launches are still alive**.

Fix, in both places the question gets asked:
- The launch row's `.infoScope` qualifier becomes `this server, total · 0 still alive`.
- The modal footer gains `· none from this server` / `· 2 from this server`, **stated even at zero** - otherwise the answer has to be inferred from the *absence* of a group header, which is exactly what the user could not do.

### Gotchas

- **Verify before explaining.** The report contradicted what the panel was supposed to show, so the first move was the ancestry probe, not a defence of the design. Had ownership genuinely broken (a plausible regression from `listOwnedProcs` changing shape twice that day), the explanation would have been wrong and confidently delivered.
- **An existing exact-match assertion broke, correctly.** `renders each process with its pid, age…` pinned the whole summary string, which gained a clause. Updated to the new exact text rather than loosened to `toContainText` - the full line is worth pinning, and the new clause has its own test with a non-zero control.
- **The zero case needs its own control.** `none from this server` is trivially satisfied by a build that always says "none", so the spec re-dispatches with an owned row and asserts both places count it.


## Full e2e run (2026-09-11)

`yarn test:e2e`: **446 passed, 2 failed, 6 skipped, 10 did not run** (7.3m). Both failures re-run **green in isolation** (17/17, 51.5s), and neither touches code changed here.

- `effort-thinking-integration.spec.ts:185` (thinking toggle persists) - serial file, so its failure also produced the 10 "did not run".
- `stop-then-send-integration.spec.ts:41` - failed with `a new CLI should be spawned; saw: []`, i.e. the log array was **empty** while the turn itself streamed and was not swallowed. That is the documented raw-`ws` recorder-attach race (a replay sent during the upgrade can share a TCP read with the handshake and be emitted before `record()` attaches), which is load-sensitive by construction.

**The one way these changes could have caused a load-dependent failure was checked and killed**: the new reap timer could in principle kill CLIs mid-suite, but `e2e/argus.json` carries `cliIdleTimeoutSec: 0` and `readConfig` merges `DEFAULT_CONFIG`, so the sweep hit `!(0 > 0)` and returned on every tick for the whole run. Artifacts of both failures preserved under `e2e-failures/` before the re-run wiped `test-results/`.

**Second full run, same commit: 458 passed, 0 failed, 6 skipped, exit 0 (8.3m).** Both suspects passed in place - `effort-thinking:185` and `stop-then-send:41` - and with the first no longer failing, its 10 serial-file casualties ran and passed too, which is where the extra 12 passes over run 1 come from. Two independent greens plus the inert-reaper proof settle it: flakes under full-suite load, not regressions.

Also note the run appended `"cliIdleTimeoutSec": 0` to `e2e/argus.json` (the documented config-drift from integration runs); restored with `git checkout -- e2e/argus.json`.

## Extracted to common docs

The reusable half of this task lives outside the task folder; what stays here is the
ticket-specific record. Written during /update-notes:

- [../../common/session-liveness-signals.md](../../common/session-liveness-signals.md) - why transcript mtime and CPU% both fail as "is this session busy" signals, and what does work.
- [../../common/ui-that-reads-as-broken.md](../../common/ui-that-reads-as-broken.md) - two adjacent numbers with different scope/kind, and the three attempts it took to make them readable.
- [../../common/security.md](../../common/security.md) - the client-supplied-pid guard pair on `killCliProcess`.
- [../../common/e2e-testing.md](../../common/e2e-testing.md) - testing a destructive action in both directions (guard aimed at the runner's own pid, decoy named as the real target), the `x`-not-`not ok` reporter trap, and the two load flakes.
- [../../common/development.md](../../common/development.md) - `src/backend/` is typechecked by nothing you run day to day.
- [../../../!notes/common/windows-process-introspection.md](../../../../!notes/common/windows-process-introspection.md) (company level) - the OS-level half: CIM output shapes, FILETIME CPU math, ancestry, `taskkill` semantics.
- [../../../!notes/common/playwright-run-hygiene.md](../../../../!notes/common/playwright-run-hygiene.md) (company level) - stopping the developer's dev server wedges their open tab.

## Decisions

- **Machine-wide scope, not this server's spawns.** The pairing that matters is with "Stop all Claude CLI processes" directly below: a user about to press it should see what it will kill. Filtering to our own would also hide the interesting case - a leftover CLI from a crashed daemon.
- **~~No per-row kill button.~~** Originally left out (the request was for a list) and offered as a follow-up; the user asked for it in the next turn - see "Follow-up: per-row terminate". Built as **one click, no arm/confirm**, unlike the "Stop all Claude CLI processes" button: that one sweeps the machine, this one names a single process the user is looking at, and the affordance the user asked for by name (Session History's delete) is also a single click on a destructive action.
- **Server-side, not host-side.** Over a remote connection the processes that matter are on the machine running the CLI, which is the server's - the same reasoning that keeps `killAllClaude` off the `VS_ONLY` list.

## Remaining work

None for the request as stated. Offered but not built: a per-row "kill this process" action.
