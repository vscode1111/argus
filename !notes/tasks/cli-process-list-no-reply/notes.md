# CLI process list reported as stuck on "Loading..."

Reported 2026-09-11 with a screenshot: Settings > Info showed `CLI processes -` and the
process modal sat on `Loading...`.

## Verdict: not a hang. The screenshot is the first ~500ms.

Reproduced through the real UI against the live daemon (`http://localhost:<daemonPort>/`),
sampling both values every 100ms:

| t | Settings row | Modal body |
|---|---|---|
| 87ms | `-` | Loading... |
| 310ms | `-` | Loading... |
| 423ms | `-` | Loading... |
| 533ms | `4` | the table |

`getServerInfo` is answered synchronously, so Client/Server/Path/Session were already
painted in the screenshot while `listCliProcesses` was still shelling out to PowerShell.
Both requests leave the same `useEffect` one line apart, which is what made the missing one
look like a fault rather than a slower round trip.

## What was ruled out, and how

- **Daemon too old / no handler.** Discovery file said pid 8584 v0.0.97, started 09:46 from
  the 01:56 build; `out/backend/processes.js` present and `out/backend/session.js` carries
  the handler.
- **`listCliProcesses` hanging.** Called on the compiled bundle directly: settled in 382ms,
  5 processes, no error.
- **Request not reaching the server** (the `VS_ONLY` routing trap - an extension panel sends
  those to the VS Code host instead of the socket). `listCliProcesses` is not in `VS_ONLY`
  (`media/chat.html:93`), so it goes over WS.
- **Server dropping it under the modal's polling.** `scripts/hammer-live-daemon.js` drove the
  live daemon at the modal's own 3s cadence from an extension-shaped client (`panel=` param):
  8/8 answered in 362-492ms, no errors.
- **Stale webview bundle.** `media/webview.js` and the installed
  `~/.vscode/extensions/local.argus-0.0.97/media/webview.js` are the same 01:56 build and
  both contain `listCliProcesses`.

## Two real defects found while checking

1. **`-` is both "still asking" and "could not look."** `SettingsModal.tsx:594` renders
   `{liveProcesses ?? '-'}`, and `liveProcesses` is `null` before the first reply *and* after
   an errored one (`setLiveProcesses(msg.error ? null : ...)`). The loading state was never
   given a glyph of its own, so a half-second of normal latency is indistinguishable from a
   failed listing - which is exactly how it was read here.
2. **The client's give-up deadline equals the server's worst case.**
   `REPLY_TIMEOUT_MS = 10_000` (`CliProcessesModal.tsx:105`) against
   `PS_TIMEOUT_MS = 10_000` (`processes.ts:79`). When PowerShell hits its own timeout the
   server's error reply can only arrive *after* 10s, so the client has already shown
   "the daemon serving this panel may be older than this feature" - a confidently wrong
   diagnosis. The arriving reply does clear it (`setTimedOut(false)`), so the damage is a
   brief flash rather than a stuck message, but the margin is zero by construction.

## Scripts

- `scripts/probe-live-daemon.js` - one `listCliProcesses` over a raw WS to the running daemon.
- `scripts/hammer-live-daemon.js` - the same at the modal's 3s cadence, timing every reply.

Both read the port/nonce from `~/.claude/argus-daemon.json` and connect with a throwaway
`dir=` so they cannot join a live conversation's channel.
