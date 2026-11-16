import type { WebSocket } from 'ws';
import type { Channel } from './channel';
import { findAgentState, acquireSessionEntry } from './channel';
import type { SessionState } from './sessionState';
import type { AgentGraph, GraphNode } from './agentGraph';
import { name, scopeDocument, worker, integer, type WorkerBinding } from './agentGraphValidation';
import { onAgentGraphChange } from './agentGraphLive';
import { sameWorkspace } from './providers/store';

interface Reservation { ws: WebSocket; state: SessionState; caller?: SessionState; token?: unknown; company: string; goal: string; key: string; fresh: boolean; registered: boolean; binding?: WorkerBinding; revision?: number; off?: () => void; close(): void }
const reservations = new Map<string, Reservation>();
const bySocket = new WeakMap<WebSocket, Reservation>();
const commandOwners = new Map<SessionState, ReturnType<typeof acquireSessionEntry>>();
function ownWorker(state: SessionState) {
  if (!state.sessionId || commandOwners.has(state)) return;
  const owned = acquireSessionEntry(state.workspaceDir, state.sessionId, state.daemonPort ?? 0, () => commandOwners.delete(state));
  commandOwners.set(state, owned);
}
export function disposeAgentCommands() {
  for (const r of [...reservations.values()]) r.close();
  for (const owned of commandOwners.values()) owned.release(true);
  commandOwners.clear();
}
const keyOf = (company: string, goal: string, key: string) => JSON.stringify([company, goal, key]);
export function agentCaller(token: unknown): SessionState {
  const caller = findAgentState(token); if (!caller?.sessionId) throw Error('agent_forbidden'); return caller;
}
export function authorizeAgent(store: AgentGraph, token: unknown, state: SessionState, target: string | undefined, self = false): void {
  if (token === undefined) return;
  const caller = agentCaller(token);
  if (self && target === caller.sessionId && state === caller) return;
  const graph = store.snapshot();
  if (target && target !== caller.sessionId && graph.nodes.some(n => n.id === target && sameWorkspace(n.workspace, state.workspaceDir) && n.providerId === state.selection.providerId)
    && graph.edges.some(e => e.from === caller.sessionId && e.to === target && e.kind !== 'peer')) return;
  const claim = [...reservations.values()].find(r => r.state === state && r.token === token && r.fresh && r.registered && !state.sessionId && r.caller === caller);
  if (!target && claim) return;
  throw Error('agent_forbidden');
}
export function cancelAgentClaim(ws: WebSocket) { bySocket.get(ws)?.close(); }
function watchSettlement(r: Reservation, channel: Channel) {
  r.off = onAgentGraphChange((state, event) => {
    if (channel.getClientState(r.ws) !== r.state || state === r.state && (event?.type === 'done' || event?.type === 'error' || event?.type === 'interaction' && event.request)) r.close();
  });
}
export function agentClaimAllowsConfiguration(ws: WebSocket, state: SessionState, token: unknown) {
  const r = bySocket.get(ws); return !!r && r.fresh && r.state === state && r.token === token && !state.sessionId && (!r.caller || agentCaller(token) === r.caller);
}
export async function handleAgentCommand(ws: WebSocket, channel: Channel, msg: Record<string, unknown>, store: AgentGraph, init: (state: SessionState) => void): Promise<boolean> {
  const type = String(msg.type);
  const freshLink = type === 'linkAgents' && msg.child === null;
  if (!freshLink && !['getAgentScope', 'updateAgentScope', 'reserveAgentTurn', 'releaseAgentTurn'].includes(type)) return false;
  const reply = (value: object) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'agentGraph', requestId: msg.requestId, ...value })); };
  try {
    if (typeof msg.requestId !== 'string' || !msg.requestId || msg.requestId.length > 128) throw Error('graph_invalid_request');
    if (type === 'releaseAgentTurn') { cancelAgentClaim(ws); reply({ ok: true }); return true; }
    const company = name(msg.company), goal = name(msg.goal);
    if (type === 'getAgentScope') { reply({ ok: true, scope: store.readScope(company, goal) ?? null }); return true; }
    const caller = msg.agentToken === undefined ? undefined : agentCaller(msg.agentToken);
    if (type === 'updateAgentScope') {
      const data = msg.data === null ? null : scopeDocument(msg.data);
      if (caller) {
        const current = store.readScope(company, goal)?.data;
        // Metadata updates cannot manufacture worker/control grants or remove bindings.
        const before = current?.workers ?? {}, after = data?.workers ?? {};
        if (Object.keys(before).join() !== Object.keys(after).join()) throw Error('agent_forbidden');
        for (const [key, next] of Object.entries(after)) {
          const old = before[key];
          if (!old || ['sessionId', 'role', 'providerId', 'workspace'].some(field => next[field as keyof WorkerBinding] !== old[field as keyof WorkerBinding])) throw Error('agent_forbidden');
          if (JSON.stringify(next) !== JSON.stringify(old)) {
            const graph = store.snapshot();
            if (!next.sessionId || !graph.edges.some(e => e.from === caller.sessionId && e.to === next.sessionId && e.kind !== 'peer')) throw Error('agent_forbidden');
          }
        }
        if (data?.coordinatorConfiguration?.sessionId && data.coordinatorConfiguration.sessionId !== caller.sessionId) throw Error('agent_forbidden');
      }
      reply({ ok: true, scope: store.updateScope(company, goal, data, integer(msg.expectedRevision)) }); return true;
    }
    const key = name(msg.key), id = keyOf(company, goal, key);
    if (type === 'reserveAgentTurn') {
      if (bySocket.has(ws) || reservations.has(id) || reservations.size >= 256) throw Error('graph_command_busy');
      const scope = store.readScope(company, goal); if (!scope?.data) throw Error('graph_scope_missing');
      let state = channel.getClientState(ws); const fresh = msg.fresh === true;
      if (fresh) {
        if (scope.data.workers[key]) throw Error('graph_worker_exists');
        const binding = worker(msg.worker);
        if (!['work', 'review'].includes(binding.role) || binding.sessionId !== null || Object.values(scope.data.workers).some(w => w.role === binding.role) || Object.keys(scope.data.workers).length >= 2
          || [...reservations.values()].some(r => r.company === company && r.goal === goal && r.fresh && r.binding?.role === binding.role)) throw Error('graph_worker_conflict');
        state = channel.moveToNewSession(ws); init(state);
        if (!sameWorkspace(state.workspaceDir, binding.workspace)) throw Error('graph_worker_conflict');
      } else {
        const binding = scope.data.workers[key];
        if (!binding?.sessionId || binding.sessionId !== state.sessionId || channel.getViewingSessionId(ws)) throw Error('graph_target_mismatch');
        authorizeAgent(store, msg.agentToken, state, state.sessionId);
      }
      const r: Reservation = { ws, state, caller, token: msg.agentToken, company, goal, key, fresh, binding: fresh ? worker(msg.worker) : undefined, registered: false, close() {
        if (reservations.get(id) !== r) return; reservations.delete(id); bySocket.delete(ws); r.off?.(); ws.removeListener('close', r.close);
        commandOwners.get(r.state)?.release();
      } };
      reservations.set(id, r); bySocket.set(ws, r); ws.once('close', r.close);
      if (!fresh) { ownWorker(state); watchSettlement(r, channel); }
      reply({ ok: true, sessionId: state.sessionId ?? null }); return true;
    }
    const r = bySocket.get(ws);
    if (!r || !r.fresh || r.registered || r.company !== company || r.goal !== goal || r.key !== key || r.token !== msg.agentToken || r.state !== channel.getClientState(ws)
      || r.state.sessionId || r.state.runtime || r.state.currentProc || channel.getViewingSessionId(ws)) throw Error('graph_assignment_required');
    if (caller ? caller.sessionId !== msg.parent : typeof msg.parent !== 'string') throw Error('agent_forbidden');
    const binding = worker(msg.worker); const scope = store.readScope(company, goal);
    if (!scope?.data || JSON.stringify(binding) !== JSON.stringify(r.binding) || binding.sessionId !== null || binding.providerId !== r.state.selection.providerId || binding.model !== r.state.selection.model || binding.effort !== r.state.selection.effort
      || !sameWorkspace(binding.workspace, r.state.workspaceDir)) throw Error('graph_worker_conflict');
    if (scope.data.workers[key] || Object.values(scope.data.workers).some(w => w.role === binding.role)) throw Error('graph_worker_conflict');
    const saved = store.updateScope(company, goal, { ...scope.data, workers: { ...scope.data.workers, [key]: binding } }, integer(msg.expectedRevision));
    r.registered = true; r.binding = binding; r.revision = saved.revision;
    const parentId = String(msg.parent);
    r.off = onAgentGraphChange((state, event) => {
      if (state !== r.state) return;
      if (r.state !== channel.getClientState(ws) || event?.type === 'clear') { r.close(); return; }
      if (event?.type !== 'sessionId' || !state.sessionId) return;
      try {
        if (r.caller && agentCaller(r.token) !== r.caller) throw Error('agent_forbidden');
        const previous = store.snapshot().nodes.find(n => n.id === parentId);
        const now = Date.now();
        const parent: GraphNode = previous ?? { id: parentId, providerId: r.caller?.selection.providerId ?? String(msg.parentProviderId), role: 'coordinator', title: '', company, goal, workspace: r.caller?.workspaceDir ?? state.workspaceDir, createdAt: now, updatedAt: now };
        const child: GraphNode = { id: state.sessionId, providerId: binding.providerId, role: binding.role, title: binding.title, company, goal, workspace: binding.workspace, createdAt: now, updatedAt: now };
        const bound = store.bindWorker(company, goal, key, parent, child, r.revision!);
        ownWorker(state);
        store.recordForward(parent.id, child.id, 'Parent input');
        r.off?.(); watchSettlement(r, channel);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'agentRegistration', ok: true, key, sessionId: state.sessionId, scope: bound }));
      } catch { r.close(); state.runtime?.dispose(); if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'agentRegistration', ok: false, error: { code: 'graph_assignment_failed', message: 'Cannot register worker' } })); }
    });
    reply({ ok: true, pending: true, scope: saved });
  } catch (error) { reply({ ok: false, error: { code: error instanceof Error ? error.message : 'graph_command_failed', message: 'Cannot apply controller command' } }); }
  return true;
}
