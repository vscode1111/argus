import type { AgentProvider, AgentSession } from './types';
import type { SessionState } from '../sessionState';
import { claudeProvider } from './claude';
import { codexProvider } from './codex';
import { saveSession, sessionRecord, selectionFor } from './store';

const registry = new Map<string, AgentProvider>([claudeProvider, codexProvider].map(p => [p.descriptor.id, p]));
export function providers(): AgentProvider[] { return [...registry.values()]; }
export function provider(id: string): AgentProvider {
  const value = registry.get(id);
  if (!value) throw new Error('Unknown provider');
  return value;
}
export function providerForSession(id: string): AgentProvider { return provider(id.includes(':') ? id.split(':')[0] : 'claude'); }
export function runtime(state: SessionState): AgentSession {
  if (state.runtime?.reconnectNeeded) { state.runtime.dispose(); state.runtime = undefined; }
  return state.runtime ?? (state.runtime = provider(state.selection.providerId).createSession(state));
}
export function persistSelection(state: SessionState): void {
  if (!state.sessionId) return;
  const previous = sessionRecord(state.sessionId, state.workspaceDir);
  saveSession({ id: state.sessionId, cwd: state.workspaceDir, selection: { ...state.selection }, title: previous?.title || state.lastMessage?.text.slice(0, 100) || '', updatedAt: Date.now() });
}
export function restoreSelection(state: SessionState, id: string): void {
  if (state.sessionId !== id || state.selection.providerId !== providerForSession(id).descriptor.id || state.runtime?.reconnectNeeded) {
    state.runtime?.dispose(); state.runtime = undefined;
  }
  state.sessionId = id;
  state.selection = selectionFor(id, state.workspaceDir);
}
export function selectionMessage(state: SessionState) {
  return { type: 'providerSelection', ...state.selection };
}
