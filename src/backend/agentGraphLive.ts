import type { SessionState } from './sessionState';
interface Facts { sessionId?: string; outcome?: 'error' | 'stopped'; retry: boolean; lastEventAt?: number; lastEventSummary?: string }
const facts = new WeakMap<SessionState, Facts>();
type Change = (state?: SessionState, event?: Record<string, unknown>) => void;
const listeners = new Set<Change>();
export function onAgentGraphChange(listener: Change): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export function notifyAgentGraph(state?: SessionState, event?: Record<string, unknown>): void { for (const listener of listeners) listener(state, event); }
export function agentRetryPending(state: SessionState): boolean { const value = facts.get(state); return value?.sessionId === state.sessionId && value?.retry === true; }
const observed = new Set(['thinking_start', 'done', 'error', 'retry_status', 'interaction', 'interaction_resolved', 'sessionId', 'clear', 'providerSelection', 'sessionRenamed', 'tool_start', 'tool_end', 'text_chunk', 'user_inject', 'bgTasks']);
export function observeAgentGraph(state: SessionState, event: Record<string, unknown>): void {
  if (!observed.has(String(event.type))) return;
  const old = facts.get(state);
  const previous = old && old.sessionId === state.sessionId ? old : { sessionId: state.sessionId, retry: false };
  if (event.type === 'thinking_start' || event.type === 'clear') { previous.outcome = undefined; previous.retry = false; }
  if (event.type === 'retry_status') {
    previous.retry = event.timedOut !== true && (event.errorRetry === true || typeof event.autoRetry === 'number');
    if (event.timedOut === true) previous.outcome = 'error';
  }
  if (event.type === 'error') previous.outcome = 'error';
  if (event.type === 'done') { previous.retry = false; if (event.interrupted) previous.outcome = 'stopped'; }
  previous.lastEventAt = Date.now(); previous.lastEventSummary = String(event.type).slice(0, 80); facts.set(state, previous); notifyAgentGraph(state, event);
}
export function projectAgentState(state: SessionState | undefined) {
  if (!state) return { live: false, status: null, pendingInteraction: null, selected: null, activeSelection: null, lastEventAt: null, lastEventSummary: null };
  const stored = facts.get(state); const fact = stored?.sessionId === state.sessionId ? stored : undefined;
  const active = !!(state.runtime?.active || state.currentProc && !state.cliDone || fact?.retry);
  const activeSelection = active ? state.runtime?.getSessionControl?.().activeSelection : undefined;
  const request = state.interaction;
  const pendingInteraction = request ? { id: request.id.slice(0, 160), kind: request.kind, title: request.title.slice(0, 200),
    ...(request.sourceToolId ? { sourceToolId: request.sourceToolId.slice(0, 160) } : {}), async: request.async === true,
    questions: request.questions?.slice(0, 8).map(q => ({ id: q.id.slice(0, 160), question: q.question.slice(0, 1024), options: q.options.slice(0, 32).map(o => o.slice(0, 200)), multiSelect: q.multiSelect === true })) } : null;
  return { live: true, status: request ? 'needs-input' : active ? 'running' : fact?.outcome ?? 'idle', pendingInteraction,
    selected: { ...state.selection }, activeSelection: activeSelection ? { ...activeSelection } : null,
    lastEventAt: fact?.lastEventAt ?? null, lastEventSummary: fact?.lastEventSummary ?? null };
}
