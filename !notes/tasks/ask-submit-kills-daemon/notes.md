# ask-submit-kills-daemon: submitting an AskUserQuestion answer kills the whole server process

## Problem

Reported by the user, 2026-09-12:

> I have question block in the session
> And whe click on submit all VS Code extenson clients lost connectons
> `C:\Users\Admin\.claude\projects\d---Projects-scub111g-argus\f576b729-8c1a-4da0-a079-14e598a30ccb.jsonl`

Screenshot shows a three-tab AskUserQuestion dialog (tabs `Row action` / `Columns` /
`Staged work`) rendered normally. Clicking **Submit** disconnects every connected
client, not just the panel that clicked.

## Reproduction

Written before running, so the "after" run in Verification is provably the same run.

### Environment
- repo `d:\_Projects\scub111g\argus`, branch `main`, HEAD `759b7f9`
- compiled `out/backend/daemon.js` (recompiled from this tree before each run)
- Windows, Node = `process.execPath` of the harness
- isolated `ARGUS_CONFIG`, `ARGUS_DAEMON_FILE`, private `ARGUS_DAEMON_PORT` (3711),
  `ARGUS_MODEL_REFRESH=0`, `ARGUS_USAGE_POLL=0`, so the user's real daemon and config
  are never touched

### Input data
`questions` copied **verbatim** from line 62 of the reported transcript, where the
model recorded it as a **JSON string** rather than an array:

```
"questions": "[{\"question\":\"Should each row have an action ...\"}]"
```

### Steps
1. Put a stub `claude.cmd` first on `PATH`. `resolveClaudeBin()` resolves the CLI with
   `where claude.cmd`, so this takes the model out of the loop and makes the stdout
   deterministic; everything downstream is production code in a production process. On
   its first stdin line the stub emits `system/init` (so `s.sessionId` is set) then one
   `assistant` event carrying the captured `AskUserQuestion` block, and stays alive.
   It also appends everything written to its stdin to `cli-stdin.log`.
2. Spawn the real compiled daemon with that `PATH`.
3. Connect two raw `ws` clients, `A` and `B`, both `client=browser` so each gets its
   own `SessionEntry` - `B` is an uninvolved bystander on a different session.
4. `A` sends `send {text:'scub-ask'}`; wait for `tool_start` / `AskUserQuestion`.
5. `A` sends `toolAnswer {id, answers}` - this is the Submit click.

Script: [scripts/repro-ask-submit-crash.js](scripts/repro-ask-submit-crash.js)
(`--array` = control payload, `--dev-server` = the other server entry point).

### Expected vs actual
| | Expected | Actual |
|---|---|---|
| daemon process after Submit | alive | **exited, code 1** |
| client A socket | open | **closed 1006** |
| client B socket (bystander) | open | **closed 1006** |
| answers reach the CLI stdin | yes | **no** |

### Raw failing output
```
server:    DAEMON (out/backend/daemon.js) pid 11084, port 3711, version 0.0.98
clients:   A (will submit) and B (bystander, own session entry) connected
           A received the AskUserQuestion dialog
before:    daemon alive=true  A open=true  B open=true
--> A sends toolAnswer (the Submit click)
after:     daemon alive=false A open=false B open=false  exitCode=1
           A close: {"code":1006,"reason":""}
           B close: {"code":1006,"reason":""}
           follow-up reached the CLI stdin: false

TypeError: questions?.find is not a function
    at out/backend/session.js:112:37
    at Array.map (<anonymous>)
    at s.flushAskFollowUp (out/backend/session.js:111:53)
    at handleToolAnswer (out/backend/session.js:752:15)
    at WebSocket.<anonymous> (out/backend/session.js:383:13)
    at WebSocket.emit (node:events:519:28)
    at Receiver.receiverOnMessage (node_modules/ws/lib/websocket.js:1225:20)
```

### Independent corroboration on the user's own machine
Nothing was instrumented at the time, but the daemon's own discovery file dates the
crash:

| Event | Time (UTC) |
|---|---|
| 1st AskUserQuestion (`f576b729`, the reported session) | 07:31:27 |
| 2nd AskUserQuestion (`29da1047`, the retry) | 07:37:11 |
| **live daemon's `startedAt` in `~/.claude/argus-daemon.json`** | **07:37:35** |

The running daemon is 24s younger than the second dialog: the one serving it died and
the extension respawned it. Both transcripts also stop dead at the AskUserQuestion,
with no further turn - consistent with the follow-up never being sent.

## Root cause

`flushAskFollowUp` in `src/backend/session.ts` read the model's own tool input as if
its declared schema were guaranteed:

```ts
const questions = (tc?.input as Record<string, unknown>)?.questions as Array<{...}> | undefined;
const qDef = questions?.find(qd => qd.question === q);   // <- throws
```

The CLI delivers `questions` as a **JSON string** at least as often as an array. `?.`
guards `null`/`undefined` but not a string, so `.find` is `undefined` and calling it
throws `TypeError`.

Frequency, measured across every transcript on this machine (1,885 files): **2
AskUserQuestion calls, both strings, zero arrays.** So this is not an exotic edge
case - on this setup it is the only shape observed, and the feature was broken for
every use.

The throw escapes `ws.on('message')` (see the stack above). That is where the blast
radius comes from, and it is a **second, independent defect**: the daemon installs no
`process.on('uncaughtException')`, so one client's message terminates the shared
server and every client on it. `server/index.ts` (the dev server) does install one.

### Toggle experiment
Same script, same daemon, only the payload's type changed:

| Payload | Process | Clients | Answers delivered |
|---|---|---|---|
| `questions` as string | **exits(1)** | **all dropped** | no |
| `questions` as array (`--array`) | alive | connected | yes |

Reverting the payload brings the crash back, so the type is the cause and nothing
else in the submit path is implicated.

### Phase two - what was attacked
- **"Maybe the webview should have normalised it."** It already does, and has since
  `ask-dialog-string-input.spec.ts`: `ToolCall.tsx` parses the string before rendering,
  which is exactly why the dialog *looked* fine in the screenshot. The guard existed on
  one side of the wire only.
- **"Maybe the process death is inherent to the throw."** Falsified by prediction and
  measurement: the same payload against `server/index.ts` (`--dev-server`) throws the
  identical `TypeError`, but the `uncaughtException` handler catches it and the process
  and both clients survive. This is why the report names *VS Code* clients - those
  connect to the daemon, which has no such net.
- **"Then the net is the fix."** Killed by the same run: on the dev server the answers
  are **silently swallowed** (no follow-up on the CLI's stdin, turn ends on `error`
  + `done`). A process-level guard alone converts a crash into a silent dead dialog, so
  the fix has to land at the cause.
- **"Only the one call site matters."** `flushAskFollowUp` is also called from
  `handleResult` (`cliHandler.ts`), which runs inside the CLI stdout `on('data')`
  handler - also unwrapped. Fixing inside the builder covers both.
- **Premise attacked, not just the chain:** the stub does not emit the
  `<tool_use_error>` result the real CLI produced 4ms after the tool call. Checked
  rather than assumed - `handleToolResult` returns at its first line while
  `suppressCliOutput` is set by the intercept, so that event touches no state the crash
  depends on.
- **Instrument attacked:** the probe's first "follow-up delivered" check looked for a
  `message` frame, which is also the echo of the client's *original* send, so it read
  true on a run where nothing was delivered. It now reads the CLI's stdin. Found by
  disbelieving a green line, not by a test failing.

## Fix

Lands **at the cause**, in one place, with the untrusted-shape handling made explicit.

1. `src/backend/session.ts` - extracted the follow-up prompt into an exported pure
   `buildAskFollowUp(rawQuestions, answers)` that normalises first: parse if string
   (in a `try/catch`, since a truncated string is equally possible), then
   `Array.isArray`, else `[]`. `flushAskFollowUp` is now a three-line caller, so both
   its call sites (`handleToolAnswer` and `handleResult`) are covered by one change.
   Exported because it is the only thing in this path that reads model-authored input,
   and that is what needed pinning.
   - `options` gets the same treatment one level down: it was reached by
     `qDef?.options?.findIndex(...)`, the identical trap for a string-valued
     `options`. Fixed in the same expression; the emitted text is unchanged
     (`(option N of M)` and the description still appear, asserted byte-for-byte
     against the array form).
2. `webview/src/components/ToolCall.tsx` - sibling of the same defect, found by
   grepping the other readers of `input.questions`. `toolSummary` did
   `(input.questions as Array<...>)?.[0]?.header`, which on a string indexes to `'['`
   and yields `''`, so the tool row's caption was silently blank instead of naming the
   first question. Fixed in place (identical and trivial) by hoisting the parse the
   dialog branch already had into a module-level `parseAskQuestions`, now used by both
   readers instead of two copies.

3. `src/backend/daemon.ts` - the second defect, added on the user's go-ahead after the
   cause was fixed: `process.on('uncaughtException')` / `('unhandledRejection')`, so one
   client's message can never again end every other client's session. Node leaves the
   process in an undefined state afterwards, which is the accepted cost - a wedged turn
   is recoverable, a dead daemon takes every panel's conversation with it, and
   `server/index.ts` has made the same trade since it was written.
   - **It is made loud, not silent**, and that is the part a copy of the dev server's
     handler would have got wrong: `ensureDaemon` spawns the daemon with `stdio: 'ignore'`,
     so `console.error` reaches nobody in the deployment that matters, and a bare handler
     would have converted a visible crash into an invisible one. `reportCrash` also
     broadcasts to the Debug Log of every open panel (re-entrancy guarded, since the
     broadcast can itself be what threw).
   - Ordering note: the net alone is **not** a fix and was never shipped as one. Measured
     both ways below.

## Verification

Paired runs of the **same** script and the same instrument, red re-established by
mutating `buildAskFollowUp` back to the pre-fix line (not by reverting - a missing
export would have gone red for the wrong reason):

| | Before | After |
|---|---|---|
| daemon process | **exits(1)** | alive |
| client A | **closed 1006** | open |
| client B (bystander) | **closed 1006** | open |
| follow-up on CLI stdin | **false** | **true, `(option 1 of 3)`** |

The "after" line is read from the stub CLI's recorded stdin, so the answer and its
option index provably reached the model rather than merely failing to crash.

The two layers were then measured **independently**, by re-breaking `buildAskFollowUp`
while keeping the new crash net, which isolates exactly what the net contributes:

| `buildAskFollowUp` | crash net | process | clients | answers delivered |
|---|---|---|---|---|
| broken | absent (original) | **exits(1)** | **all dropped** | no |
| broken | present | alive, reports to Debug Log | open | **no** |
| fixed | present | alive | open | **yes** |

The middle row is why the net was never treated as the fix: it converts a crash into a
silently dead dialog. Both are needed, and in that order.

- New spec `e2e/daemon-crash-net-integration.spec.ts`: spawns a real daemon with a
  `--require` preload that throws from a timer once a trigger file appears (deliberately
  **not** a crash-on-demand product message - a server backdoor that throws on request
  would be worth more harm than the test is worth), with a client already connected.
  Asserts the crash report lands in that client's Debug Log, the process is still alive,
  the socket never closed, and the daemon still answers `getServerInfo` afterwards rather
  than sitting wedged. **Watched red** with the two handlers removed.
- New spec `e2e/ask-answer-string-questions.spec.ts` (mock project - no page, no CLI):
  5 tests, **watched red** with `TypeError: questions?.find is not a function` (the
  bug's own error, not a fixture problem), green after. Controls included: the string
  and array payloads must produce *identical* text, so a build that "fixed" the crash
  by always returning `[]` fails - it would silently drop the option index that is the
  whole point of the follow-up.
- All 20 existing AskUserQuestion specs pass (`ask-dialog-resume`,
  `ask-dialog-selection`, `ask-dialog-string-input`), covering the `ToolCall.tsx`
  refactor.
- Full mock suite: **331 passed, 0 failed**.
- Full integration suite: **134 passed, 6 skipped, 0 failed** (6.4 min). The skips are
  the usage-API specs' own 429 guard, not this change. Caveat worth recording: a
  comment-only edit to `src/backend/session.ts` was made *while* the suite ran, which
  `scripts/dev.js` watches - the documented way to manufacture a fake cascade. It can
  only produce false failures (dropped sockets), never false passes, and the edit
  changed no behaviour, so the green stands; it should still not have happened.
- `yarn compile` clean. `npx tsc -p webview/tsconfig.json --noEmit` reports 1 error in
  `FileViewerModal.tsx`, confirmed pre-existing by re-running it with the two changed
  files stashed (1 error on baseline too).
- `yarn build` clean.

- All 12 daemon lifecycle/restart/stop/browser integration specs pass with the net in
  place, so it does not mask the startup paths that rely on explicit exits
  (single-instance guard, `EADDRINUSE`, force-start handoff, idle self-exit).

## Files changed

- `src/backend/session.ts` - added exported pure `buildAskFollowUp`; `flushAskFollowUp`
  delegates to it
- `src/backend/daemon.ts` - `uncaughtException` / `unhandledRejection` net with
  `reportCrash`, which broadcasts to every panel's Debug Log because the daemon's stdout
  is discarded
- `webview/src/components/ToolCall.tsx` - module-level `parseAskQuestions`, used by
  `toolSummary` (was silently blank) and by the dialog branch (replaces its local copy)
- `e2e/ask-answer-string-questions.spec.ts` - new regression spec (mock)
- `e2e/daemon-crash-net-integration.spec.ts` - new regression spec (integration)
- `!notes/tasks/ask-submit-kills-daemon/` - these notes + the repro script

## Gotchas

- **`?.` does not protect a wrongly-typed value.** `questions?.find(...)` reads as
  defensive and is not: it guards `null`/`undefined` while a string sails through to a
  `TypeError`. Anywhere model-authored JSON is read, the test has to be `Array.isArray`
  / `typeof`, never optional chaining.
- **The two server entry points differ in crash semantics**, so the same defect has two
  symptoms: a dead daemon (VS Code panels) versus a silently dead dialog (dev server /
  browser). Reproducing only on `yarn dev` would have shown the wrong symptom and hidden
  the reported one entirely. This is the mirror image of the trap in
  [../../common/development.md](../../common/development.md), where work registered in
  `daemon.ts` never runs under `yarn dev`.
- **A stub on `PATH` turns a model-dependent bug into a deterministic one.**
  `resolveClaudeBin()` resolves the CLI by `where claude.cmd`, so prepending a stub
  directory to the daemon's `PATH` lets a real daemon process be driven through any
  stdout sequence - the only way to reproduce this on demand, since whether the model
  emits a string is not controllable.
- **Judge "did it work" by the stored record, not by the frames.** The follow-up is sent
  `_silent: true`, so it deliberately produces no `message` echo; a frame-based check
  reported success on a crashed run and then failure on a fixed one.

- **Deploying the fix then poisoned the next e2e run, and it read as a daemon regression.**
  Step 2 below force-starts the daemon, so `ARGUS_DAEMON_FORCE_START=1` lives in that
  daemon's environment - and the CLI answering an Argus conversation is its child, so the
  flag reaches every Bash call, the Playwright workers, and the daemons those specs spawn.
  `daemon.ts` skips its single-instance guard when the flag is set, so
  `daemon-lifecycle-integration.spec.ts:57` failed (exit 1, not 0) on the very next full
  run: **461 passed, 1 failed**, with the 4 remaining serial tests reported "did not run".
  Nothing to do with the crash net - the same spec passed 6/6 with the variable unset, and
  the net was present in both arms. Fixed in two layers: `delete process.env
  .ARGUS_DAEMON_FORCE_START` in `src/backend/daemon.ts` once the value is captured (it is
  a launch-time instruction, not state), plus `daemonEnv()` at the suite's spawn sites in
  `e2e/daemonHelpers.ts`. Full write-up in
  [../../common/e2e-testing.md](../../common/e2e-testing.md); probes in
  [scripts/probe-second-launch.js](scripts/probe-second-launch.js) (captures the stderr
  the spec's `stdio: 'ignore'` discards) and
  [scripts/probe-force-start-inheritance.js](scripts/probe-force-start-inheritance.js)
  (pre-fix build `1`, fixed build `undefined`, both still binding).
  Deployed 2026-09-12 the same way as the fix above: `yarn compile`, then the rebuilt
  `out/backend/daemon.js` copied over `local.argus-0.0.98`'s (md5-verified equal, previous
  file kept as `daemon.js.prefix-backup`), then the detached delayed swap. **The install's
  `daemon.js` therefore differs from what the 0.0.98 vsix packaged** - fold it into the
  next version bump so a reinstall cannot silently regress it.

## Deploying it (this fix is not live yet)

The daemon serving the user's VS Code panels runs from an **installed** extension
folder, not from this repo:

```
Code.exe c:\Users\Admin\.vscode\extensions\local.argus-0.0.97\out\backend\daemon.js
```

so `yarn compile` + `yarn build` here changes nothing for it - the install-origin trap
in [../../common/backend-restart.md](../../common/backend-restart.md).

Done on 2026-09-12:

1. `yarn ext:install` -> `local.argus-0.0.98` installed alongside the old
   `local.argus-0.0.97`. Verified the fix really reached that install rather than
   trusting the packager: `out/backend/session.js` and `out/backend/daemon.js` contain
   the normalisation and the net, and `media/webview.js` is **byte-identical (md5) to
   this repo's build** and differs from 0.0.97's.
2. The daemon restart could not be run directly: ancestry showed
   `claude.exe 18248 -> cmd.exe 16848 -> Code.exe 15664`, and 15664 was the
   discovery-file pid, so `daemon-stop.js` would have aborted the very turn doing it.
   Used the documented detached, delayed, target-first swap instead
   ([../../common/scripts/restart-daemon-detached.js](../../common/scripts/restart-daemon-detached.js)),
   which targets the newest install (numeric sort -> 0.0.98) and camps on the port
   before killing the old pid, so a still-open 0.0.97 window cannot win the respawn race.
3. Still owed by the user: **reload the VS Code windows**. Their extension hosts still
   run 0.0.97, so the Info tab's Client row will read 0.0.97 (correctly flagged stale),
   and if the daemon ever dies again one of those windows could respawn the old build.

## Decisions

- Fix at the cause (normalise the payload) **first**, and treat the process crash net as
  a separate hardening rather than the fix, because the measured dev-server behaviour
  proves the net alone leaves the answers silently dropped. Both shipped, in that order.
- The crash net reports rather than swallows. A silent net on a process whose stdout is
  discarded would have made the next occurrence of this class strictly harder to find
  than the crash was.
- The crash-net spec injects its throw with a `--require` preload rather than a
  "crash now" WS message. A product backdoor that makes the shared server throw on
  request is a bigger liability than the coverage it buys.
- Normalise **where the value is consumed**, not at the `handleAssistant` boundary where
  it enters. Normalising on entry would not let the webview drop its own guard anyway -
  the replay path (`loadSession`, straight off the transcript) delivers strings too, so
  the live and replay paths would diverge, the same trap recorded in
  [../../common/large-tool-payloads.md](../../common/large-tool-payloads.md).
- Export a pure builder instead of exporting `initChannelSession` for the test, matching
  the pattern already used for `resolveAncestry`, `groupByOwner`, `usagePollActive` and
  `applyRefreshResult`.

## Related tickets

None - reported directly in chat.
