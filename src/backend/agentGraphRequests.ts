import * as path from 'path';
import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';
import { CONFIG_PATH } from './config';
import { AgentGraph, type StoredGraph, type GraphNode } from './agentGraph';
import { bounded, name, sessionId, choice, kinds, type EdgeKind } from './agentGraphValidation';
import { listAgentStates, findAgentState } from './channel';
import { onAgentGraphChange, projectAgentState } from './agentGraphLive';
import { provider } from './providers/registry';

interface Filter { company?: string; goal?: string }
interface Revision { epoch: string; seq: number }
type Snapshot = ReturnType<AgentGraphService['filter']>;
const subscribersLimit = 256;
export class AgentGraphService {
  private stored: StoredGraph;
  private epoch = randomUUID(); private seq = 0; private signature = '';
  private timer?: NodeJS.Timeout;
  private publishing = false; private dirty = false; private closed = false;
  private subscriptions = new Map<WebSocket, { filter: Filter; snapshot?: Snapshot }>();
  private closeHandlers = new Map<WebSocket, () => void>();
  private unsubscribe: (() => void)[];
  private titles = new Map<string, string>();
  private knownIds = new Set<string>();
  private refreshing?: Promise<Snapshot>;
  constructor(readonly store: AgentGraph, private states = listAgentStates,
    private readTitles = async (providerId: string, workspace: string) => provider(providerId).list(workspace)) {
    this.stored = store.snapshot();
    this.unsubscribe = [store.onChange(() => { this.stored = store.snapshot(); this.schedule(); }), onAgentGraphChange((state, event) => {
      if (state?.sessionId && (event?.type === 'done' || event?.type === 'error' || event?.type === 'interaction' && event.request)
        && this.stored.edges.some(e => e.to === state.sessionId && e.forward?.awaitingReply)) store.resolveForward(state.sessionId);
      if (event?.type === 'sessionRenamed' && typeof event.id === 'string') {
        if (!this.knownIds.has(event.id)) return;
        if (typeof event.title === 'string') this.titles.set(event.id, event.title.slice(0, 200)); else this.titles.delete(event.id);
      }
      if (state?.sessionId && (event?.type === 'sessionId' || event?.type === 'sessionAttached')) this.titles.delete(state.sessionId);
      this.schedule();
    })];
  }
  capability() { return { version: 1, storeId: this.stored.storeId, orchestration: 1 }; }
  private async refreshTitles(nodes: GraphNode[], force = false) {
    const needed = nodes.filter(node => force || !this.titles.has(node.id));
    const known = new Set(needed.map(node => node.id));
    const groups = new Map<string, { providerId: string; workspace: string }>();
    for (const node of needed) {
      this.titles.set(node.id, node.title);
      groups.set(JSON.stringify([node.providerId, node.workspace]), { providerId: node.providerId, workspace: node.workspace });
    }
    const queue = [...groups.values()];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let group = queue.shift(); group; group = queue.shift()) {
        try { for (const session of await this.readTitles(group.providerId, group.workspace)) if (known.has(session.id)) this.titles.set(session.id, session.title.slice(0, 200)); }
        catch { /* Stored metadata is a fallback, never a reason to start execution. */ }
      }
    }));
  }
  private async current() {
    // Frequent status/stream updates consume memory facts, never native history.
    const stored = this.stored; const states = this.states();
    const ids = new Set(stored.nodes.map(n => n.id)); for (const id of this.titles.keys()) if (!ids.has(id)) this.titles.delete(id);
    this.knownIds = ids;
    const nodes = stored.nodes.map(node => ({ ...node, title: this.titles.get(node.id) ?? node.title, ...projectAgentState(states.find(s => s.sessionId === node.id)) }));
    const value = { ...stored, nodes };
    const signature = JSON.stringify(value); if (Buffer.byteLength(signature) > 4 * 1024 * 1024) throw Error('graph_snapshot_limit');
    if (signature !== this.signature) { this.signature = signature; this.seq++; }
    return { ...value, revision: { epoch: this.epoch, seq: this.seq } };
  }
  private refresh(): Promise<Snapshot> {
    return this.refreshing ?? (this.refreshing = this.current().finally(() => { this.refreshing = undefined; }));
  }
  filter(snapshot: Omit<StoredGraph, 'nodes'> & { nodes: (StoredGraph['nodes'][number] & ReturnType<typeof projectAgentState>)[]; revision: Revision }, filter: Filter = {}) {
    const matches = (company: string, goal: string) => (!filter.company || company === filter.company) && (!filter.goal || goal === filter.goal);
    const scopes = snapshot.scopes.filter(s => matches(s.company, s.goal));
    const members = new Set(scopes.flatMap(s => s.data ? [...Object.values(s.data.workers).map(w => w.sessionId), s.data.coordinatorConfiguration?.sessionId] : []).filter((id): id is string => typeof id === 'string'));
    const nodes = snapshot.nodes.filter(n => matches(n.company, n.goal) || members.has(n.id)); const ids = new Set(nodes.map(n => n.id));
    return { ...snapshot, nodes, edges: snapshot.edges.filter(e => ids.has(e.from) && ids.has(e.to)), scopes };
  }
  private send(ws: WebSocket, value: object) {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > 1024 * 1024) { ws.close(1009, 'Graph client is too slow'); return; }
    ws.send(JSON.stringify(value));
  }
  async get(ws: WebSocket, requestId: string, filter: Filter, subscribe: boolean, observedId?: string): Promise<void> {
    if (subscribe && !this.subscriptions.has(ws) && this.subscriptions.size >= subscribersLimit) throw Error('graph_busy');
    let subscription = this.subscriptions.get(ws);
    const initialSubscription = subscribe && !subscription;
    if (subscribe) {
      if (!subscription) {
        subscription = { filter }; this.subscriptions.set(ws, subscription);
        const close = () => { this.subscriptions.delete(ws); this.closeHandlers.delete(ws); };
        this.closeHandlers.set(ws, close); ws.once('close', close);
      }
      subscription.filter = filter; subscription.snapshot = undefined;
    } else this.detach(ws);
    try {
      const relevant = this.filter(await this.refresh(), filter);
      await this.refreshTitles(relevant.nodes, initialSubscription);
      const snapshot = this.filter(await this.refresh(), filter);
      const state = observedId ? this.states().find(s => s.sessionId === observedId) : undefined;
      const observation = observedId ? { sessionId: observedId, ...projectAgentState(state),
        ...(state ? { providerId: state.selection.providerId, workspace: state.workspaceDir } : {}) } : undefined;
      this.send(ws, { type: 'agentGraph', requestId, ok: true, snapshot, ...(observation ? { observation } : {}) });
      if (subscribe && this.subscriptions.get(ws) === subscription) { subscription!.snapshot = snapshot; this.schedule(); }
    } catch (error) { if (subscribe) this.detach(ws); throw error; }
  }
  private schedule() {
    this.dirty = true;
    if (this.closed || this.timer || this.publishing || !this.subscriptions.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined; this.publishing = true; this.dirty = false;
      void this.publish().catch(() => {
        for (const ws of this.subscriptions.keys()) this.send(ws, { type: 'agentGraph', ok: false, error: { code: 'graph_refresh_failed', message: 'Refresh the graph snapshot' } });
      }).finally(() => { this.publishing = false; if (this.dirty) this.schedule(); });
    }, 25); this.timer.unref();
  }
  private async publish() {
    const base = await this.refresh(); const visible = new Map<string, GraphNode>();
    for (const sub of this.subscriptions.values()) for (const node of this.filter(base, sub.filter).nodes) visible.set(node.id, node);
    await this.refreshTitles([...visible.values()]);
    const current = await this.refresh();
    for (const [ws, sub] of this.subscriptions) {
      const before = sub.snapshot; if (!before) continue;
      const after = this.filter(current, sub.filter);
      const upsert: Record<string, unknown[]> = {}, remove: Record<string, string[]> = {};
      for (const key of ['nodes', 'edges', 'scopes'] as const) {
        const id = (v: unknown) => { const item = v as { id?: string; company?: string; goal?: string }; return item.id ?? JSON.stringify([item.company, item.goal]); };
        const old = new Map(before[key].map(value => [id(value), JSON.stringify(value)]));
        const now = new Set(after[key].map(id)); upsert[key] = after[key].filter(v => old.get(id(v)) !== JSON.stringify(v)); remove[key] = [...old.keys()].filter(id => !now.has(id));
      }
      if (Object.values(upsert).some(v => v.length) || Object.values(remove).some(v => v.length)) {
        this.send(ws, { type: 'agentGraph', baseRevision: before.revision, revision: after.revision, upsert, remove }); sub.snapshot = after;
      }
    }
  }
  private detach(ws: WebSocket) { const close = this.closeHandlers.get(ws); if (close) ws.removeListener('close', close); this.closeHandlers.delete(ws); this.subscriptions.delete(ws); }
  dispose() { this.closed = true; if (this.timer) clearTimeout(this.timer); for (const remove of this.unsubscribe) remove(); for (const ws of this.subscriptions.keys()) this.detach(ws); }
}
let service: AgentGraphService | undefined;
export function agentGraphService(): AgentGraphService {
  return service ??= new AgentGraphService(new AgentGraph(process.env.ARGUS_GRAPH_DB || path.join(path.dirname(CONFIG_PATH), 'agent-graph.sqlite')));
}
export async function handleAgentGraphRequest(ws: WebSocket, message: Record<string, unknown>): Promise<boolean> {
  if (!['linkAgents', 'unlinkAgents', 'getAgentGraph', 'setAgentEdgePush'].includes(String(message.type))) return false;
  const requestId = typeof message.requestId === 'string' && message.requestId.length <= 128 ? message.requestId : undefined;
  try {
    if (!requestId) throw Error('graph_invalid_request'); const graph = agentGraphService();
    if (message.type === 'getAgentGraph') {
      if (message.subscribe !== undefined && typeof message.subscribe !== 'boolean') throw Error('graph_invalid_request');
      await graph.get(ws, requestId, { ...(message.company === undefined ? {} : { company: name(message.company) }), ...(message.goal === undefined ? {} : { goal: name(message.goal) }) }, message.subscribe === true, message.sessionId === undefined ? undefined : sessionId(message.sessionId));
    } else {
      const parent = sessionId(message.parent), child = sessionId(message.child), kind = choice(message.kind, kinds);
      const supplied = message.agentToken !== undefined; const caller = supplied ? findAgentState(message.agentToken) : undefined;
      if (supplied) {
        if (!caller?.sessionId || (kind === 'peer' ? ![parent, child].includes(caller.sessionId) : parent !== caller.sessionId)) throw Error('graph_forbidden');
        if (message.nodes !== undefined) throw Error('graph_forbidden');
        if (message.type === 'linkAgents' && kind !== 'peer' && !graph.store.snapshot().edges.some(e => e.from === parent && e.to === child && e.kind === kind)) throw Error('graph_assignment_required');
      }
      if (message.type === 'setAgentEdgePush') {
        graph.store.configurePush(parent, child, kind, message.push, message.expectedStoreRevision as number);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'agentGraph', requestId, ok: true }));
      } else if (message.type === 'linkAgents') {
        const nodes = message.nodes === undefined ? [] : message.nodes;
        if (!Array.isArray(nodes) || nodes.length > 2 || nodes.some(n => ![parent, child].includes((n as { id?: string })?.id ?? ''))) throw Error('graph_invalid_nodes');
        const edge = graph.store.link(parent, child, kind as EdgeKind, nodes, message.role === undefined ? undefined : bounded(message.role, 40));
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'agentGraph', requestId, ok: true, edge }));
      } else { graph.store.unlink(parent, child, kind as EdgeKind); if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'agentGraph', requestId, ok: true })); }
    }
  } catch (error) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'agentGraph', requestId, ok: false, error: { code: error instanceof Error && /^graph_|^invalid_graph_/.test(error.message) ? error.message : 'graph_request_failed', message: 'Cannot apply graph request' } }));
  }
  return true;
}
