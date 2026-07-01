import type { WebSocket } from 'ws';
import { createSessionState, type SessionState } from './sessionState';

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
  'retry_status', 'retry_clean', 'contextUsage',
]);

// One SessionEntry per running (or recently-ran) session within a workspace.
// Clients connect to the most recently active entry; newSession creates a fresh one.
interface SessionEntry {
  readonly key: string;
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
  /** Add a client: joins the most recently active entry and receives a history replay. */
  addClient(ws: WebSocket): void;
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
  /** Send a message to every client across ALL session entries in this channel. */
  broadcastToAll(msg: string): void;
  /** Call fn for each session entry's state (e.g. to update a shared setting). */
  forEachSession(fn: (state: SessionState) => void): void;
}

const registry = new Map<string, ChannelData>();
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

function createEntry(cd: ChannelData): SessionEntry {
  const entry: SessionEntry = {
    key: nextEntryKey(),
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
  ws.send(JSON.stringify({ type: 'thinking_start', reused: true, startedAt: entry.snapshotStartedAt ?? undefined }));
  if (entry.snapshot.thinking) ws.send(JSON.stringify({ type: 'thinking_chunk', text: entry.snapshot.thinking }));
  for (const block of entry.snapshot.blocks) {
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
  }
}

function replayToClient(entry: SessionEntry, ws: WebSocket): void {
  ws.send(JSON.stringify({ type: 'sessionLoaded', id: entry.state.sessionId, messages: entry.history }));
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
// Replays history to the client if the target entry already has state.
function joinEntry(cd: ChannelData, ws: WebSocket, target: SessionEntry): void {
  const prev = cd.clientEntry.get(ws);
  if (prev && prev !== target) {
    prev.clients.delete(ws);
    prev.browsingClients.delete(ws);
    if (prev.clients.size === 0) scheduleEntryCleanup(cd, prev);
  }
  const needsReplay = target.clients.size > 0 || target.history.length > 0 || target.snapshot !== null;
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
    addClient(ws) {
      joinEntry(_cd, ws, defaultEntry(_cd));
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
      const newEntry = createEntry(_cd);
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
    broadcastToAll(msg) {
      const sent = new Set<WebSocket>();
      for (const entry of _cd.entries.values()) {
        for (const ws of entry.clients) {
          if (ws.readyState === 1 && !sent.has(ws)) {
            try { ws.send(msg); } catch { /* closing */ }
            sent.add(ws);
          }
        }
      }
    },
    forEachSession(fn) {
      for (const entry of _cd.entries.values()) fn(entry.state);
    },
  };
}

// Exposed for tests to force-evict a channel without waiting for the grace period.
export function destroyChannel(dir: string): void {
  registry.delete(dir);
}
