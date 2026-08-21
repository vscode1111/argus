# Picking up backend changes (which process serves what)

Why a rebuilt backend keeps serving old code, and how to restart it so the new version is
actually picked up. The short version: **the daemon does not run from this repo by default,
and nothing watches it.**

## The one fact that explains most confusion

The daemon is spawned by whichever Argus panel first needed it, from **that panel's own
install directory** (`ensureDaemon(extensionPath)` -> `<extensionPath>/out/backend/daemon.js`).
On this machine there are three possible origins:

| Origin | Path | Rebuilt by |
|--------|------|-----------|
| Extension Development Host (F5) | `d:\_Projects\scub111g\argus\out\backend\daemon.js` | `yarn compile` |
| Installed extension | `C:\Users\Admin\.vscode\extensions\local.argus-<version>\out\backend\daemon.js` | `yarn ext:package` + `yarn ext:install` |
| Dev server (separate, port 3001) | `server/index.ts` via `tsx watch` | auto |

Installed versions **accumulate** - `local.argus-0.0.78` and `local.argus-0.0.79` both exist
right now. A single daemon is machine-global (one discovery file, one port), so an old install
that got there first serves the *new* panel, which then silently lacks whatever the new
version added. Rebuilding this repo cannot fix that: the running process is not from this repo.

This is exactly what the Settings -> Info -> **Server** row flags as `(stale)` - Client is the
panel's build, Server is `readServerVersion()` of the process actually answering.

## How to restart it properly

```sh
node scripts/daemon-stop.js      # or: yarn daemon:stop
```

It reads the pid from `~/.claude/argus-daemon.json`, kills it, and removes the file (a
force-kill skips the daemon's own cleanup, so the script clears the file itself). Idempotent.

Then just use an Argus panel: the extension's `ensureDaemon` respawns one on demand. **The
panel you touch first decides which build wins the respawn**, so open the panel you actually
want to be served by.

Restarting drops every WS connection and any in-flight turn. There is also an in-app path -
Settings -> Network -> **Apply (restart daemon)** - which does the same thing with the same
caveat.

### An open panel respawns the daemon by itself, with no user action

`ensureDaemon` is not only reached by opening a panel. Any **already-open** extension panel
respawns the daemon within seconds of it dying, unattended: the WS bridge's reconnect loop
posts `needWsUrl` on every failed attempt (backoff 1s -> 10s), `ChatPanel.buildWsUrl()` finds
no live discovery pid and calls `ensureDaemon(extensionPath)`. The panel asking "where do I
connect?" is the same act that starts a daemon.

Consequences worth knowing before trying to stop one:

- **Stopping the daemon while a panel is open does not stick.** `yarn daemon:stop` and the
  Settings -> Info -> **Stop daemon** button both really kill the process, and a panel brings
  a new one back on its next reconnect tick. The panel that requested the stop suppresses
  this (`media/chat.html` sets `userStopped` on the `daemonStopping` broadcast and stops
  asking for a URL until its overlay's Retry is clicked), but **other** open panels do not.
  Close them, or expect the daemon back.
- It is a second way to lose the version race above: the respawn comes from whichever panel
  reconnects first, i.e. potentially an old install, with no click involved.
- The browser-served UI (`http://localhost:<port>/`) has no such path - it is served *by* the
  daemon and cannot start one. A stop there is final until something else launches it.

### Restarting from inside an Argus conversation

If the restart is requested *through Argus itself* (the user asks the assistant to fix a
stale daemon), the CLI process answering is a **child of that daemon** - killing it
immediately breaks the CLI's stdout pipe and aborts the very turn doing the killing.
Check ancestry first (`claude.exe -> cmd.exe -> Code.exe <pid>` where `<pid>` matches the
discovery file), then schedule [scripts/restart-daemon-detached.js](scripts/restart-daemon-detached.js)
detached with a delay instead of running `daemon-stop.js` directly:

```sh
node -e "const{spawn}=require('child_process');spawn(process.execPath,['<repo>/!notes/common/scripts/restart-daemon-detached.js','--delay','15000'],{detached:true,stdio:'ignore',windowsHide:true}).unref()"
```

It waits out the delay (letting the requesting turn finish), then swaps **target-first**:
it spawns the target build (newest `local.argus-*` unless `--daemon-js` says otherwise) with
`ARGUS_DAEMON_FORCE_START=1`, which skips the single-instance guard and retries `EADDRINUSE`
every 200ms for ~5s, camping on the port; ~1.2s later it kills the discovery-file pid, so the
camping target inherits the port within one retry tick; ~6s later it verifies the discovery
file shows the target version and retries the whole sequence once if not. A daemon already
registered at the target version is never killed. It logs actions to
`scripts/restart-daemon-detached.log`.

Target-first exists because plain kill-then-start **loses the respawn race**: any still-open
VS Code window whose extension host predates the newest install respawns its own old build
via `ensureDaemon` within the same second the daemon dies. Observed 2026-08-06: a window
still hosting 0.0.80 respawned a 0.0.80 daemon at the very second a 4s-defer version of this
script killed the old one, while 0.0.82 was installed and expected. Reloading that window
would also cure it, but a reload cannot be done safely from outside.

Note the server-side session binding does not survive a daemon swap: the panel keeps its
rendered history, but the next send starts a fresh CLI session unless the user resumes the
old one from Session History.

### Verify, do not assume

```sh
cat ~/.claude/argus-daemon.json     # port, pid, version, startedAt
```

The `version` field is the build now serving. If it still shows the old number, the respawn
came from the old install again. Observed instance of this: pid 37632 / v0.0.78 (spawned from
`local.argus-0.0.78`) was serving a 0.0.79 panel; after `daemon-stop.js` the replacement was
pid 42832 / v0.0.79 spawned from `d:\_Projects\scub111g\argus\out\backend\daemon.js`.

To see where a running daemon came from:

```sh
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=<pid>' | Select-Object -ExpandProperty CommandLine"
```

## What each kind of change actually needs

| Changed | Needs | Restart daemon? |
|---------|-------|-----------------|
| `webview/src/**` (React UI) | `yarn build` -> `media/webview.{js,css}` | **No** - reload the page. The HTTP handler `readFileSync`s the asset per request, so the next load picks it up |
| `src/backend/**` | `yarn compile` -> `out/backend/daemon.js` | **Yes** |
| `src/frontend/**` (extension host) | `yarn compile` | No - reload the VS Code window |
| Anything, under `yarn dev` (port 3001) | nothing | **No** - `tsx watch` restarts the backend, Vite HMRs the frontend |

The `yarn dev` path is the fast loop and is not idle-killed; the daemon path is what the
installed extension and the browser UI at `http://localhost:<port>/` use.

## Stale installs are worth pruning

Old `local.argus-*` folders under `C:\Users\Admin\.vscode\extensions\` stay behind after an
upgrade and remain able to win the respawn race. If the Server row keeps going `(stale)` after
a clean restart, check what is installed:

```sh
ls -d ~/.vscode/extensions/local.argus-*
```

Removing an obsolete folder is a manual decision - VS Code must be closed, and it is a delete
outside the repo.

## Related

The daemon's own lifecycle (discovery file, single-instance guard, idle self-exit, in-process
self-restart) is documented in the root `CLAUDE.md` under "Single daemon server", and the
design notes are in [../tasks/single-daemon-server/](../tasks/single-daemon-server/).
