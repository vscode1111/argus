# Shared-channel broadcasting (multi-session per workspace)

**Status:** implemented

## Problem

Every WebSocket connection was creating its own independent `SessionState` + CLI process. Two browser tabs on the same `?dir=` saw completely separate conversations. Additionally, switching to a new session (`newSession`) killed the running CLI process, aborting any in-progress turn visible to all clients.

## Goal

Clients connecting to the same `workspaceDir` share a channel. Messages and streamed responses from any active session are visible to the clients in that session. A client can open a new isolated session without disturbing other clients still viewing the old one - the old CLI proc runs to natural completion.

---

## Implemented architecture

### `src/backend/channel.ts` - Multi-session channel registry

Internal `SessionEntry` per running (or recently ran) session:

```ts
interface SessionEntry {
  readonly key: string;
  state: SessionState;
  clients: Set<WebSocket>;
  browsingClients: Set<WebSocket>; // clients viewing a different transcript
  history: ChannelMessage[];       // MAX 200, mirrors webview reducer
  snapshot: { thinking: string; blocks: ChannelBlock[] } | null;
  snapshotStartedAt: number | null;
  lastActivityAt: number;
}
```

Internal per-workspace data:

```ts
interface ChannelData {
  readonly dir: string;
  entries: Map<string, SessionEntry>; // key -> entry
  clientEntry: Map<WebSocket, SessionEntry>; // per-client routing
}
```

Public `Channel` facade returned by `getOrCreateChannel(dir)`:

```ts
interface Channel {
  addClient(ws): void;           // joins defaultEntry (most recently active)
  removeClient(ws): void;        // 30s grace timer, no killProc
  getClientState(ws): SessionState;
  moveToNewSession(ws): SessionState; // fresh entry for this client only
  setBrowsing(ws, browsing): void;
  replaySnapshot(ws): void;
  broadcastToAll(msg): void;     // all entries, deduped
  forEachSession(fn): void;      // iterate all entries' states
}
```

### Session lifecycle

- New clients join `defaultEntry` (the most recently active entry by `lastActivityAt`).
- `newSession` calls `channel.moveToNewSession(ws)`: creates a fresh `SessionEntry`, moves just that client into it. The old entry and its CLI proc keep running; other clients continue to see the turn.
- When the last client leaves an entry, the watchdog is stopped and a 30s grace timer evicts the entry from the registry. The proc is NOT killed - broadcasts go to zero clients until it exits naturally.

### SESSION_STREAM_EVENTS gating

Browsing clients (those that navigated away via `resumeSession`) are in `entry.browsingClients` and do NOT receive:
`thinking_start`, `thinking_chunk`, `text_chunk`, `tool_start`, `tool_end`, `done`, `error`, `message`, `user_inject`, `token_update`, `retry_status`, `retry_clean`, `contextUsage`

Control events (`clear`, `modelChanged`, `log`, etc.) always reach all clients.

### Two send-path rule

| Path | Messages |
|------|----------|
| `s.broadcast()` (entry-scoped) | All SESSION_STREAM_EVENTS + `clear`, `prefill`, `sessionLoaded`, `daemonRestarting` |
| `ws.send()` (requesting client only) | `settings`, `skills`, `filePreview`, `accountUsage`, `sessionList`, `sessionLoaded` (resume), `workspaceList`, `allSessionList`, `dirList`, `clientCount`, `serverInfo`, `copyImageResult` |

Global setting changes (`switchModel`/`switchEffort`/`switchThinking`) use `channel.forEachSession()` + `channel.broadcastToAll()` to update all entries' states and notify all clients.

## Superseded

- **Was:** switch handlers updated per-entry cached state via `channel.forEachSession()` and notified via the per-channel `channel.broadcastToAll()` (the paragraph above and the facade sketch).
- **Actually:** model/effort/thinking are config-global; the handlers write argus.json and notify every client of every workspace via the module-level `broadcastToAllChannels()`; `getInfo` and CLI spawns re-derive the values from `readConfig()` at use time. `broadcastToAll`/`forEachSession` were removed from the Channel facade.
- **Why it was wrong:** the per-channel scope left other workspaces' panels highlighting and spawning with a stale model (the "picked Fable 5 but it is not highlighted" bug).
- **Corrected by:** [../tasks/model-picker-refresh/notes.md](../tasks/model-picker-refresh/notes.md)

### Late-joiner replay

`addClient` calls `joinEntry` which sends `sessionLoaded {id, messages: entry.history}` then replays the in-progress streaming snapshot (thinking + blocks) so late joiners see the current conversation state immediately.

---

## Key bug regressions (e2e: `shared-channel-integration.spec.ts`)

- **Bug 1**: `resumeSession` was calling `killProc`, aborting the shared CLI turn. Fix: `handleResumeSession` no longer kills the proc; it only sets `s.sessionId` and calls `channel.setBrowsing(ws, true)`.
- **Bug 2**: after `resumeSession` the client stayed in the broadcast set and received streaming events for the old session. Fix: `setBrowsing(ws, true)` gates SESSION_STREAM_EVENTS for that client via `createBroadcastForEntry`.

---

## Files changed

| File | Change |
|------|--------|
| `src/backend/channel.ts` | Complete rewrite: `SessionEntry`-based multi-session registry |
| `src/backend/session.ts` | `getClientState(ws)` per message; `newSession` -> `moveToNewSession`; `switchModel/Effort/Thinking` -> `forEachSession` + `broadcastToAll` |
| `src/backend/sessionState.ts` | No structural change; `broadcast` assigned by `channel.ts` per entry |
| `e2e/shared-channel-integration.spec.ts` | Test 1 rewritten (newSession isolates entry); test 2 race-condition fixed (listener before open); test 9 updated (B must NOT receive clear from A's newSession); tests 7+8 added for Bug 1 and Bug 2 |
| `CLAUDE.md` | File structure and key conventions updated |
