# Two "new" bugs that were already fixed: the daemon was running a 5-day-old install

Status: build packaged + installed (0.0.89), daemon swap scheduled 2026-09-01 16:15 and **not yet verified** (the swap kills the turn that scheduled it).

Reported 2026-09-01 with two screenshots: (1) `Waiting 9 background tasks (8/9)` sitting under a
finished turn, (2) a send that committed a `1s` empty message and only then started working.
Both are known, both were already fixed in this repo. Neither fix was in the running process.

## Which build was actually serving

| | Running daemon | Repo |
|---|---|---|
| Path | `C:\Users\Admin\.vscode\extensions\local.argus-0.0.88\out\backend\daemon.js` (pid 15372, launched Aug 29 12:25) | `out/` + `media/` |
| Built | **Aug 24 01:32** | Aug 27 |
| `task-notification` guard | absent (grep 0) | present |
| `background-tasks-note` | absent | present |

Corroboration that this was *the* process serving the screenshots: only port 51852 was listening
(no dev server on 3001/5173), and every live `claude --print` was a child of pid 15372 - including
the session doing the diagnosis (`node <- bash <- claude.exe <- cmd.exe <- Code.exe 15372`).

**Why it stayed stale for five days is structural, not bad luck**: `~/.claude/argus.json` has
`daemonIdleMs: 360000000` (100 hours). The daemon is only ever replaced by a fresh spawn after it
idle-exits, so at that setting a build can serve for a working week. The 10-minute default would
have rotated it the same evening.

## Evidence for bug 2, from the CLI transcript

`~/.claude/projects/d---Projects-GMTrade/30ac0842-….jsonl`:

```
10:30:14  user  <task-notification> <task-id>b576vxuqg</task-id> ...
10:30:14  attachment
10:30:14  user  "Ок, давай сначала отпишимся лиду"
10:30:24  assistant thinking            [parent = the user message]
```

A background task finished in the same second the user pressed Send. The CLI dequeued **its own**
notification turn first; that turn's `result` was taken as the end of the user's turn, committing
an empty message stamped `1s (10:30:14)`, and the real answer (10:30:24, 10s later) landed as a
second message. Exactly the shape in [../empty-1s-turn/notes.md](../empty-1s-turn/notes.md) and
[../../common/cli-turn-boundaries.md](../../common/cli-turn-boundaries.md).

Worth noting the fix generalises: the guard keys on `!s.autonomousTurn` ("who started the turn"),
not on the `--resume` startup replay that first exposed it, so a notification landing mid-send is
covered by the same line.

Bug 1 is equally unambiguous from the screenshot alone: `Waiting N background tasks` **and** the
`5m 53s (27s)` line under it are both gated on `backgroundWaiting === true` in the old
`WorkingIndicator`, a state only the post-`done` synthetic streaming state could produce. The turn
had genuinely ended ([../background-waiting-forever/notes.md](../background-waiting-forever/notes.md)).

## What was done

- `yarn build` + `yarn compile`; `npx tsc -p webview/tsconfig.json --noEmit` clean apart from the
  known pre-existing `FileViewerModal` `SyntaxHighlighter` JSX error.
- `yarn ext:install` -> `dist/argus-0.0.89.vsix` -> `local.argus-0.0.89` installed. Verified the
  new folder carries both fixes and both runtime deps (`ws`, `koffi`).
- [scripts/probe-new-daemon.js](scripts/probe-new-daemon.js) - boots the *new* build on a private
  port with a throwaway discovery file and checks it registers, answers `/nonce` and serves `/`.
  Run before the swap so a broken package cannot leave the machine with no daemon: PROBE OK
  (pid 31240 v0.0.89, `/nonce` 200, `/` 200 with `#root`).
- [scripts/check-active-sessions.js](scripts/check-active-sessions.js) - asks the live daemon
  `getActiveSessions` rather than guessing from process CPU. One turn running (the diagnosing
  session itself), so the swap cost nobody else's work.
- Swap via [../../common/scripts/restart-daemon-detached.js](../../common/scripts/restart-daemon-detached.js)
  `--delay 120000 --daemon-js …local.argus-0.0.89…`, spawned detached (watcher pid 27384).
  `daemonPort: 51852` is pinned in config, so the replacement rebinds the same port and open
  browser tabs reconnect on their own.

## Remaining work

- **Verify the swap**: `~/.claude/argus-daemon.json` should show `version: 0.0.89` with a new pid,
  and `!notes/common/scripts/restart-daemon-detached.log` records what happened. Not checkable from
  the turn that scheduled it.
- `local.argus-0.0.88` is still on disk; VS Code removes an obsoleted install on restart. Until then
  a still-open 0.0.88 window can respawn its own build - which is why the target-first camping
  sequence exists. Re-check the discovery-file version after the next VS Code restart.
- The background-waiting fix is still **uncommitted** in the working tree; it now ships in an
  installed extension while not being in git.
- Neither bug re-observed in the wild post-swap yet.
- Consider dropping `daemonIdleMs` back toward the default, or the same gap recurs on the next fix.
