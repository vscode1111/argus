# Stale discovery file strands the extension (Server "-", never reconnects)

| | |
|---|---|
| Reported | 2026-09-26, screenshot of Settings > Info with Server `-` and the disconnected dot |
| Produced by | Claude Code, model claude-opus-5 |
| Status | Fixed, verified on the live machine |

## Symptom

The VS Code panel never connects. Settings > Info shows Client `0.0.102`, Server `-`,
CLI launches `-`, CLI processes `-`, Session "(no session yet)". It does not recover on
its own, and it does not recover across a VS Code restart either.

## What was actually wrong

`~/.claude/argus-daemon.json` held:

```
{ "port": 37071, "nonce": "...", "pid": 14356, "version": "0.0.100", "startedAt": 1790321721117 }
```

- Nothing was listening on 37071, and **no `daemon.js` process existed anywhere** on the machine.
- Pid 14356 *was* alive: `Code.exe --type=utility --utility-sub-type=node.mojom.NodeService`,
  a VS Code internal.
- That process was created **15h 20m after** the daemon recorded the pid
  (daemon `startedAt` 25.09 10:35:21, pid created 26.09 01:55:31). Conclusive pid recycling.

So the daemon died without cleaning up (hard kill / sleep / crash - the cleanup handlers
only run on a graceful exit), and Windows later handed its pid to VS Code.

## Why the existing guard did not catch it

`isProcessAlive` (added by `3bcfc37`, "Fix Windows PID recycling in daemon guard") already
knows pids recycle, and verifies the process is `node.exe` or `Code.exe`. **That allowlist
is what defeated it.** The extension launches the daemon via `ELECTRON_RUN_AS_NODE` using
`process.execPath`, so the real daemon *is* a `Code.exe`:

```
"C:\...\Microsoft VS Code\Code.exe" c:\Users\Admin\.vscode\extensions\local.argus-0.0.102\out\backend\daemon.js
```

`Code.exe` therefore cannot be removed from the allowlist, and a VS Code install runs
dozens of other `Code.exe` processes for a recycled pid to land on. The heuristic cannot
be tightened its way out of this.

## Why it was permanent rather than transient

Three call sites trusted the pid, and they formed a closed loop with no exit:

1. `ensureDaemon()` - `if (info && isProcessAlive(info.pid)) return; // already running`.
   Never spawned.
2. `ChatPanel.buildWsUrl()` - only called `ensureDaemon()` in the `!info` branch, so with a
   file present nothing ever re-examined the conclusion; every reconnect rebuilt the same
   dead URL.
3. `verifyDaemonUp()` - the one place that already did a real port check, and would have
   discarded the file. It only runs 4s **after a spawn**, and the spawn never happened.

`daemon.ts`'s single-instance guard had the same flaw, so the manual workarounds were
broken too: `yarn daemon` and `cmd/start-argus-daemon.bat` both exited 0 with
"already running".

`scripts/daemon-stop.js` was worse - no name check at all. `yarn daemon:stop` would have
run `process.kill(14356)` and **killed a VS Code utility process** while printing
`[argus-daemon] stopped`.

## Fix

Liveness is decided by **probing the recorded port**, never by the pid.
`probeDaemon(port)` in `src/backend/daemonInfo.ts` calls the loopback-only `GET /health`,
which returns `{configPath, pid}` - a valid answer proves something is listening, that it
is an Argus server, and which process it is. Three outcomes:

| verdict | meaning | treated as |
|---|---|---|
| `up` | our `/health` JSON came back | alive |
| `down` | connection refused, or the answer is not ours | dead - discard the file |
| `busy` | the port accepts but `/health` did not answer in time | **alive** |

`busy` is the safety valve and the reason a timeout is deliberately not evidence of death.
The daemon is single-threaded, so a long synchronous stretch (a large transcript read, an
`execFileSync` in the kill path) can stall its HTTP handler. Reporting that as `down` would
discard the discovery file of a daemon that owns the port; its replacement then exits on
`EADDRINUSE`, leaving no file and no nonce - a permanent strand, **worse** than the bug
being fixed. Only a refused connection, or an answer that is not ours, counts as dead.

Changed:

- `src/backend/daemonInfo.ts` - `probeDaemon()`, `DaemonProbe`, `isDaemonUp(info)`.
- `src/frontend/extension.ts` - `ensureDaemon()` is async, probes the port, and clears a
  file that points at nothing reachable before spawning. `restartDaemon()` confirms the
  pid is really our daemon before `taskkill /F /T` (a recycled pid would have taken down
  part of the editor). `verifyDaemonUp()` reuses `isDaemonUp`.
- `src/frontend/chat/ChatPanel.ts` - `buildWsUrl()` kicks off `ensureDaemon()` on **every**
  call, not only when the file is missing. This is what breaks the loop.
- `src/backend/daemon.ts` - single-instance guard probes the port, so a manual launch is
  no longer blocked by a stale file.
- `scripts/daemon-stop.js` - kills the pid the **port** reports, never the one the file
  merely claims; a stale file is cleaned up with the unrelated process left alone.

## Verification

Probes in `scripts/`, run against the compiled bundle on the real machine:

- `probe-liveness.js 14356` - the actual recycled pid: `isProcessAlive true` (the defeat)
  vs `isDaemonUp false` (the fix). Control: a real `/health` reads `up`. A non-Argus
  server squatting the port reads `down`.
- `probe-busy.js` - a server that accepts and never replies reads `busy`, `isDaemonUp true`.

Immediate unblock was deleting the stale file; the extension then auto-spawned a fresh
daemon (pid 18188, version 0.0.102, same port 37071), confirmed `up` by the new probe.

e2e: `e2e/daemon-liveness.spec.ts` (mock, on the compiled bundle). The decisive test
asserts `isProcessAlive(pid) === true` **and** `isDaemonUp === false` on the same pid, so
a pid-only build fails it. Controls: a real `/health` must read alive (or "always false"
would pass and cause a respawn on every reconnect), and the stalled server must read busy.

## Not fixed / residual

- The daemon still leaves a stale file when hard-killed. That is unavoidable (no exit
  handler runs), which is exactly why readers must not trust the file's pid.
- A daemon that is up but whose recorded **nonce** is stale (port handed to a different
  Argus instance) still fails the WS handshake with 401. Not observed; `probeDaemon`
  returns the serving pid, so a future mismatch check has what it needs.
</content>
