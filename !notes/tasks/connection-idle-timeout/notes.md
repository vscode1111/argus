# connection-idle-timeout: reclaim WS connections a panel forgot about

## Goal

Reported with two screenshots: 11 rows in Connected Clients (`e2e/clients-integration.spec.ts`'s
feature), most idle 1-7+ hours, against only 2 live CLI processes. The user's framing named two
candidate mechanisms - "idle timeout similar to the CLI one" and "periodic check that connections
are alive" - and asked which is the better fix.

Investigation answer: both exist, and they solve different problems. Ping/pong liveness
(`src/backend/index.ts`, `wsAlive` WeakMap, 15s interval, `client.terminate()` on a missed pong)
already ships and catches a genuinely dead socket within ~30s - it does not explain the report,
since a dead socket would already be gone in seconds, not hours. The 11 rows are VS Code panels
that are still genuinely connected, just unused (other projects, unfocused windows). Only an
idle-since-last-activity timeout catches that, so this task adds one, mirroring the existing
`cliIdleTimeoutSec` CLI-process reaper.

## Acceptance criteria

1. `connectionIdleTimeoutSec` is 0 (default): no connection is ever closed for inactivity.
   Verified: `e2e/connection-idle-reaper.spec.ts` "is disabled by a zero or negative limit".
2. Setting > 0 and an entry's `lastActivityAt` stale beyond the limit: its open connection(s)
   close with a distinct code (4002), and the client does not silently reconnect.
   Verified: `e2e/connection-idle-reaper.spec.ts` "closes an idle entry's clients...";
   `e2e/connection-idle-timeout-integration.spec.ts` against a real socket + real sweep.
3. An entry that is mid-turn is never closed regardless of elapsed time.
   Verified: `e2e/connection-idle-reaper.spec.ts`, the control in the same test as #2.
4. A panel hidden when its connection idle-closes does not reconnect while still hidden.
   Verified: `e2e/connection-idle-timeout-integration.spec.ts`, real `document.hidden` override.
5. That panel becoming visible again reconnects automatically, no click required.
   Verified: same integration test - the decisive assertion.
6. A manual "Reconnect" click still works as an explicit fallback regardless of reason.
   Verified: `e2e/clients.spec.ts` "disconnected status (peer vs idle)"; the integration test's
   peer-close case clicks it and confirms it reconnects.
7. A panel reconnecting (auto or manual) after its entry fully evicted still resumes the same
   Claude session via `--resume`, not a blank conversation.
   Verified: `e2e/connection-idle-reaper.spec.ts`, "session id survives full entry eviction"
   describe block (two tests plus the "clears a stale mapping" edge case).
8. The setting takes effect on the next sweep with no restart.
   Verified: `readConfig()` re-read per sweep tick, same pattern as `cliIdleTimeoutSec`; observed
   live on the dev server (see "Verified live" below).
9. Connected Clients shows last-activity time, not just connection duration, so the reap
   criterion is visible. Verified: `e2e/clients.spec.ts`, two new assertions + a dash case.
10. A deliberate disconnect (Connected Clients button) still requires a manual click - visibility
    does not resurrect it. Verified: integration test's peer-close case, the decisive control.

## Out of scope

- Any change to ping/pong cadence or behavior - it already does its job.
- Per-socket activity tracking; reuses the existing entry-level `lastActivityAt` clock (same one
  `cliIdleTimeoutSec` already reads), so a client that is only polling Settings modals (no real
  session activity) does not count as "active" and can still be reaped. Accepted, not fixed - the
  common case (an unfocused VS Code window) is exactly what this was built for.
- Exempting the requester's own connection, or any "am I the one looking at this" signal beyond
  VS Code's `visible` panel state / the DOM's `visibilitychange`. Argus has no other telemetry
  for "a human is looking at this," and none was added.
- Automated test coverage of `ChatPanel.ts`'s `onDidChangeViewState -> panelVisible` wiring
  itself - the VS Code extension host is not reachable from the e2e suite (see Verification).
- `ownerLastSession`'s memory footprint is unbounded (a `Map<panelId, sessionId>` entry survives
  forever once written, even for a panel that never reconnects). Accepted: each entry is two short
  strings: negligible next to the ~250MB/process or the up-to-200-message history buffers this
  whole feature exists to reclaim.

## Prior art

- **`cliIdleTimeoutSec`** (`!notes/tasks/cli-process-list/notes.md`, "Follow-up: idle CLI reaper")
  is the direct template: config field defaulting to 0/off, a periodic sweep that re-reads config
  every tick (no restart needed), skip anything mid-turn, preserve `sessionId` across the kill so
  the next send still resumes. This task reproduces all four properties one layer up (the
  connection + its session entry, not just the CLI process).
- **`connected-clients`** (`!notes/tasks/connected-clients/notes.md`, "Round 2: the disconnect
  button") built the close-code-based "does not silently reconnect" mechanism this task reuses
  and extends: `CLOSE_CODE_DISCONNECTED` (4001), the `wsClosedByPeer` bridge state, the Reconnect
  pill. This task adds a second code (4002) and a second, narrower reconnect path (on visibility)
  rather than reusing 4001 outright - see Design.
- **`session-liveness-signals.md`** establishes that only the server's own registry can answer
  "is this working right now," never transcript mtime or CPU%. `entry.lastActivityAt` (already
  used by `reapIdleCliProcs`) is exactly that kind of signal, reused here rather than inventing a
  new one.

## Design

### Server (`src/backend/channel.ts`, `config.ts`, `index.ts`)

- `ArgusConfig.connectionIdleTimeoutSec: number`, default `0` (off) - same precedent as
  `cliIdleTimeoutSec`: terminating a connection on a timer is the user's call, not something to
  start doing silently on upgrade.
- `reapIdleClients(idleMs, now?)` in `channel.ts`, mirroring `reapIdleCliProcs`: scans every
  entry across every workspace channel, skips entries with zero clients (already on the ordinary
  30s-grace eviction path) and entries that are mid-turn (`currentProc && !cliDone`), and closes
  every open client of a stale entry with `CLOSE_CODE_IDLE = 4002`.
- The 60s sweep timer in `index.ts` (previously CLI-reap only) now runs both reaps in one tick;
  `ARGUS_REAP_SWEEP_MS` env override (read **inside** `startServer()`, not at module top-level -
  see Gotchas) lets tests avoid a real minute's wait.
- `ClientChannelInfo`/`ClientInfo` gained `lastActivityAt`, surfaced as a new "Last activity"
  column in `ClientsModal.tsx` (mirrors the CLI panel's Running/Last-activity pairing; modal
  widened 740 -> 820px).

### Session continuity (`ownerLastSession`)

Found during design, not in the original ask: each VS Code panel owns its own session entry
(`?panel=<uuid>`). Naively closing an idle panel's last socket triggers the *existing* 30s grace
timer -> full entry eviction, which discards `sessionId` from memory entirely (unlike
`reapIdleCliProcs`, which explicitly keeps it). Since an idle-timeout reconnect is by definition
unlikely within 30 seconds, every idle-closed panel would have silently lost the ability to
`--resume` - the old transcript stays on screen (React state survives a WS reconnect untouched),
but the next message sent would silently start a *new* CLI conversation with no memory of it. The
same gap already existed for the manual "Connected Clients disconnect" button (low blast radius
there - the user is watching both panels), but an idle timeout would hit it as the common case.

Fix: `ChannelData.ownerLastSession: Map<panelId, sessionId>`, written whenever an owned entry is
evicted (synced, not only-if-present - an entry with **no** sessionId at eviction, e.g. "New chat"
clicked then abandoned, must clear a stale mapping too, or a much-later reconnect would silently
resurrect a conversation the user had already left). Consulted in `addClient`'s panelId branch
when no live entry matches: the fresh entry's `sessionId` is seeded from the map before the client
joins. This also retroactively hardens the pre-existing manual-disconnect feature, at no extra
cost (same code path, no new flag distinguishing "why did this evict").

### Client (`webview/public/ws-bridge.js`, `media/chat.html`, `ChatPanel.ts`, reducer/UI)

Chose "auto-reconnect when looked at again" over "manual click only" (asked as a direct question;
the manual-click option was the cheaper, lower-risk default, but was not what got picked).

- `ws-bridge.js`: recognizes `CLOSE_CODE_IDLE` (4002) as a second "terminal, don't blindly
  backoff-retry" code alongside `CLOSE_CODE_DISCONNECTED` (4001), tracked via `stoppedReason:
  'peer' | 'idle' | null` (was a plain `closedByPeer` boolean). Exposes `reconnectIfIdle()`
  alongside the existing `reconnectNow()` - a no-op unless `stoppedReason === 'idle'`, so it can
  never resurrect a deliberate peer disconnect. The existing `visibilitychange` listener (browser
  tab hosts: dev Vite page, daemon-served `browser.html`) now also fires `reconnectNow()` when
  `stoppedReason === 'idle'`, not only when nothing is stopped.
- `ChatPanel.ts`: the VS Code webview has no reliable `document.hidden` of its own
  (`retainContextWhenHidden: true` keeps the script running regardless of tab visibility), so it
  needs its own signal. Extended the existing (previously `lastFocused`-only) `onDidChangeViewState`
  handler to post `{type: 'panelVisible'}` when `e.webviewPanel.visible` becomes true - `visible`,
  not `active`, so a panel showing in an unfocused split view still reconnects.
- `chat.html`: `panelVisible` -> `bridge.reconnectIfIdle()`.
- Reducer: `ws_status` carries `closeReason?: 'peer' | 'idle'` (was `closedByPeer?: boolean`);
  `AppState.wsCloseReason: 'peer' | 'idle' | null` (was `wsClosedByPeer: boolean`). The Reconnect
  pill (`InputArea.tsx`) keeps working as a manual fallback either way, with reason-appropriate
  tooltip text ("reconnects automatically... or click to reconnect now" vs "Click to reconnect.").
- Settings (Network tab): "Connection idle timeout (min)" directly below "Active connections" -
  same tab as the count it affects, not the Watchdog tab `cliIdleTimeoutSec` lives in (that tab's
  subject is retry/process hygiene; this one is squarely a network concern). Stored in seconds
  internally (matches `cliIdleTimeoutSec`'s convention), edited in minutes (matches `daemonIdleMs`'s
  UI pattern, since realistic values are hours not seconds).

## Changes made

- `src/backend/config.ts` - `connectionIdleTimeoutSec` field + default (0).
- `src/backend/channel.ts` - `CLOSE_CODE_IDLE`, `reapIdleClients()`, `ChannelData.ownerLastSession`,
  eviction-time seeding/clearing of that map, `addClient` panelId-branch restore,
  `ClientChannelInfo.lastActivityAt`, `ARGUS_ENTRY_GRACE_MS` env override on the 30s grace timer
  (test seam only, read per-call).
- `src/backend/clients.ts` - `ClientInfo.lastActivityAt`, filled from `clientChannelInfo`.
- `src/backend/index.ts` - `reapSweepMs()` (function, not a module-level const - see Gotchas),
  combined CLI-reap + connection-reap into the one sweep timer.
- `webview/src/types.ts`, `contexts/SettingsContext.tsx` - `connectionIdleTimeoutSec` plumbing.
- `webview/src/components/SettingsModal.tsx` - the Network-tab field.
- `webview/src/components/ClientsModal.tsx` (+ local `ClientInfo`) - "Last activity" column,
  modal widened 740 -> 820.
- `webview/src/reducer.ts`, `App.tsx`, `components/InputArea.tsx` - `wsCloseReason` replacing
  `wsClosedByPeer`; reason-aware Reconnect tooltip.
- `webview/public/ws-bridge.js` - `CLOSED_IDLE` code, `stoppedReason`, `reconnectIfIdle()`,
  extended `visibilitychange` gating.
- `media/chat.html` - `onStatus` signature update, new `panelVisible` message handler.
- `src/frontend/chat/ChatPanel.ts` - `onDidChangeViewState` posts `panelVisible`.
- `e2e/connection-idle-reaper.spec.ts` (new, mock) - `reapIdleClients` pure-function tests
  (mirrors `cli-idle-reaper.spec.ts`) + the `ownerLastSession` continuity tests.
- `e2e/connection-idle-timeout-integration.spec.ts` (new, integration) - real daemon on a private
  port + isolated config, real browser page, `document.hidden` override, a real second `ws` client
  for the peer-close control.
- `e2e/clients.spec.ts` - `SAMPLE` gained `lastActivityAt`; new/updated assertions for the column
  and for the two close reasons' Reconnect wording (renamed describe block).

## Gotchas

- **`REAP_SWEEP_MS` as a module-level `const` would have silently ignored the env override on a
  second `startServer()` call in a reused worker.** `Number(process.env.ARGUS_REAP_SWEEP_MS) ||
  60_000` computed once at import time (as first written) is fine for a single spawn, but any test
  that `require()`s `out/backend/index.js` **in-process** more than once in the same worker (not a
  concern for the integration test here, which spawns a real child process - but a real risk for
  any future in-process test) would get the first caller's value forever. Changed to a function,
  `reapSweepMs()`, read inside `setInterval(..., reapSweepMs())` - evaluated fresh on every
  `startServer()` call. Same reasoning as the `ARGUS_ENTRY_GRACE_MS` read inside
  `scheduleEntryCleanup` (per-call, not per-import) - both follow the existing "an env override
  captured at import lets a reused worker read stale state" lesson in `!notes/common/e2e-testing.md`.
- **The same lesson bit a second time, in a shape that isn't "import-time capture" but has the
  same effect: `beforeAll`/`afterAll` re-fire once per `--repeat-each` repeat, while top-level
  module code runs only once (`require` caching).** `connection-idle-reaper.spec.ts` originally
  set `process.env.ARGUS_ENTRY_GRACE_MS = '150'` at the file's top level and deleted it in
  `afterAll`. First repeat: correct (150ms). Every repeat after that: `afterAll` from the previous
  repeat had already deleted the var, and the top-level set never re-ran, so the grace period was
  silently back to the real 30s - a 700ms test wait then reads a **live** entry as `attached: true`
  and fails, indistinguishable from a genuine regression without the diagnostic
  (`console.log(process.env.ARGUS_ENTRY_GRACE_MS)` at the point of failure showed `undefined`).
  Reproduced deterministically at `--repeat-each=8` (7/8 later repeats failed), fixed by moving the
  `set` into `beforeAll` (which re-fires symmetrically with `afterAll`), verified stable at
  `--repeat-each=20` (140/140). Also switched every fixed test directory name in the file to a
  `Date.now()-Math.random()` suffix while investigating, even though it turned out not to be the
  cause here - cheap insurance against the next test that reuses a hardcoded dir under repeat.
- **A closing socket's own `'close'` event is asynchronous, but nothing here needed a "detach
  before kill" dance the way the CLI-process reaper does.** `reapIdleClients` calls `ws.close()`
  and returns; the actual `channel.removeClient(ws)` (which mutates `entry.clients`) only runs
  later, from the server's real `ws.on('close', ...)` handler. Unlike `currentProc` (which the CLI
  reaper must null out *before* killing, or the async close handler mutates an entry that no
  longer owns the process), nothing here reads `entry.clients` synchronously in a way a
  still-closing-but-not-yet-removed socket would corrupt - worst case is a status query seeing the
  socket as "connected" for a fraction of a second, which self-resolves exactly like any real
  disconnect.
- **Browser-hosted connections (`browser.html`, the dev Vite page) always pass `client=browser`,
  which means `fresh: true` - a brand-new isolated entry on every connect, never a `panelId`
  rejoin.** This is why the integration test's reconnect assertions don't (and can't) exercise
  `ownerLastSession` - that map is specifically for VS Code panels, which pass a stable `panelId`
  instead. Session continuity is covered at the mock/unit level instead
  (`connection-idle-reaper.spec.ts`), against the `Channel` interface directly.
- **Updating a setting while a panel's connection is idle-closed queues the message rather than
  sending it** (`ws-bridge.js`'s `post()`: `if (ready) ws.send(...); else queue.push(...)`) -
  general, pre-existing bridge behavior, not something this feature introduces, but it interacts
  with idle-close in an easy-to-miss way: changing `connectionIdleTimeoutSec` itself from a panel
  that has just been idle-closed does **not** reach the server until that panel reconnects. Hit
  live while testing (see Verified live) - the config file still showed the old value after
  "setting" it back to 0, because the tab I was testing on had itself just been idle-closed by the
  value I was replacing.

## Decisions

- **Manual click vs. auto-reconnect-on-visible was asked as a direct question, not decided
  unilaterally** - it materially changes the implementation (new `ChatPanel.ts`/`chat.html`/
  `ws-bridge.js` plumbing vs. zero new client code, reusing the already-shipped 4001 mechanism
  outright). Auto-reconnect-on-visible was chosen. Cost if this turns out to be the wrong call:
  the extra plumbing (a second close code, `stoppedReason`, `panelVisible`) is the whole
  difference, and reverting to manual-only would mean deleting it and reusing `CLOSE_CODE_DISCONNECTED`
  outright - not free, but contained to the files listed above.
- **A brand-new close code (4002) rather than reusing 4001** - cheap (one more exported constant)
  and keeps two genuinely different reasons separable in server logs and in tests, at the cost of
  one more magic number duplicated between `channel.ts` and `ws-bridge.js` (the same duplication
  4001 already has, since `ws-bridge.js` is a plain script that can't import a TS constant).
- **Settings placement: Network tab, not Watchdog** (where `cliIdleTimeoutSec` lives) - own call,
  cheap to move later. Reasoning: adjacency to "Active connections," the number it affects, over
  topical similarity to another "idle timeout."
- **No cap on `ownerLastSession`'s size** - accepted per Out of scope; revisit only if it is ever
  shown to matter in practice.

## Follow-ups

- `ChatPanel.ts`'s `onDidChangeViewState -> panelVisible` wiring has no automated coverage (the
  extension host is not reachable from Playwright); verified only by the live dev-server pass
  below plus code review. A real VS Code Extension Development Host pass (F5) was not done as
  part of this task.
- The "Settings polling doesn't count as activity" edge case (Out of scope) could be revisited if
  it turns out to matter - would need a genuinely new per-connection signal, not a reuse of
  `entry.lastActivityAt`.

## Verified live (dev server, 2026-09-17)

- Settings > Network tab: "Connection idle timeout (min)" renders directly below "Active
  connections" with correct tooltip and default "0".
- Connected Clients modal: "Last activity" column renders ("now" for the live connection),
  modal does not overflow at 820px.
- Set to 1 (minute) via the real UI against the real dev server (`~/.claude/argus.json`, the same
  file the user's real daemon reads) - the real sweep closed the page's own connection within
  ~60-70s, the Reconnect pill appeared with the correct idle-specific tooltip
  ("Disconnected due to inactivity. Reconnects automatically once this panel is viewed again, or
  click to reconnect now."). Reset to 0 immediately afterward and confirmed via the config file
  directly (`grep connectionIdleTimeoutSec ~/.claude/argus.json` -> `0`) - deliberately did not
  leave this enabled against the user's real config, since their real daemon (serving other real
  VS Code windows) reads the same file.
- Did not additionally verify the visibility-triggered auto-reconnect live against this same dev
  page (the queued-setting gotcha above meant the fastest safe path back to a reset config was an
  immediate manual `window.argusReconnect()`) - that exact mechanism is covered end-to-end by
  `connection-idle-timeout-integration.spec.ts` against an isolated daemon instead.

## Full e2e run (2026-09-17)

`npx playwright test` (mock + integration, full suite) after all changes: see the run kicked off
alongside writing this file - result recorded once it completes, not assumed.
