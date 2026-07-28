# Single always-on daemon server (idle self-exit) + connect-only extension

**Status:** IMPLEMENTED (2026-06-25).

## Resolved open questions
1. **Fixed port:** `3017` (default), overridable via `ARGUS_DAEMON_PORT`.
2. **Nonce-refresh:** option (b), on-disconnect pull - the bridge re-asks the
   extension (`needWsUrl` -> `wsUrl`) before each reconnect, so a restarted daemon's
   new nonce/port is always picked up. No `fs.watch`.
3. **Build/packaging:** daemon lives at `src/backend/daemon.ts` (not `server/`) so
   the existing `tsc -p ./` emits it to `out/backend/daemon.js`, which is the only
   tree `.vscodeignore` ships in the VSIX. `daemonInfo.ts` (shared by the extension)
   sits beside it.
4. **Tray entry:** deferred (v1 = `.bat` / `yarn daemon`).

## Implemented files
- `src/backend/index.ts` - `idleTimeoutMs` + `onIdleShutdown` options; connection-count
  idle timer (cleared on connect, scheduled on last close); `close()` clears it.
- `src/backend/daemonInfo.ts` (new) - `DAEMON_FILE`, `DEFAULT_DAEMON_PORT`,
  `readDaemonInfo`/`writeDaemonInfo`/`clearDaemonInfo`, `isProcessAlive`.
- `src/backend/daemon.ts` (new) - fixed port, 10-min idle-exit, single-instance guard,
  discovery file write + cleanup on idle/SIGINT/SIGTERM/exit.
- `cmd/start-argus-daemon.bat` + `scripts/daemon.vbs` (new) - windowless launcher.
- `package.json` - `"daemon": "tsx src/backend/daemon.ts"`.
- `src/frontend/extension.ts` - dropped `startServer`; `deactivate` no-op; exports
  `readDaemon()`.
- `src/frontend/chat/ChatPanel.ts` - `buildWsUrl()` from discovery file; `needWsUrl`
  handler replies `wsUrl`.
- `media/chat.html` - daemon-down overlay (`#daemon-down` + Retry), `needWsUrl`/`wsUrl`
  flow, URL-refresh-before-reconnect.

Smoke-verified: startup, discovery file, nonce gate (401 on wrong nonce), single-instance
guard (second launch exits 0). Idle-exit timing not auto-tested (10-min hardcoded; the
option is exercised via `idleTimeoutMs`).

---

## Original plan

## Goal

Replace the current "one WebSocket server per VS Code window on a dynamic port" model
with a single shared **daemon** process on a fixed port that:

- stays alive while at least one client (webview) is connected;
- self-exits after **10 minutes** with zero connected clients;
- is started **on demand** by a launcher script the user runs (no admin, no auto-start,
  not a Windows service).

The VS Code extension becomes **connect-only**: it discovers the daemon and connects;
if the daemon is not running it shows an error (no self-hosted fallback).

## Decisions (locked, from questionnaire)

| Question | Choice |
|----------|--------|
| Hosting mechanism | Plain daemon process, alive while >=1 client, idle-exit after 10 min (NOT a Windows service) |
| Extension behavior | Connect-only: always connect to the daemon, error if it is down (no fallback) |
| (Re)start mechanism | On-demand launcher (script/shortcut/tray). Manual launch per session; self-exits when idle |

Rationale: a Windows service / auto-start was rejected to keep zero-admin, zero-residue
behavior. Idle-exit + connect-only means the daemon only lives while actually in use, and
the extension never silently spawns a competing server.

## Current architecture (today)

- `src/frontend/extension.ts:68` - `activate()` calls `startServer({ port: 0 })`, so **each
  window** gets its **own** server on an OS-assigned ephemeral port; closed in `deactivate()`.
- `getServerPort()` / `getServerNonce()` (`extension.ts:37-43`) expose that server's port + nonce.
- `src/frontend/chat/ChatPanel.ts:220-235` - bakes `ws://localhost:<port>/agent?nonce=...&dir=...`
  into `chat.html` at panel-open time via the `{{wsUrl}}` placeholder.
- `media/chat.html:36` - the webview bridge reads `WS_URL` once (baked in), reconnects with
  backoff, but cannot re-resolve the nonce (CSP `connect-src ws://localhost:*` blocks HTTP/XHR).
- `server/index.ts` - standalone dev entry, fixed port 3001 (or `ARGUS_SERVER_PORT`); writes
  `.dev-nonce`. Used by `yarn dev`.
- `src/backend/index.ts` `startServer()` - shared by both; returns `{ httpServer, port, nonce, close }`.

## Target architecture

```
                 ~/.claude/argus-daemon.json   (discovery: { port, nonce, pid, version, startedAt })
                          ^   writes/cleans                 ^ reads
                          |                                 |
   [ launcher .bat ] -> [ argus daemon (server/daemon.ts) ] <-- ws --- [ VS Code window A panels ]
                              fixed port, idle-exit 10m     <-- ws --- [ VS Code window B panels ]
                                                            <-- ws --- [ browser dev tab (optional) ]
```

One daemon, one fixed port, many WebSocket connections (per-connection isolated state already
exists). Different windows/workspaces are fine: each connection passes its own `?dir=`.

## Component breakdown

### 1. Idle self-shutdown in `startServer` (`src/backend/index.ts`)

- Add `idleTimeoutMs?: number` and `onIdleShutdown?: () => void` to `StartServerOptions`
  (or a dedicated `idle` option object). Default off, so the extension/dev paths are unaffected
  unless opted in.
- Track connected clients via `wss.clients.size` (already maintained by `ws`):
  - on `connection`: clear any pending idle timer;
  - on socket `close`: if `wss.clients.size === 0`, start a `setTimeout(idleTimeoutMs)`;
  - on timer fire (re-check `wss.clients.size === 0`): call `close()` then `onIdleShutdown()`.
- `startServer` itself must NOT call `process.exit` (it is also imported by the extension/dev).
  The daemon entry supplies `onIdleShutdown = () => process.exit(0)`.
- Idle is **connection-count based**, not activity-based (matches the chosen requirement:
  "alive if >=1 client connected, stop if none for 10 min"). A long-running agent turn with the
  panel open keeps the socket open, so it will not be killed mid-task.

### 2. Daemon entry + discovery file (`server/daemon.ts` - new)

- Resolve port: `ARGUS_DAEMON_PORT` env, else a fixed default (see Open questions - propose a
  dedicated port distinct from dev's 3001).
- `startServer({ port, model, idleTimeoutMs: 10*60*1000, onIdleShutdown: exit })`.
- After listen, write discovery file `~/.claude/argus-daemon.json`:
  `{ port, nonce, pid, version, startedAt }` (mode 600 where supported).
- Single-instance guard: if the file exists and its `pid` is alive and the port answers, exit
  early (a daemon is already running) - the launcher should be idempotent.
- Cleanup the discovery file on idle-exit, `SIGINT`/`SIGTERM`, and `process.on('exit')`.
- Build: the daemon must run as compiled JS in the shipped extension (not tsx). Confirm the
  extension build (`tsc -p ./`, see `yarn compile`) emits `server/daemon.js` to the out dir, or
  add it to the build inputs. (See Open questions.)

### 3. On-demand launcher (`cmd/start-argus-daemon.bat` - new, + `yarn daemon`)

- Double-clickable `.bat` that starts the daemon **detached** (windowless), so closing the
  console does not kill it; the daemon self-exits when idle.
- Add `package.json` script `"daemon": "tsx server/daemon.ts"` for dev use.
- Optional later: a tray entry. Out of scope for v1 (script/shortcut is enough).
- Document: "run this when you start working; it shuts itself down ~10 min after the last
  Argus panel closes."

### 4. Extension becomes connect-only (`src/frontend/extension.ts`, `ChatPanel.ts`)

- Remove `startServer(...)` from `activate()` and the `argusServer` lifecycle in `deactivate()`.
- Replace `getServerPort()` / `getServerNonce()` with a `readDaemon()` that reads
  `~/.claude/argus-daemon.json` (fresh each panel open / reconnect). Returns `undefined` if
  missing/unparseable.
- `ChatPanel.getHtml()`: if no daemon info, inject an empty `wsUrl` and render a clear
  **"Argus daemon not running"** state with a button/hint to launch it (and a Retry that
  re-reads the discovery file and reloads the webview). If present, inject
  `ws://localhost:<port>/agent?nonce=...&dir=...` as today.
- Daemon-restart resilience (new nonce): the baked `WS_URL` nonce goes stale if the daemon
  restarts while a panel is open. Options (pick in impl):
  - (a) Extension watches `argus-daemon.json` (fs.watch) and on change re-posts a fresh
    `wsUrl` to the webview via `postMessage`; the chat.html bridge swaps `WS_URL` and reconnects
    (mirror the `switchWorkspace` reconnect path).
  - (b) Simpler v1: on `ws_status disconnected`, the webview asks the extension (postMessage)
    for a fresh wsUrl; extension re-reads discovery and replies. Avoids fs.watch.
  - Note: the webview itself cannot fetch `/nonce` over HTTP - `chat.html` CSP is
    `connect-src ws://localhost:*` only. So nonce refresh MUST be driven by the extension, unlike
    the browser dev path (`webview/public/dev-bridge.js`) which uses an XHR to `/nonce`.

### 5. Dev mode (`server/index.ts`, `webview/index.html`) - unchanged by default

- `yarn dev` keeps the no-idle server on 3001 with the `.dev-nonce` + `/nonce` XHR path.
- The daemon is a separate concern; dev does not need idle-exit. Keep them distinct so the dev
  server is not killed after 10 min of idle editing.

### 6. Security

- Discovery file holds the per-process **nonce** (a connection secret). It lives in
  `~/.claude/` (user-owned). Set restrictive perms; document that any local process running as
  the user could read it - acceptable, same trust boundary as `.dev-nonce` and
  `~/.claude/.credentials.json`.
- Origin gate + live `enforceOrigins()` (already implemented) still apply: a fixed,
  predictable port is more reachable, so `allowNetworkAccess` defaulting and the Origin allowlist
  matter more. No change to the gate itself.
- Nonce still validated at upgrade (401 on mismatch), so a stale-nonce panel fails closed.

## Files to add / change

| File | Change |
|------|--------|
| `src/backend/index.ts` | Add `idleTimeoutMs` + `onIdleShutdown`; track `wss.clients.size`; idle timer |
| `server/daemon.ts` (new) | Daemon entry: fixed port, idle-exit, write/clean discovery file, single-instance guard |
| `cmd/start-argus-daemon.bat` (new) | On-demand windowless launcher |
| `package.json` | `daemon` script; ensure daemon is in the compiled build output |
| `src/frontend/extension.ts` | Drop `startServer`; add `readDaemon()`; connect-only |
| `src/frontend/chat/ChatPanel.ts` | Build wsUrl from discovery file; "daemon down" state; reconnect/nonce-refresh wiring |
| `media/chat.html` | Accept a fresh `wsUrl` via postMessage + reconnect (daemon-restart recovery) |
| `CLAUDE.md` | Document daemon model, launcher, connect-only, discovery file |
| `_notes/common/` | Optional: a `daemon.md` reference if behavior is non-obvious |

## Risks & gotchas

- **chat.html CSP blocks HTTP** - the webview cannot self-refresh the nonce; the extension must
  push fresh connection info. This is the main difference from the browser dev bridge.
- **Daemon lifetime vs. long turns** - idle is connection-count based; a closed panel drops its
  socket. If a user closes the panel mid-turn, the turn's socket closes and the 10-min countdown
  starts (the CLI proc is per-connection and will be torn down on socket close as today). Confirm
  this matches expectations.
- **Build packaging** - the shipped extension must include compiled `server/daemon.js` (and its
  `src/backend/*` deps) in the VSIX, or the launcher cannot run it. Verify `out`/`dist` layout.
- **Port already in use by a non-Argus process** - the single-instance guard must distinguish
  "our daemon already running" (probe `/nonce` / discovery pid alive) from "port stolen"; surface
  a clear error in the launcher.
- **Multiple machine users / fast user switching** - one discovery file per user home; fine.
- **e2e tests** - integration tests assume the dev server on 3001. The daemon changes are
  orthogonal; keep dev path intact so existing specs pass. Add daemon-specific tests separately
  (idle-exit timing can be tested with a small `idleTimeoutMs`).

## Open questions (decide at implementation start)

1. **Fixed port number.** Propose a dedicated default (e.g. `3017`) distinct from dev's `3001`,
   overridable via `ARGUS_DAEMON_PORT`. Confirm preferred value.
2. **Nonce-refresh strategy** for daemon restart while panels are open: fs.watch push (a) vs.
   on-disconnect pull (b). Recommend (b) for v1 simplicity.
3. **Build/packaging** target for the daemon in the VSIX (out dir, included files).
4. **Tray entry** - defer to v2? (v1 = .bat/shortcut only.)

## Implementation order (milestones)

1. Idle-shutdown option in `startServer` + unit/e2e with a tiny timeout. (Self-contained, no UI.)
2. `server/daemon.ts` + discovery file + `yarn daemon` + `.bat` launcher. (Runs standalone,
   testable by connecting the browser dev tab to the fixed port.)
3. Extension connect-only: `readDaemon()`, wsUrl from discovery, "daemon down" UI.
4. Daemon-restart recovery (nonce refresh via postMessage).
5. Docs (CLAUDE.md + _notes) and packaging verification.

## Follow-ups (2026-06-26)

- **Daemon port field shows the real running port.** A `useEffect` on `serverPort`
  (the live port from `serverInfo`) seeds the Network tab "Daemon port" input with the
  port the daemon is actually listening on, instead of the stored `daemonPort` config
  (which can be stale - set then never applied). Randomize/Apply still override it.
- **Randomize-port button.** A dice-icon button left of the Daemon port input fills a
  random non-popular port (`randomPort()`, 1024-65535 minus a `POPULAR_PORTS` set of
  well-known/common dev ports). `NumberInput` syncs its prop to local text so the value
  updates immediately.
- Files: `webview/src/components/SettingsModal.tsx`, `SettingsModal.module.css`.
