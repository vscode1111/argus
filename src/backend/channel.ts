import type { WebSocket } from 'ws';
import { createSessionState, type SessionState } from './sessionState';
import { killProc } from './cli';

const MAX_HISTORY = 200;

interface ChannelTool {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  error?: boolean;
}

interface ChannelBlock {
  type: 'text' | 'tool' | 'user_inject';
  text?: string;
  call?: ChannelTool;
}

export interface ChannelMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  images?: Array<{ data: string; mediaType: string; name?: string }>;
  thinking?: string;
  blocks?: ChannelBlock[];
  outcome?: string;
  errorKind?: string;
}

// Session-streaming events: browsing clients (those that navigated away to a different
// session via resumeSession) do not receive these. Control events (clear, modelChanged,
// log, etc.) are NOT in this set and reach all clients regardless of browsing state.
const SESSION_STREAM_EVENTS = new Set([
  'thinking_start', 'thinking_chunk', 'text_chunk', 'tool_start', 'tool_end',
  'done', 'error', 'message', 'user_inject', 'token_update',
  // 'sessionId' belongs to the live turn: a browsing client is viewing a different
  // transcript, so it must not have its address bar rewritten to this one.
  'retry_status', 'retry_clean', 'contextUsage', 'sessionId',
]);

// One SessionEntry per running (or recently-ran) session within a workspace.
// Clients connect to the most recently active entry; newSession creates a fresh one.
interface SessionEntry {
  readonly key: string;
  // Panel that owns this entry (extension clients pass a stable per-panel id). A
  // reconnecting panel rejoins its own entry instead of the channel default, so two
  // panels in one workspace stay isolated while a reload keeps its conversation.
  owner?: string;
  state: SessionState;
  clients: Set<WebSocket>;
  browsingClients: Set<WebSocket>; // within this entry: clients viewing a different transcript
  history: ChannelMessage[];
  snapshot: { thinking: string; blocks: ChannelBlock[] } | null;
  snapshotStartedAt: number | null;
  lastActivityAt: number;
}

// Internal per-workspace-dir channel data.
interface ChannelData {
  readonly dir: string;
  entries: Map<string, SessionEntry>;
  clientEntry: Map<WebSocket, SessionEntry>;
}

// Public interface used by session.ts and index.ts.
export interface Channel {
  /** Add a client: joins the most recently active entry and receives a history replay.
   *  Pass fresh=true to create an isolated new entry instead (used for browser clients).
   *  When sessionId names a session live in an entry right now, the client attaches to
   *  that entry (deep link) - overriding fresh; returns true only for such an attach.
   *  panelId binds the client to its own entry (see SessionEntry.owner): an unknown id
   *  creates one, a known id rejoins it. Returns true for such a rejoin as well, since
   *  like a deep-link attach it defers the replay to webviewReady. */
  addClient(ws: WebSocket, fresh?: boolean, sessionId?: string, panelId?: string): boolean;
  /** Remove a client on disconnect; handles per-entry cleanup without killing the proc. */
  removeClient(ws: WebSocket): void;
  /** Get the session state for this client's current entry. */
  getClientState(ws: WebSocket): SessionState;
  /** Create a fresh isolated session entry for this client; the old entry keeps running. */
  moveToNewSession(ws: WebSocket): SessionState;
  /** Mark a client as browsing (will not receive SESSION_STREAM_EVENTS) or live. */
  setBrowsing(ws: WebSocket, browsing: boolean): void;
  /** Replay the in-progress streaming snapshot to this client (from its current entry). */
  replaySnapshot(ws: WebSocket): void;
  /** Replay the client's entry history + streaming snapshot (deep-link initial sync). */
  /** Replay this client's entry (history + streaming snapshot). Returns false when the
   *  entry has nothing to replay, so the caller can fall back to loading from disk. */
  replayHistory(ws: WebSocket): boolean;
}

const registry = new Map<string, ChannelData>();

// Send a message to every connected client across ALL workspace channels. Used for
// global settings changes (model/effort/thinking), which live in the shared config:
// a per-channel broadcast left other workspaces' panels showing the old value.
export function broadcastToAllChannels(msg: string): void {
  const sent = new Set<WebSocket>();
  for (const cd of registry.values()) {
    for (const entry of cd.entries.values()) {
      for (const ws of entry.clients) {
        if (ws.readyState === 1 && !sent.has(ws)) {
          try { ws.send(msg); } catch { /* closing */ }
          sent.add(ws);
        }
      }
    }
  }
}
let _entrySeq = 0;
let _msgSeq = 0;
function nextEntryKey(): string { return `e${++_entrySeq}`; }
function nextMsgId(): string { return `ch-${++_msgSeq}-${Date.now()}`; }

// Mirror the webview reducer's state transitions to maintain history and the streaming
// snapshot so that late-joining clients (or clients returning from browsing) can replay.
function applyMsg(entry: SessionEntry, p: Record<string, unknown>): void {
  switch (p.type as string) {
    case 'message': {
      const m = p.message as ChannelMessage | undefined;
      if (m) {
        entry.history.push(m);
        if (entry.history.length > MAX_HISTORY) entry.history = entry.history.slice(-MAX_HISTORY);
      }
      break;
    }
    case 'thinking_start':
      entry.snapshot = { thinking: '', blocks: [] };
      entry.snapshotStartedAt = Date.now();
      break;
    case 'thinking_chunk':
      if (entry.snapshot) entry.snapshot.thinking += String(p.text ?? '');
      break;
    case 'text_chunk':
      if (entry.snapshot) {
        const last = entry.snapshot.blocks[entry.snapshot.blocks.length - 1];
        if (last?.type === 'text') (last as { type: 'text'; text: string }).text += String(p.text ?? '');
        else entry.snapshot.blocks.push({ type: 'text', text: String(p.text ?? '') });
      }
      break;
    case 'tool_start':
      if (entry.snapshot) entry.snapshot.blocks.push({ type: 'tool', call: p.call as ChannelTool });
      break;
    case 'tool_end': {
      if (!entry.snapshot) break;
      const callId = (p.call as ChannelTool | undefined)?.id;
      const b = callId ? entry.snapshot.blocks.find(x => x.type === 'tool' && x.call?.id === callId) : undefined;
      if (b) b.call = p.call as ChannelTool;
      break;
    }
    case 'user_inject':
      if (entry.snapshot) entry.snapshot.blocks.push({ type: 'user_inject', text: String(p.text ?? '') });
      break;
    case 'retry_status': {
      if (!entry.snapshot || typeof p.autoRetry !== 'number' || p.timedOut === true) break;
      const blocks = [...entry.snapshot.blocks];
      const content = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
      entry.history.push({
        id: nextMsgId(), role: 'assistant', content,
        thinking: entry.snapshot.thinking || undefined,
        blocks: blocks.length > 0 ? blocks : undefined, outcome: 'retried',
      });
      if (entry.history.length > MAX_HISTORY) entry.history = entry.history.slice(-MAX_HISTORY);
      entry.snapshot = { thinking: '', blocks: [] };
      entry.snapshotStartedAt = Date.now();
      break;
    }
    case 'done': {
      for (let i = 0; i < entry.history.length; i++) {
        if (entry.history[i].outcome === 'background_waiting') {
          entry.history[i] = { ...entry.history[i], outcome: 'background_done' };
        }
      }
      if (entry.snapshot) {
        const blocks = [...entry.snapshot.blocks];
        const content = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
        const hasBg = typeof p.pendingBackgroundTasks === 'number' && (p.pendingBackgroundTasks as number) > 0;
        entry.history.push({
          id: nextMsgId(), role: 'assistant', content,
          thinking: entry.snapshot.thinking || undefined,
          blocks: blocks.length > 0 ? blocks : undefined,
          outcome: hasBg ? 'background_waiting' : 'success',
        });
        if (entry.history.length > MAX_HISTORY) entry.history = entry.history.slice(-MAX_HISTORY);
        entry.snapshot = null;
        entry.snapshotStartedAt = null;
      }
      break;
    }
    case 'error':
      entry.snapshot = null;
      entry.snapshotStartedAt = null;
      entry.history.push({
        id: nextMsgId(), role: 'error',
        content: String(p.text ?? ''),
        errorKind: p.errorKind as string | undefined,
      });
      if (entry.history.length > MAX_HISTORY) entry.history = entry.history.slice(-MAX_HISTORY);
      break;
    case 'clear':
      entry.history = [];
      entry.snapshot = null;
      entry.snapshotStartedAt = null;
      entry.browsingClients.clear(); // fresh state: all clients re-enter live mode
      break;
    case 'retry_clean': {
      let i = entry.history.length - 1;
      while (i >= 0) {
        const m = entry.history[i];
        if (m.role === 'error') { entry.history.splice(i, 1); i--; }
        else if (m.role === 'assistant' && m.outcome === 'error') {
          entry.history[i] = { ...m, outcome: 'retried' }; break;
        } else break;
      }
      break;
    }
  }
  entry.lastActivityAt = Date.now();
}

function createBroadcastForEntry(entry: SessionEntry): (msg: string) => void {
  return function broadcast(msg: string): void {
    let parsed: Record<string, unknown> | undefined;
    try { parsed = JSON.parse(msg) as Record<string, unknown>; } catch {}
    if (parsed) applyMsg(entry, parsed);
    const gated = parsed ? SESSION_STREAM_EVENTS.has(parsed.type as string) : false;
    for (const ws of entry.clients) {
      if (ws.readyState === 1 && (!gated || !entry.browsingClients.has(ws))) {
        try { ws.send(msg); } catch { /* closing */ }
      }
    }
  };
}

function createEntry(cd: ChannelData, owner?: string): SessionEntry {
  const entry: SessionEntry = {
    key: nextEntryKey(),
    owner,
    state: createSessionState(cd.dir),
    clients: new Set(),
    browsingClients: new Set(),
    history: [],
    snapshot: null,
    snapshotStartedAt: null,
    lastActivityAt: Date.now(),
  };
  entry.state.broadcast = createBroadcastForEntry(entry);
  cd.entries.set(entry.key, entry);
  return entry;
}

function replaySnapshotToClient(entry: SessionEntry, ws: WebSocket): void {
  if (!entry.snapshot) return;
  try { ws.send(JSON.stringify({ type: 'thinking_start', reused: true, startedAt: entry.snapshotStartedAt ?? undefined })); } catch { return; }
  if (entry.snapshot.thinking) { try { ws.send(JSON.stringify({ type: 'thinking_chunk', text: entry.snapshot.thinking })); } catch { return; } }
  for (const block of entry.snapshot.blocks) {
    try {
      if (block.type === 'text') {
        ws.send(JSON.stringify({ type: 'text_chunk', text: block.text ?? '' }));
      } else if (block.type === 'tool') {
        ws.send(JSON.stringify({ type: 'tool_start', call: block.call }));
        if (block.call?.result !== undefined || block.call?.error) {
          ws.send(JSON.stringify({ type: 'tool_end', call: block.call }));
        }
      } else if (block.type === 'user_inject') {
        ws.send(JSON.stringify({ type: 'user_inject', text: block.text ?? '' }));
      }
    } catch { return; }
  }
}

function replayToClient(entry: SessionEntry, ws: WebSocket): void {
  try { ws.send(JSON.stringify({ type: 'sessionLoaded', id: entry.state.sessionId, messages: entry.history })); } catch { return; }
  replaySnapshotToClient(entry, ws);
}

// Pick the most recently active entry, or create a new one if none exist.
function defaultEntry(cd: ChannelData): SessionEntry {
  if (cd.entries.size === 0) return createEntry(cd);
  let best: SessionEntry | undefined;
  for (const entry of cd.entries.values()) {
    if (!best || entry.lastActivityAt > best.lastActivityAt) best = entry;
  }
  return best!;
}

// Move a client from its previous entry (if any) to a new target entry.
// Replays history to the client if the target entry already has state, unless
// skipReplay is true (used for deep-link live-attaches: webviewReady does the replay
// after React has mounted, so anything sent here would be dispatched before the App
// registers its message listener and would be lost).
function joinEntry(cd: ChannelData, ws: WebSocket, target: SessionEntry, skipReplay = false): void {
  const prev = cd.clientEntry.get(ws);
  if (prev && prev !== target) {
    prev.clients.delete(ws);
    prev.browsingClients.delete(ws);
    if (prev.clients.size === 0) scheduleEntryCleanup(cd, prev);
  }
  const needsReplay = !skipReplay && (target.clients.size > 0 || target.history.length > 0 || target.snapshot !== null);
  target.clients.add(ws);
  cd.clientEntry.set(ws, target);
  if (needsReplay) replayToClient(target, ws);
}

// When the last client leaves an entry, stop the watchdog (no one to receive events)
// and schedule eviction from the registry. The session proc is NOT killed - it runs to
// natural completion. Broadcasts from the proc go to zero clients (no-op) until it exits.
function scheduleEntryCleanup(cd: ChannelData, entry: SessionEntry): void {
  if (entry.state.watchdog?.state) {
    entry.state.watchdog.state.active = false;
    clearInterval(entry.state.watchdog.interval);
  }
  entry.state.resetStaleTimer?.();
  const t = setTimeout(() => {
    if (entry.clients.size === 0) {
      cd.entries.delete(entry.key);
      // Once evicted the entry is unreachable - no client can rejoin it - so its CLI
      // process would linger with nobody to receive its output. Reclaim it here, or
      // every abandoned session leaks a `claude` process for the life of the server.
      if (entry.state.currentProc) {
        killProc(entry.state.currentProc);
        entry.state.currentProc = undefined;
        entry.state.currentProcKey = undefined;
      }
      if (cd.entries.size === 0) registry.delete(cd.dir);
    }
  }, 30_000);
  if (typeof (t as unknown as { unref?(): void }).unref === 'function') {
    (t as unknown as { unref(): void }).unref();
  }
}

export function getOrCreateChannel(dir: string): Channel {
  let cd = registry.get(dir);
  if (!cd) {
    cd = { dir, entries: new Map(), clientEntry: new Map() };
    registry.set(dir, cd);
  }
  const _cd = cd;

  return {
    addClient(ws, fresh, sessionId, panelId) {
      if (sessionId) {
        for (const entry of _cd.entries.values()) {
          if (entry.state.sessionId === sessionId) {
            // Deep-link live-attach: skip the replay here. webviewReady sends it
            // after React mounts so the App's message listener is already registered.
            joinEntry(_cd, ws, entry, /* skipReplay */ true);
            return true;
          }
        }
      }
      if (panelId) {
        for (const entry of _cd.entries.values()) {
          if (entry.owner === panelId) {
            // Reconnect of a known panel (reload, daemon restart): rejoin its own entry.
            // Replay is deferred to webviewReady - the socket opens while the React
            // bundle is still evaluating, so an immediate replay would be dispatched
            // before App registers its message listener and would be lost.
            joinEntry(_cd, ws, entry, /* skipReplay */ true);
            return true;
          }
        }
        // First connect of this panel: its own entry, never the channel default.
        joinEntry(_cd, ws, createEntry(_cd, panelId));
        return false;
      }
      joinEntry(_cd, ws, fresh ? createEntry(_cd) : defaultEntry(_cd));
      return false;
    },
    removeClient(ws) {
      const entry = _cd.clientEntry.get(ws);
      _cd.clientEntry.delete(ws);
      if (!entry) return;
      entry.clients.delete(ws);
      entry.browsingClients.delete(ws);
      if (entry.clients.size === 0) scheduleEntryCleanup(_cd, entry);
    },
    getClientState(ws) {
      return (_cd.clientEntry.get(ws) ?? defaultEntry(_cd)).state;
    },
    moveToNewSession(ws) {
      // Hand the panel's ownership to the new entry, so a later reconnect rejoins the
      // new session rather than the abandoned one. The old entry keeps running for any
      // other clients, but is no longer any panel's reconnect target.
      const prev = _cd.clientEntry.get(ws);
      const owner = prev?.owner;
      if (prev) prev.owner = undefined;
      const newEntry = createEntry(_cd, owner);
      joinEntry(_cd, ws, newEntry);
      return newEntry.state;
    },
    setBrowsing(ws, browsing) {
      const entry = _cd.clientEntry.get(ws);
      if (!entry) return;
      if (browsing) entry.browsingClients.add(ws);
      else entry.browsingClients.delete(ws);
    },
    replaySnapshot(ws) {
      const entry = _cd.clientEntry.get(ws);
      if (entry) replaySnapshotToClient(entry, ws);
    },
    replayHistory(ws) {
      const entry = _cd.clientEntry.get(ws);
      if (!entry) return false;
      // An entry can be bound to a session without ever having streamed it: opening a
      // finished session by deep link loads it from disk, leaving the entry's in-memory
      // history empty. Replaying that empty history would clear the client's view, so
      // report "nothing to replay" and let the caller read the transcript instead.
      if (entry.history.length === 0 && !entry.snapshot) return false;
      replayToClient(entry, ws);
      return true;
    },
  };
}

// Exposed for tests to force-evict a channel without waiting for the grace period.
export function destroyChannel(dir: string): void {
  registry.delete(dir);
}
