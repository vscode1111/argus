import type { AgentGraph, GraphEdge, GraphNode, StoredGraph } from './agentGraph';
import type { SessionState } from './sessionState';
import type { SendAdmission, TurnInput } from './providers/types';
import { withAutomaticMarker } from './automaticMarker';
import { projectAgentState, agentRetryPending } from './agentGraphLive';
import { sameWorkspace } from './providers/store';

interface Dependencies {
  states(): SessionState[];
  acquire(node: GraphNode, settled?: () => void): { state: SessionState; retain?(): boolean; release(force?: boolean): boolean | void };
  send(state: SessionState, input: TurnInput, admission: SendAdmission): Promise<void>;
  now?(): number;
}
const StateRef = (globalThis as unknown as { WeakRef: new<T extends object>(value: T) => { deref(): T | undefined } }).WeakRef;
interface Report { generation: object; source: { deref(): SessionState | undefined }; question?: string; error: boolean; end: boolean; milestone: boolean; due: number; version: number }
const origins = new WeakMap<SessionState, boolean>();
export const DELIVERY_LIMITS = { coalesce: 2000, interval: 5000, reports: 4000, concurrent: 4 };
let active: AgentDelivery | undefined;
export function installAgentDelivery(value: AgentDelivery | undefined) { active = value; }
export function deliveryMetadata(state: SessionState, event: Record<string, unknown>) { return active?.metadata(state, event) ?? event; }
export function stopAgentDelivery(state: SessionState) { active?.stop(state); }
export function manualAgentInput(state: SessionState) { origins.delete(state); active?.manual(state); }
export function scheduledRetry(state: SessionState) { return !!(agentRetryPending(state) || state.errorRetry?.pending || state.watchdog?.state.retrying); }

// Graph snapshots are cached on store mutations; stream traffic never reads SQLite.
export class AgentDelivery {
  private graph: StoredGraph;
  private generations = new Map<string, object>();
  private reports = new Map<string, Report>();
  private lastAttempt = new Map<string, number>();
  private turns = new WeakMap<SessionState, { ended: boolean; question?: string }>();
  private busy = new Set<string>();
  private owners = new Map<SessionState, ReturnType<Dependencies['acquire']>>();
  private timer?: NodeJS.Timeout;
  private timerDue?: number;
  private closed = false;
  private unsubscribe: () => void;
  private readonly now: () => number;
  private readonly limits;
  constructor(readonly store: AgentGraph, private deps: Dependencies, limits: Partial<typeof DELIVERY_LIMITS> = {}) {
    this.limits = { ...DELIVERY_LIMITS, ...limits }; this.now = deps.now ?? Date.now;
    this.graph = store.snapshot(); this.sync(); this.unsubscribe = store.onChange(() => this.sync());
  }
  private sync() {
    const before = new Map(this.graph.edges.map(e => [e.id, e])); this.graph = this.store.snapshot();
    const ids = new Set(this.graph.edges.map(e => e.id));
    for (const id of this.generations.keys()) if (!ids.has(id)) { this.generations.delete(id); this.reports.delete(id); this.lastAttempt.delete(id); }
    for (const edge of this.graph.edges) {
      if (!this.generations.has(edge.id) || JSON.stringify(before.get(edge.id)?.push) !== JSON.stringify(edge.push)) {
        this.generations.set(edge.id, {}); this.reports.delete(edge.id);
      }
      if (this.graph.nodes.find(n => n.id === edge.from)?.userStopped) this.reports.delete(edge.id);
    }
    this.schedule();
  }
  stop(state: SessionState) {
    if (state.sessionId && this.graph.nodes.some(n => n.id === state.sessionId)) this.store.setUserStopped(state.sessionId, true);
    for (const edge of this.graph.edges) if (edge.from === state.sessionId) this.reports.delete(edge.id);
    this.schedule();
  }
  manual(state: SessionState) {
    origins.delete(state);
    if (state.sessionId && this.graph.nodes.find(n => n.id === state.sessionId)?.userStopped) this.store.setUserStopped(state.sessionId, false);
  }
  observe(state: SessionState, event: Record<string, unknown>) {
    if (this.closed || !state.sessionId) return;
    if (['done', 'error', 'interaction_resolved', 'bgTasks', 'clear'].includes(String(event.type)))
      for (const [parent, owned] of this.owners) if (owned.release()) this.owners.delete(parent);
    const child = state.sessionId;
    let turn = this.turns.get(state); if (!turn) { turn = { ended: false }; this.turns.set(state, turn); }
    if (event.type === 'thinking_start') { turn.ended = false; this.schedule(); return; }
    if (event.type === 'interaction_resolved') {
      for (const [id, report] of this.reports) if (report.source.deref() === state && report.question === event.id) {
        report.question = undefined; report.version++; if (!report.end && !report.error && !report.milestone) this.reports.delete(id);
      }
      if (this.graph.edges.some(e => e.to === child && e.reverse?.questionId === event.id && e.reverse?.awaitingReply)) this.store.resolveReverse(child, String(event.id));
      if (turn.question === event.id) turn.question = undefined;
      this.schedule(); return;
    }
    const request = event.request as { id?: string; kind?: string } | undefined;
    const question = event.type === 'interaction' && request?.id && request.kind === 'question' ? request.id : undefined;
    const error = event.type === 'error' || event.type === 'retry_status' && event.timedOut === true;
    const end = event.type === 'done' && !turn.ended;
    const call = event.call as { outcome?: string; error?: boolean } | undefined;
    const milestone = event.type === 'tool_end' && (call?.outcome === 'failure' || call?.error === true);
    if (event.type === 'done') turn.ended = true;
    if (question && turn.question === question) { this.schedule(); return; }
    if (question) turn.question = question;
    if (!question && !error && !end && !milestone) { if (['interaction', 'bgTasks', 'retry_status', 'clear', 'sessionId'].includes(String(event.type))) this.schedule(); return; }
    for (const edge of this.graph.edges) {
      if (edge.kind === 'peer' || edge.to !== child || this.graph.nodes.find(n => n.id === edge.from)?.userStopped) continue;
      const push = edge.push!; const q = !!question && push.questions, e = error && push.errors, d = end && push.turnEnd, m = milestone && push.milestones.includes('tool-failure');
      if (!q && !e && !d && !m) continue;
      let report = this.reports.get(edge.id);
      if (!report) {
        if (this.reports.size >= this.limits.reports) continue;
        report = { generation: this.generations.get(edge.id)!, source: new StateRef(state), error: false, end: false, milestone: false, due: this.now() + this.limits.coalesce, version: 0 };
        this.reports.set(edge.id, report);
      }
      report.version++; if (q) report.question = question; report.error ||= e; report.end ||= d; report.milestone ||= m;
    }
    this.schedule();
  }
  pending(parent: string) {
    const ids = new Set(this.graph.edges.filter(e => e.kind !== 'peer' && e.from === parent).map(e => e.to));
    const states = this.deps.states(); let pending = 0, unknown = 0;
    for (const id of ids) {
      const state = states.find(s => s.sessionId === id);
      if (!state) { unknown++; continue; }
      if (state.interaction || state.pendingBgTasks.size || scheduledRetry(state) || projectAgentState(state).status === 'running'
        || this.graph.edges.some(e => e.from === parent && e.to === id && this.reports.has(e.id))) pending++;
    }
    return { pendingAgentChildren: pending, unknownAgentChildren: unknown };
  }
  metadata(state: SessionState, event: Record<string, unknown>) {
    if (event.type === 'tool_start') return { ...event, notificationOrigin: origins.get(state) ? 'graph' : null };
    if (!['thinking_start', 'user_inject', 'done', 'error', 'interaction'].includes(String(event.type))) return event;
    if (!origins.get(state)) return event;
    return { ...event, notificationOrigin: 'graph', ...this.pending(state.sessionId ?? ''),
      notificationBlocked: !!state.interaction || state.pendingBgTasks.size > 0 || this.graph.nodes.find(n => n.id === state.sessionId)?.userStopped === true };
  }
  private schedule() {
    const states = this.deps.states();
    const due = this.closed || !this.reports.size || this.busy.size >= this.limits.concurrent ? Infinity
      : Math.min(...this.graph.edges.filter(e => this.reports.has(e.id) && this.readyParent(e.from, states))
      .map(e => Math.max(this.reports.get(e.id)!.due, (this.lastAttempt.get(e.id) ?? -Infinity) + this.limits.interval)));
    if (this.timer && this.timerDue === due) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.timerDue = undefined;
    if (!Number.isFinite(due)) return;
    this.timerDue = due;
    this.timer = setTimeout(() => { this.timer = undefined; this.timerDue = undefined; void this.flush(); }, Math.max(25, due - this.now())); this.timer.unref();
  }
  private readyParent(id: string, states: SessionState[]) {
    const state = states.find(s => s.sessionId === id);
    return !this.busy.has(id) && !this.graph.nodes.find(n => n.id === id)?.userStopped && !state?.interaction && !(state && scheduledRetry(state));
  }
  private valid(edge: GraphEdge, report: Report) {
    return !this.closed && this.reports.get(edge.id) === report && this.generations.get(edge.id) === report.generation
      && !this.graph.nodes.find(n => n.id === edge.from)?.userStopped && (!report.source.deref() || report.source.deref()?.sessionId === edge.to);
  }
  async flush(): Promise<void> {
    if (this.closed) return;
    const states = this.deps.states();
    const parents = new Set(this.graph.edges.filter(e => {
      const report = this.reports.get(e.id);
      return report && this.readyParent(e.from, states) && report.due <= this.now() && (this.lastAttempt.get(e.id) ?? -Infinity) + this.limits.interval <= this.now();
    }).map(e => e.from));
    await Promise.all([...parents].slice(0, Math.max(0, this.limits.concurrent - this.busy.size)).map(id => this.flushParent(id)));
    this.schedule();
  }
  private async flushParent(parent: string) {
    if (this.busy.has(parent)) return;
    const node = this.graph.nodes.find(n => n.id === parent); if (!node || node.userStopped) return;
    const live = this.deps.states().find(s => s.sessionId === parent); if (live && (live.interaction || scheduledRetry(live))) return;
    let selected = this.graph.edges.flatMap(edge => {
      const report = this.reports.get(edge.id); if (!report) return [];
      if (!this.valid(edge, report)) { this.reports.delete(edge.id); return []; }
      if (report.question && report.source.deref() && report.source.deref()?.interaction?.id !== report.question) { report.question = undefined; report.version++; }
      if (!report.question && !report.error && !report.end && !report.milestone) { this.reports.delete(edge.id); return []; }
      return report.due <= this.now() && (this.lastAttempt.get(edge.id) ?? -Infinity) + this.limits.interval <= this.now() ? [{ edge, report, version: report.version }] : [];
    }).filter(item => item.edge.from === parent);
    if (!selected.length) return;
    selected = selected.filter(item => item.edge.to === selected[0].edge.to);
    this.busy.add(parent); let owned: ReturnType<Dependencies['acquire']> | undefined;
    try {
      const cached = live && this.owners.get(live);
      owned = cached && (!cached.retain || cached.retain()) ? cached : this.deps.acquire(node, () => {
        if (owned && this.owners.get(owned.state) === owned) this.owners.delete(owned.state);
      }); const state = owned.state; this.owners.set(state, owned);
      const wasActive = !!(state.runtime?.active || state.currentProc && !state.cliDone);
      let admitted = false;
      const valid = () => state.sessionId === parent && sameWorkspace(state.workspaceDir, node.workspace) && !state.interaction && !scheduledRetry(state)
        && selected.every(({ edge, report, version }) => this.valid(edge, report) && report.version === version
          && (!report.question || !report.source.deref() || report.source.deref()?.interaction?.id === report.question));
      if (!valid()) return;
      const child = selected[0].edge.to;
      const facts = [selected.some(i => i.report.question) && 'question pending', selected.some(i => i.report.error) && 'error',
        selected.some(i => i.report.end) && 'turn ended', selected.some(i => i.report.milestone) && 'tool failure'].filter(Boolean);
      const text = withAutomaticMarker(`${child}: ${facts.join(', ')}. Details: watch --session ${child}`.slice(0, 1500));
      for (const { edge } of selected) this.lastAttempt.set(edge.id, this.now());
      await this.deps.send(state, { type: 'send', text, mode: state.lastMessage?.mode }, { automatic: true, valid, admitted: () => {
        admitted = true; if (!wasActive || state.autonomousTurn) origins.set(state, true);
        for (const { edge } of selected) this.reports.delete(edge.id);
      } });
      if (admitted) {
        const ids = selected.filter(({ edge, report }) => this.generations.get(edge.id) === report.generation).map(i => i.edge.id);
        const question = selected.find(i => i.report.question && (!i.report.source.deref()
          || i.report.source.deref()?.interaction?.id === i.report.question))?.report.question;
        this.store.recordReverse(ids, selected.some(i => i.report.error) ? 'Child error report' : question ? 'Child question report' : 'Child turn report', question);
      }
    } catch { /* No blind retry of an ambiguously submitted native input. */ }
    finally { if (owned && owned.release()) this.owners.delete(owned.state); this.busy.delete(parent); }
  }
  stats() { return { reports: this.reports.size, bytes: [...this.reports.values()].reduce((n, r) => n + 256 + Buffer.byteLength(r.question ?? ''), 0), timers: this.timer ? 1 : 0, active: this.busy.size }; }
  dispose() { this.closed = true; this.unsubscribe(); if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.timerDue = undefined; this.reports.clear(); this.generations.clear(); this.lastAttempt.clear(); for (const owned of this.owners.values()) owned.release(true); this.owners.clear(); }
}
