# Connected clients panel

The Settings > Network "Active connections" row showed a number and nothing else. Clicking
it now opens a list of the clients behind that number, the same shape as the "CLI launches"
-> Claude CLI processes panel.

## What it answers

The count says "4". The questions it cannot answer are the ones that matter when Argus is
reached from outside this machine: **is one of those four not mine**, which workspace is
each one in, and which of them is burning a turn right now.

## Changes made

- **`src/backend/clients.ts`** (new) - `listClients(sockets, self)` builds one row per OPEN
  socket. A `WeakMap<WebSocket, ClientMeta>` filled by `noteClientConnect(ws, req)` at accept
  time holds what only the upgrade request knows (Origin, User-Agent, peer address, connect
  time); the session half of each row comes from the channel registry. Pure helpers
  `normalizeAddress` / `isLocalAddress` / `clientKind` / `deviceFromUserAgent` are exported
  for the spec.
- **`src/backend/channel.ts`** - `clientChannelInfo(ws)`: which workspace channel and entry a
  socket joined, the session it is bound to, what it is browsing, and whether that entry is
  mid-turn (`currentProc && !cliDone`, the same test `listOwnedProcs` uses).
- **`src/backend/index.ts`** - records the metadata at connect and passes
  `getClients: () => listClients(wss.clients, ws)` into the per-connection hooks, which is
  what lets the reply mark the asker.
- **`src/backend/session.ts`** - `listClients` -> `clientList {clients, error?}`.
- **`webview/src/components/ClientsModal.tsx` / `.module.css`** (new) - Client / Address /
  Workspace / Session / Running / Connected / For, polled every 3s and re-read immediately
  on every `clientCount` push.
- **`webview/src/components/shared/dataTable.module.css`** (new) - the table look both this
  panel and `CliProcessesModal` render; the latter was switched over to it in the same pass.
- **`webview/src/components/SettingsModal.tsx`** - the count becomes the entry point
  (`role="button"`, Enter/Space), and its `useEscapeKey` is guarded while the list is open.
- **`webview/index.html`** - `listClients` added to `MOCK_SUPPRESSED`.
- **e2e** - `clients.spec.ts` (mock: rendering + the pure helpers on the compiled bundle),
  `clients-integration.spec.ts` (a real server, real sockets, one real turn).

## Round 2: the disconnect button

Asked for after the list shipped. The first round deliberately left it out because every
Argus client reconnects on close, so the button would hand the connection straight back.
That objection is answered rather than ignored: **the close carries its own code and the
bridge does not retry that one.**

- `closeClient(sockets, id, self)` closes with **4001** (`CLOSE_CODE_DISCONNECTED`). The id
  is looked up in the live socket set, never trusted; ids are per process and never reused,
  so a stale id cannot land on the socket that replaced it.
- Closing **yourself** is allowed and needs the close deferred by a tick (`setImmediate`):
  `ws.close()` puts the socket in CLOSING at once, so the `clientClosed` reply the handler
  sends right after would never leave.
- `ws-bridge.js` treats 4001 as terminal - no backoff retry, and no reconnect on
  `visibilitychange` either, or switching tabs would undo it. `reconnectNow()` clears the
  flag, and the bridge publishes it as `window.argusReconnect` so all three hosts share one
  way back. `chat.html` additionally must not call `requestWsUrl()` on this close: that is
  what auto-spawns a daemon, and it would resurrect the connection.
- The panel that was closed replaces its pulsing "Disconnected, reconnecting..." dot with a
  **Reconnect** pill, because nothing is reconnecting and the dot would be a standing lie.
- Nothing else is torn down: the session entry and its CLI process stay, so disconnecting a
  client that is watching a turn loses the view, not the turn.

### What round 2's falsification pass caught

- **The pill rendered but could not be clicked.** `.inputWrapper` is `overflow: hidden`, so
  an element at a negative offset is clipped - the dot survives as a visible sliver, but a
  button clipped that way has its clickable centre outside itself and the click lands on
  `.inputArea`. Found by the integration test ("intercepts pointer events"), invisible to
  the eye and to every rendering assertion. The pill now lives outside that box.
- **A 4-row list disconnected the wrong row** during manual verification, because the
  selector picked "first row without the current badge" and there were stale connections
  from earlier tabs. Not a product bug, but it is why the integration test gives its victim
  page a unique `?dir=` instead of identifying rows by position.

## Decisions worth keeping

- **`running` is `boolean`, not `boolean | null`** as on the CLI panel. There the `-` state
  exists because a process another server spawned is unknowable; here every listed socket is
  this server's own, so there is no third state to invent.
- **The list shares the count's filter** (`readyState === 1`). A list one row longer than
  the number it opened from is the CLI launches/processes confusion again, in a place where
  the two are guaranteed to be the same set.
- **A socket with no recorded metadata is still listed**, with `connectedAt: 0` rendered as
  `-`, for the same reason: skipping it would break that parity to hide a case that should
  not happen.

## What round 1's falsification pass caught

- **`display: flex` on a `<td>` breaks the row.** The Client and Address cells each wrapped
  onto their own line and the remaining columns slid out from under their headers. Caught
  by looking at the rendered modal, not by any assertion - every e2e check passed against
  the broken layout, because the text was all present and in the right cells. The flex moved
  to an inner span. `CliProcessesModal.module.css` already carries this warning for its
  group header; it applies to any cell with a badge beside a value.
- **The session id is not there at `thinking_start`.** The integration spec asserted it right
  after the turn began and failed: the CLI names the session with its first event, a moment
  after the spawn, so the row genuinely starts with none. The test now polls for it, and the
  mock spec pins the `-` that shows in the meantime.
- **640px was too narrow for the one row the panel exists to explain.** With a `remote`
  badge beside a LAN address the last column went behind a horizontal scrollbar. Measured
  against a real LAN client (`192.168.0.136`), fixed at 740.

## Verified

- `!notes/tasks/connected-clients/scripts/probe-list-clients.js` - three clients differing in
  Origin/User-Agent against a real isolated server: kinds `vscode` / `browser` / `unknown`,
  devices `Windows` / `iPhone` / none, one `current`, and a closed socket leaving the list.
- Real browser against the dev server: a turn started in one workspace shows `● yes` plus its
  session id in a panel open on a *different* workspace, and flips back to `no` when the turn
  ends; a tab opened on `http://192.168.0.136:5173` renders as `192.168.0.136` + `remote`
  with the footer reading "4 connections · 1 from another device".
- Round 2, real browser: disconnecting a tab from another panel's list removed its row, the
  tab showed the Reconnect pill, it was **still** absent from the list 3.5s later (the
  bridge's first retry is at 1s), and clicking Reconnect brought it back with the dot at
  "Connected".
- `e2e/clients.spec.ts` 20/20, `e2e/clients-integration.spec.ts` 4/4,
  `e2e/cli-processes.spec.ts` 21/21 after the CSS move (including its hover test, which is
  what proves `tbody tr:hover .killBtn` survived losing the `.table` class it was scoped by).

## Not done

- The panel is scoped to **this server process**, like the count above it. A client attached
  to a different daemon is invisible, and nothing here can see one.
- `viewingSessionId` (the `browsing` badge) is covered by the mock spec only; producing it
  live needs a client that navigates away mid-turn.
