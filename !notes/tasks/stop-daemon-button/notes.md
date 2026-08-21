# Stop daemon button (Settings > Info)

Worked on `main` (no ticket), 2026-08-21. Added a "Stop daemon" button under "Stop all Claude CLI processes" in the Settings > Info tab - the in-app equivalent of `yarn daemon:stop`.

## Why

The user asked for a way to stop the daemon from the panel instead of running the script in a terminal. Sibling of the existing "Stop all Claude CLI processes" button, and it fills the empty space right below it.

## Changes made

- **`src/backend/index.ts`** - `doStop()`: broadcasts `daemonStopping {stopped:true}` to every open client, then shuts down 300ms later (a socket that just dies leaves the other panels guessing). Extracted `shutdown()` (clear idle timer + ping interval, close wss + httpServer, call `onIdleShutdown`) now shared by the idle path, `doRestart` and `doStop`, and `broadcastAll(payload)` shared by `broadcastClientCount`, `doRestart` and `doStop`. Hook wired as `onStopRequest: options.onIdleShutdown ? doStop : undefined` - see Decisions for why that option is the gate.
- **`src/backend/session.ts`** - `ConnectionHooks.onStopRequest` + a `stopDaemon` WS handler. When the hook is absent (dev server) it replies to the requester with `daemonStopping {stopped:false}` so the UI doesn't wait on a reply that never comes.
- **`webview/src/components/SettingsModal.tsx`** - the button (`.dangerBtn`, two-click arm/confirm mirroring `handleKillAll`, 4s auto-revert, 8s stuck-state safety net), a `daemonStopping` case in the message effect, and the result line.
- **`media/chat.html`** - `userStopped` flag: on `daemonStopping` the extension shim shows the daemon-down overlay and stops asking for a URL; the overlay's Retry clears it. Without this the button is a no-op in VS Code (see Gotchas).
- **CLAUDE.md** - both protocol lines, the SettingsModal entry, the e2e table.

## Tests

- `e2e/stop-daemon.spec.ts` (mock, new): arm + auto-revert with no `stopDaemon` frame sent, both result texts from a simulated reply, and that a `daemonRestarting` message renders no stop result.
- `e2e/stop-daemon-integration.spec.ts` (integration, new): the real button clicked twice in a real browser against an isolated daemon, which really exits (pid gone, discovery file removed, port down). **Red-run verified**: with `onStopRequest` patched to `undefined` in the compiled output the test failed on the result text; recompiling made it pass again.
- `e2e/daemon-lifecycle-integration.spec.ts`: two new backend tests - the daemon stops on request, and a plain `startServer` with no `onIdleShutdown` refuses and keeps serving.
- Full suite against the correct `e2e/argus.json`: **mock 204 passed / 0 failed**, **integration 124 passed / 3 skipped / 0 failed** (5.2 min).

## Files changed

| Path | What |
|------|------|
| `src/backend/index.ts` | `doStop()`, `shutdown()`, `broadcastAll()`, `onStopRequest` wiring |
| `src/backend/session.ts` | `stopDaemon` handler + hook |
| `webview/src/components/SettingsModal.tsx` | button, arm/confirm state, result rendering |
| `media/chat.html` | `userStopped` suppression of the extension's auto-respawn |
| `e2e/stop-daemon.spec.ts` | new mock spec |
| `e2e/stop-daemon-integration.spec.ts` | new browser-UI integration spec |
| `e2e/daemon-lifecycle-integration.spec.ts` | two backend tests (stops / refuses) |
| `CLAUDE.md` | protocol lines, SettingsModal entry, e2e table |

## Gotchas

- **In the VS Code extension the stop undoes itself unless the webview cooperates.** An open panel respawns the daemon on its own reconnect tick - the mechanism, and what it means for stopping a daemon at all, is now in [../../common/backend-restart.md](../../common/backend-restart.md) ("An open panel respawns the daemon by itself"). Fix for this button is entirely in `media/chat.html`: `daemonStopping` sets `userStopped`, and while it is set the disconnected branch shows the existing daemon-down overlay instead of requesting a URL. Retry clears it, so "bring it back" stays an explicit user action. Two things make this work: server messages reach chat.html's own `window` `message` listener (the bridge's `dispatch()` re-emits them), and a restart is a *different* message (`daemonRestarting`), so restart still auto-reconnects. It only covers the panel that asked - any **other** open panel will still respawn the daemon, which is inherent to auto-start and not worth fighting.
- **The dev server must not stop itself, and the gate has to be something structural.** `yarn dev` on :3001 is the same `startServer`, so an ungated handler would let the e2e suite's own backend be killed by a click. `onIdleShutdown` is the honest gate: it is the option that grants a server permission to end its process (the daemon passes `() => { cleanup(); process.exit(0) }`, the dev server passes nothing), and `doStop` re-checks it internally as well as at the wiring site.
- **The real second click stays out of the mock project.** `stopDaemon` is not in `webview/index.html`'s `MOCK_SUPPRESSED`, so a real confirm click in a mock test reaches the live e2e dev server. Today that is harmless (it answers `stopped:false`), but only because of the gate above - if the gate regressed, that click would take the shared backend down mid-run and produce the classic cascade signature instead of one clean failure. Both real paths are proven against isolated servers in the integration project instead, where the blast radius is one spawned process.

## Decisions

- **Not `VS_ONLY`, unlike `restartDaemon`.** Restart is routed to the extension because it needs to *replace* the process (kill + force-spawn from the extension's install dir). Stopping needs no replacement, so the request goes to the server itself over the WS, which also makes it work in the daemon-served browser UI where there is no extension at all.
- **Reused the two-click arm/confirm rather than a `confirm()` dialog**, matching the kill button next to it - the action has a comparable blast radius (every panel on that daemon, plus any running turn).
- **The dev server answers instead of staying silent.** A no-op would leave the button stuck on "Stopping..." until the 8s safety net; an explicit `stopped:false` lets the modal say why nothing happened.

## Remaining work

None - feature complete, tested, documented.
