import { selectionFor } from './providers/store';
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
  type: 'text' | 'tool' | 'user_inject' | 'bg_notice';
  text?: string;
  call?: ChannelTool;
  notice?: Record<string, unknown>;
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
  // Carried so a client that joins mid-watch replays the same footnote, elapsed time and all,
  // instead of a bare "1 background task still running" with the count and clock guessed.
  bgTasksPending?: number;
  bgTasksSince?: number;
}

// Session-streaming events: browsing clients (those that navigated away to a different
// session via resumeSession) do not receive these. Control events (clear, modelChanged,
// log, etc.) are NOT in this set and reach all clients regardless of browsing state.
const SESSION_STREAM_EVENTS = new Set([
  'providerSelection', 'interaction',
  'thinking_start', 'thinking_chunk', 'text_chunk', 'tool_start', 'tool_end',
  'done', 'error', 'message', 'user_inject', 'token_update',
  // 'sessionId' belongs to the live turn: a browsing client is viewing a different
  // transcript, so it must not have its address bar rewritten to this one.
  // 'bgTasks' likewise counts this entry's tasks, not the ones of the session on screen.
  // 'bg_notice' opens a turn in this entry, so it travels with that turn's own events.
  'retry_status', 'retry_clean', 'contextUsage', 'sessionId', 'bgTasks', 'bg_notice',
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
  // Mirrors the webview reducer's own pendingNotice: a background task reports in before
  // the turn it starts exists, so the marker waits here for the thinking_start that opens
  // the snapshot. Without it a client joining mid-turn replays the answer with no cause.
  pendingNotice?: Record<string, unknown>;
  snapshotStartedAt: number | null;
  lastActivityAt: number;
}

// Internal per-workspace-dir channel data.
interface ChannelData {
  readonly dir: string;
  entries: Map<string, SessionEntry>;
  clientEntry: Map<WebSocket, SessionEntry>;
  // Session a browsing client actually has on screen. Its entry keeps pointing at the
  // session being streamed (so the live turn's --resume arg stays correct), which makes
  // this the only record of what the user is looking at - and the only way a send from
  // that client can be routed to the session it belongs to instead of injected into
  // the turn it walked away from.
  clientViewing: Map<WebSocket, string>;
  // The last sessionId a given panel's entry held, kept across full entry eviction.
  // A panel-owned entry is normally the ONLY reconnect target for that panel (addClient
  // rejoins by owner), so once it is evicted (idle-closed connection, or a manual
  // disconnect nobody clicked Reconnect on within the 30s grace window) a later
  // reconnect would otherwise create a brand-new entry with an empty sessionId - the
  // user's next message would silently start a fresh CLI conversation instead of
  // resuming, even though their old transcript is still sitting on screen (the webview
  // never clears it on disconnect). This is what reapIdleCliProcs already guarantees
  // one layer down (killing the process but keeping sessionId); here it has to survive
  // the whole entry going away, not just the process.
  ownerLastSession: Map<string, string>;
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
  /** Mark a client as browsing (will not receive SESSION_STREAM_EVENTS) or live.
   *  When browsing, pass the session the client navigated to: the entry still points at
   *  the streaming one, so this is what makes the client's own view recoverable. */
  setBrowsing(ws: WebSocket, browsing: boolean, sessionId?: string): void;
  /** The session this client is browsing, if any. The entry's own sessionId still points
   *  at the streaming session, so this is the only record of what is on the client's
   *  screen - and therefore which transcript a tool-image request must be read from. */
  getViewingSessionId(ws: WebSocket): string | undefined;
  /** Move a browsing client into its own entry, bound to the session it is viewing, and
   *  return that entry's state. Undefined when the client is not browsing. Lets a send
   *  start a turn on the session that is on screen instead of being injected into the
   *  stdin of the turn still running in the entry the client left. */
  detachToBrowsedSession(ws: WebSocket): SessionState | undefined;
  /** Join the entry that is streaming this session right now, replaying its history and
   *  in-progress snapshot so the live turn (and its progress indicator) is restored.
   *  Undefined when no OTHER entry is mid-turn on that session - including when the
   *  client is already in it, which the caller handles as an ordinary resume. */
  attachToLiveSession(ws: WebSocket, sessionId: string): SessionState | undefined;
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
// A session is "in progress" while its entry holds a live CLI process that has not
// reported the end of the turn. `currentProc` alone is not enough: a finished turn
// keeps its process alive so the next send can reuse it, and `!cliDone` alone is not
// enough either (a fresh entry starts with cliDone false and no process at all).
export interface ActiveSession {
  id: string;
  workspacePath: string;
  startedAt: number;
}

// Every session running anywhere in this server process, across all workspaces: a
// turn started in one panel shows as busy in every other panel's history list.
// Sessions the CLI has not yet named (sessionId arrives with its first event) are
// skipped - there is no history row to mark until then.
export function listActiveSessions(): ActiveSession[] {
  const out: ActiveSession[] = [];
  for (const cd of registry.values()) {
    for (const entry of cd.entries.values()) {
      const st = entry.state;
      if (st.sessionId && (st.runtime?.active || st.currentProc && !st.cliDone)) {
        out.push({ id: st.sessionId, workspacePath: cd.dir, startedAt: entry.snapshotStartedAt ?? entry.lastActivityAt });
      }
    }
  }
  return out;
}

export interface OwnedProc {
  /** Empty until the CLI names the session. */
  sessionId: string;
  /** The entry is mid-turn right now - same test listActiveSessions uses. */
  running: boolean;
  /** Last event from this session, the clock used by the idle CLI reaper. */
  lastActivityAt: number;
}

// Every CLI process this server currently holds, across all workspaces, mapped to the
// session it is serving and whether that session is mid-turn. On Windows these are the
// cmd.exe shells the CLI is spawned through (`shell: IS_WIN`), not the claude.exe
// itself - a caller matching them against a process listing has to accept a child of
// one of these too. The session comes from here rather than from the process's own
// --resume argument because a brand-new session has no such argument at all, and
// `running` can ONLY come from here: a process listing cannot tell a CLI waiting for
// input from one working, and the transcript's mtime cannot either (it is written at
// message boundaries, not continuously).
export function listOwnedProcs(): Map<number, OwnedProc> {
  const owned = new Map<number, OwnedProc>();
  for (const cd of registry.values()) {
    for (const entry of cd.entries.values()) {
      const st = entry.state;
      const pid = st.runtime?.pid ?? st.currentProc?.pid;
      if (pid) owned.set(pid, { sessionId: st.sessionId ?? '', running: !!(st.runtime?.active || st.currentProc && !st.cliDone), lastActivityAt: entry.lastActivityAt });
    }
  }
  return owned;
}

export interface ClientChannelInfo {
  workspacePath: string;
  /** Empty until the CLI names the session. */
  sessionId?: string;
  /** A different transcript this client navigated to (Session History browse). */
  viewingSessionId?: string;
  /** The entry this client sits in is mid-turn - same test listOwnedProcs uses. */
  running: boolean;
  /** Unix ms this entry last did anything - the same clock reapIdleClients reads. */
  lastActivityAt: number;
}

// Where one connection sits: which workspace channel and session entry it joined, what
// it has on screen if it navigated away, and whether that entry is working right now.
// The registry is keyed by workspace, so this is a scan over a handful of channels.
export function clientChannelInfo(ws: WebSocket): ClientChannelInfo | undefined {
  for (const cd of registry.values()) {
    const entry = cd.clientEntry.get(ws);
    if (!entry) continue;
    const st = entry.state;
    return {
      workspacePath: cd.dir,
      sessionId: st.sessionId || undefined,
      viewingSessionId: cd.clientViewing.get(ws),
      running: !!(st.runtime?.active || st.currentProc && !st.cliDone),
      lastActivityAt: entry.lastActivityAt,
    };
  }
  return undefined;
}

export interface ReapedProc {
  pid: number;
  sessionId: string;
  workspacePath: string;
  /** How long it had been idle when it was reaped, in ms. */
  idleMs: number;
}

// Terminates CLI processes THIS server is holding that have sat idle past `idleMs`.
// A finished turn deliberately keeps its process so the next send can reuse it, which
// costs ~250MB of resident memory per abandoned panel for as long as the server lives;
// this reclaims it. The session id is kept, so the next send simply respawns with
// `--resume` and the conversation continues - the only cost is a slower first turn.
//
// It never touches a process that is mid-turn (`!cliDone`), and that is not merely
// politeness: killing a CLI whose transcript ends on an unanswered user message makes
// the next `--resume` splice a synthetic "No response requested." assistant turn into
// the conversation, which the model then sees forever (see
// !notes/tasks/no-response-requested/notes.md). An idle process has already answered,
// so its transcript ends on an assistant record and no repair is triggered.
export function reapIdleCliProcs(idleMs: number, now: number = Date.now()): ReapedProc[] {
  const reaped: ReapedProc[] = [];
  if (!(idleMs > 0)) return reaped;

  for (const cd of registry.values()) {
    for (const entry of cd.entries.values()) {
      const st = entry.state;
      // No process to reclaim, or one that is still working.
      if (st.runtime && !st.currentProc) {
        const idle = now - entry.lastActivityAt;
        if (!st.runtime.active && idle >= idleMs) {
          const pid = st.runtime.pid ?? 0;
          st.runtime.dispose(); st.runtime = undefined;
          st.sendLog?.('info', `Reaped idle CLI (pid ${pid}, idle ${Math.round(idle / 1000)}s) - the next message starts a fresh one`);
          reaped.push({ pid, sessionId: st.sessionId ?? '', workspacePath: cd.dir, idleMs: idle });
        }
        continue;
      }
      if (!st.currentProc || !st.cliDone) continue;
      const idle = now - entry.lastActivityAt;
      if (idle < idleMs) continue;

      const proc = st.currentProc;
      // Detach before kill, as everywhere else here: the close event lands a beat later
      // and must not mutate an entry that no longer owns this process.
      st.currentProc = undefined;
      st.currentProcKey = undefined;
      killProc(proc);
      st.sendLog?.('info', `Reaped idle CLI (pid ${proc.pid}, idle ${Math.round(idle / 1000)}s) - the next message starts a fresh one`);
      reaped.push({ pid: proc.pid ?? 0, sessionId: st.sessionId ?? '', workspacePath: cd.dir, idleMs: idle });
    }
  }
  return reaped;
}

// Close code for a connection this server closed on its own because it sat idle too
// long - distinct from CLOSE_CODE_DISCONNECTED (clients.ts, 4001), which is a deliberate
// "another panel logged you out" action. Both are terminal (the bridge must not silently
// reconnect a socket the server just closed on purpose), but only this one is meant to
// come back on its own once the panel is looked at again; a peer disconnect stays down
// until a manual click. Kept as its own code (not reused) so server logs and tests can
// tell the two reasons apart even though the client treats them similarly.
export const CLOSE_CODE_IDLE = 4002;

export interface ReapedClient {
  workspacePath: string;
  sessionId: string;
  clientsClosed: number;
  /** How long the entry had been idle when it was reaped, in ms. */
  idleMs: number;
}

// Closes every client of a session entry THIS server holds that has sat idle past
// `idleMs` - the same clock and the same "never touch a mid-turn entry" rule as
// reapIdleCliProcs above, one layer up: that one reclaims a finished process's memory,
// this one reclaims the connection (and, once the existing 30s grace timer runs out with
// no reconnect, the entry itself - history, snapshot, any lingering process).
//
// The closed socket does not silently reconnect (see CLOSE_CODE_IDLE) - if it did, the
// very next sweep would see the same still-idle entry and close it again, since simply
// rejoining does not touch lastActivityAt. It comes back only when the client decides to
// (panel/tab looked at again, or a manual Reconnect), at which point the ownerLastSession
// map (below, in scheduleEntryCleanup and addClient) is what keeps the conversation
// resumable even if the entry itself already evicted by then.
export function reapIdleClients(idleMs: number, now: number = Date.now()): ReapedClient[] {
  const reaped: ReapedClient[] = [];
  if (!(idleMs > 0)) return reaped;

  for (const cd of registry.values()) {
    for (const entry of cd.entries.values()) {
      // No clients to close - already on its way out via the ordinary grace timer.
      if (entry.clients.size === 0) continue;
      const st = entry.state;
      if ((st.runtime?.active || st.currentProc && !st.cliDone)) continue; // mid-turn, never touch
      const idle = now - entry.lastActivityAt;
      if (idle < idleMs) continue;

      let closed = 0;
      for (const ws of entry.clients) {
        if (ws.readyState !== 1) continue;
        try {
          ws.close(CLOSE_CODE_IDLE, 'Idle connection closed to save resources');
          closed++;
        } catch { /* already closing */ }
      }
      if (closed > 0) {
        st.sendLog?.('info', `Closed ${closed} idle connection(s) (idle ${Math.round(idle / 1000)}s)`);
        reaped.push({ workspacePath: cd.dir, sessionId: st.sessionId ?? '', clientsClosed: closed, idleMs: idle });
      }
    }
  }
  return reaped;
}

// Broadcast types that can flip a session between running and idle.
const ACTIVITY_EVENTS = new Set(['thinking_start', 'done', 'error', 'sessionId', 'clear']);

let activeNotifyTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivePayload = '';

// Push the running set to every client. Deferred onto a timer so it reads the state
// flags after the handler that triggered it has finished mutating them, coalescing
// the burst of events at a turn boundary into one message; a set that did not
// actually change sends nothing.
export function notifyActiveSessions(): void {
  if (activeNotifyTimer) return;
  activeNotifyTimer = setTimeout(() => {
    activeNotifyTimer = null;
    const payload = JSON.stringify({ type: 'activeSessions', sessions: listActiveSessions() });
    if (payload === lastActivePayload) return;
    lastActivePayload = payload;
    broadcastToAllChannels(payload);
  }, 0);
  if (typeof (activeNotifyTimer as unknown as { unref?(): void }).unref === 'function') {
    (activeNotifyTimer as unknown as { unref(): void }).unref();
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
        if (m.role === 'user') entry.pendingNotice = undefined;
        entry.history.push(m);
        if (entry.history.length > MAX_HISTORY) entry.history = entry.history.slice(-MAX_HISTORY);
      }
      break;
    }
    case 'thinking_start':
      entry.snapshot = { thinking: '', blocks: entry.pendingNotice ? [{ type: 'bg_notice', notice: entry.pendingNotice }] : [] };
      entry.pendingNotice = undefined;
      entry.snapshotStartedAt = Date.now();
      break;
    case 'bg_notice': {
      const notice = p.notice as Record<string, unknown> | undefined;
      if (!notice) break;
      if (entry.snapshot) entry.snapshot.blocks.push({ type: 'bg_notice', notice });
      else entry.pendingNotice = notice;
      break;
    }
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
      if (!entry.snapshot || (typeof p.autoRetry !== 'number' && p.errorRetry !== true) || p.timedOut === true) break;
      const blocks = [...entry.snapshot.blocks];
      const content = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
      if (p.errorRetry !== true || blocks.length > 0 || entry.snapshot.thinking) entry.history.push({
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
          bgTasksPending: hasBg ? p.pendingBackgroundTasks as number : undefined,
          bgTasksSince: hasBg ? p.backgroundTasksSince as number | undefined : undefined,
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
    if (parsed && ACTIVITY_EVENTS.has(parsed.type as string)) notifyActiveSessions();
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
  try { ws.send(JSON.stringify({ type: 'providerSelection', ...entry.state.selection })); } catch { return; }
  try { ws.send(JSON.stringify({ type: 'sessionLoaded', id: entry.state.sessionId, messages: entry.history })); } catch { return; }
  replaySnapshotToClient(entry, ws);
  if (entry.state.interaction) ws.send(JSON.stringify({ type: 'interaction', request: entry.state.interaction }));
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
  entry.state.errorRetry?.cancel(true);
  if (entry.state.watchdog?.state) {
    entry.state.watchdog.state.active = false;
    clearInterval(entry.state.watchdog.interval);
  }
  entry.state.resetStaleTimer?.();
  const t = setTimeout(() => {
    if (entry.clients.size === 0) {
      // Remember what this panel was last on before the entry (and its sessionId)
      // disappears, so a reconnect long after the grace window still resumes instead of
      // silently starting a blank conversation. Synced rather than only-set-if-present:
      // an entry with no sessionId (e.g. "New chat" clicked, then abandoned before
      // anything was sent) must clear a stale mapping too, or a much-later reconnect
      // would resurrect a conversation the user explicitly moved on from.
      if (entry.owner) {
        if (entry.state.sessionId) cd.ownerLastSession.set(entry.owner, entry.state.sessionId);
        else cd.ownerLastSession.delete(entry.owner);
      }
      if (entry.state.runtime?.active || entry.state.currentProc && !entry.state.cliDone) { scheduleEntryCleanup(cd, entry); return; }
      cd.entries.delete(entry.key);
      entry.state.runtime?.dispose(); entry.state.runtime = undefined;
      // Once evicted the entry is unreachable - no client can rejoin it - so its CLI
      // process would linger with nobody to receive its output. Reclaim it here, or
      // every abandoned session leaks a `claude` process for the life of the server.
      if (entry.state.currentProc) {
        killProc(entry.state.currentProc);
        entry.state.currentProc = undefined;
        entry.state.currentProcKey = undefined;
        // An evicted entry can be mid-turn, so its row must stop showing as running.
        notifyActiveSessions();
      }
      if (cd.entries.size === 0 && cd.ownerLastSession.size === 0) registry.delete(cd.dir);
    }
    // Read per call, not captured at import: a reused test worker that set the env
    // override for one spec must not leak a shortened grace period into every other
    // spec that happens to load this module afterward in the same process.
  }, Number(process.env.ARGUS_ENTRY_GRACE_MS) || 30_000);
  if (typeof (t as unknown as { unref?(): void }).unref === 'function') {
    (t as unknown as { unref(): void }).unref();
  }
}

export function getOrCreateChannel(dir: string): Channel {
  let cd = registry.get(dir);
  if (!cd) {
    cd = { dir, entries: new Map(), clientEntry: new Map(), clientViewing: new Map(), ownerLastSession: new Map() };
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
        // First connect of this panel, or a reconnect that arrived after its old entry
        // was already evicted (idle-closed, or a disconnect nobody clicked Reconnect on
        // within the grace window): either way there is no live entry to rejoin, so a
        // fresh one is created - but if this panel had a real session before, seed it
        // here rather than leaving it blank, so the next send still resumes with
        // --resume instead of silently starting over. No history to replay (a fresh
        // entry has none), which is fine: the client's own view of the old transcript
        // is still on screen from before the disconnect.
        const fresh = createEntry(_cd, panelId);
        const lastSession = _cd.ownerLastSession.get(panelId);
        if (lastSession) { fresh.state.sessionId = lastSession; fresh.state.selection = selectionFor(lastSession, dir); }
        joinEntry(_cd, ws, fresh);
        return false;
      }
      joinEntry(_cd, ws, fresh ? createEntry(_cd) : defaultEntry(_cd));
      return false;
    },
    removeClient(ws) {
      const entry = _cd.clientEntry.get(ws);
      _cd.clientEntry.delete(ws);
      _cd.clientViewing.delete(ws);
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
      _cd.clientViewing.delete(ws);
      return newEntry.state;
    },
    setBrowsing(ws, browsing, sessionId) {
      const entry = _cd.clientEntry.get(ws);
      if (!entry) return;
      if (browsing) {
        entry.browsingClients.add(ws);
        if (sessionId) _cd.clientViewing.set(ws, sessionId);
      } else {
        entry.browsingClients.delete(ws);
        _cd.clientViewing.delete(ws);
      }
    },
    getViewingSessionId(ws) {
      return _cd.clientViewing.get(ws);
    },
    detachToBrowsedSession(ws) {
      const viewing = _cd.clientViewing.get(ws);
      if (!viewing) return undefined;
      // Ownership follows the client, exactly as in moveToNewSession: a later reconnect
      // must rejoin the session the user is actually in, not the one it walked away from.
      const prev = _cd.clientEntry.get(ws);
      const owner = prev?.owner;
      if (prev) prev.owner = undefined;
      const entry = createEntry(_cd, owner);
      // joinEntry drops the client from the old entry's browsingClients, and the new
      // entry is empty, so it replays nothing - the client already has this transcript
      // on screen from the sessionLoaded that put it into browsing mode.
      joinEntry(_cd, ws, entry);
      entry.state.sessionId = viewing;
      entry.state.selection = selectionFor(viewing, dir);
      _cd.clientViewing.delete(ws);
      return entry.state;
    },
    attachToLiveSession(ws, sessionId) {
      const current = _cd.clientEntry.get(ws);
      for (const entry of _cd.entries.values()) {
        // Already in it: an ordinary return-to-live resume, which the caller replays
        // itself. Only a session running in a DIFFERENT entry needs a move.
        if (entry === current) continue;
        const st = entry.state;
        if (st.sessionId === sessionId && (st.runtime?.active || st.currentProc && !st.cliDone)) {
          // joinEntry replays this entry's history and streaming snapshot, which is what
          // brings the progress indicator back and resumes the flow of output.
          joinEntry(_cd, ws, entry);
          _cd.clientViewing.delete(ws);
          return st;
        }
      }
      return undefined;
    },
    replaySnapshot(ws) {
      const entry = _cd.clientEntry.get(ws);
      if (entry) { replaySnapshotToClient(entry, ws); if (entry.state.interaction) ws.send(JSON.stringify({ type: 'interaction', request: entry.state.interaction })); }
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
