import { findAgentState } from './channel';
import { provider } from './providers/registry';

const IDENTITY_ERROR = 'Agent identity unavailable';

export async function agentIdentity(token: unknown) {
  const state = findAgentState(token);
  if (!state) return { error: IDENTITY_ERROR };
  const sessionId = state.sessionId ?? null;
  const providerId = state.selection.providerId;
  const workspace = state.workspaceDir;
  let title = '';
  if (sessionId) {
    try { title = (await provider(providerId).list(workspace)).find(session => session.id === sessionId)?.title ?? ''; }
    catch { /* Unavailable metadata does not invalidate a live entry. */ }
  }
  if (findAgentState(token) !== state || (state.sessionId ?? null) !== sessionId
    || state.selection.providerId !== providerId || state.workspaceDir !== workspace) return { error: IDENTITY_ERROR };
  return { sessionId, providerId, workspace, title };
}
