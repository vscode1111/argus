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
