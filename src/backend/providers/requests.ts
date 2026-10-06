import type { WebSocket } from 'ws';
import type { Channel } from '../channel';
import { listActiveSessions } from '../channel';
import type { SessionState } from '../sessionState';
import { provider, providers, runtime, persistSelection, selectionMessage, providerForSession } from './registry';
import { defaultSelection, selectionFor, forgetSession } from './store';
import { string } from './rpc';
import { readConfig, writeConfig } from '../config';
import type { ProviderSelection } from '../../shared/provider';

function saveDefaultSelection(selection: ProviderSelection): void {
  const config = readConfig();
  writeConfig({ ...config, defaultProvider: selection.providerId,
    providerDefaults: { ...config.providerDefaults, [selection.providerId]: { ...selection } } });
}

const handled = new Set(['getProviders', 'switchProvider', 'saveProviderDefault', 'switchModel', 'switchEffort', 'switchThinking',
  'getModels', 'getAccountUsage', 'getSkills', 'listSessions', 'renameSession', 'deleteSession', 'providerResponse']);

export async function handleProviderRequest(ws: WebSocket, channel: Channel, msg: Record<string, unknown>, init: (s: SessionState) => void): Promise<boolean> {
  const type = string(msg.type);
  let state = channel.getClientState(ws);
  const viewing = channel.getViewingSessionId(ws);
  const selection = viewing ? selectionFor(viewing, state.workspaceDir) : state.selection;
  if (!handled.has(type) && !(selection.providerId !== 'claude' && ['getUsageLimits', 'getUsageInsights', 'login', 'loginCode'].includes(type))) return false;
  const reply = (value: object) => { if (ws.readyState === 1) ws.send(JSON.stringify({ providerId: selection.providerId, requestId: msg.requestId, ...value })); };
  try {
    const p = provider(selection.providerId);
    if (type === 'getProviders') {
      reply({ type: 'providers', providers: providers().map(p => p.descriptor) });
      reply({ type: 'providerSelection', ...selection });
    } else if (type === 'switchProvider') {
      const id = string(msg.providerId); provider(id);
      if (id === selection.providerId) return true;
      const fresh = channel.moveToNewSession(ws); init(fresh);
      fresh.selection = defaultSelection(id);
      saveDefaultSelection(fresh.selection);
      fresh.broadcast(JSON.stringify({ type: 'clear' }));
      fresh.broadcast(JSON.stringify(selectionMessage(fresh)));
    } else if (type === 'providerResponse') {
      if (viewing) throw new Error('Return to the active conversation before answering');
      runtime(state).respond(string(msg.id), msg.response);
    } else if (type === 'saveProviderDefault') {
      saveDefaultSelection(selection);
      reply({ type: 'providerNotice', message: 'Saved for new conversations' });
    } else if (['switchModel', 'switchEffort', 'switchThinking'].includes(type)) {
      if (msg.providerId !== undefined && msg.providerId !== selection.providerId) throw new Error('Provider selection changed; try again');
      const next = { ...selection };
      if (type === 'switchModel') { next.model = string(msg.model); next.effort = ''; }
      if (type === 'switchEffort') next.effort = string(msg.effort);
      if (type === 'switchThinking') {
        if (!p.descriptor.thinkingToggle) throw new Error('This provider does not support a thinking toggle');
        next.thinking = msg.thinking !== false;
      }
      await p.validate(next);
      if (channel.getClientState(ws) !== state || (channel.getViewingSessionId(ws) || undefined) !== viewing) throw new Error('Conversation changed; try again');
      const detached = channel.detachToBrowsedSession(ws);
      if (detached) { state = detached; init(state); }
      state.errorRetry?.cancel(true);
      state.selection = next; persistSelection(state);
      saveDefaultSelection(next);
      state.broadcast(JSON.stringify(selectionMessage(state)));
    } else if (type === 'getModels') {
      reply({ type: 'modelList', ...await p.models() });
    } else if (type === 'getAccountUsage' || type === 'getUsageLimits') {
      const result = await p.account();
      if (type === 'getAccountUsage') {
        reply({ type: 'accountUsage', account: result.account, usagePending: true });
        reply({ type: 'accountUsage', ...result, usagePending: false });
      } else reply({ type: 'usageLimits', windows: result.rateLimits, error: result.usageError, fetchedAt: Date.now() });
    } else if (type === 'getSkills') {
      reply({ type: 'skills', skills: await p.skills(state.workspaceDir) });
    } else if (type === 'getUsageInsights') {
      reply({ type: 'usageInsights', error: 'Local attribution is not available for this provider.' });
    } else if (type === 'login' || type === 'loginCode') {
      reply({ type: 'loginResult', success: false, message: 'Run codex login on the server, then reopen this dialog.' });
    } else {
      const id = string(msg.id);
      if (type !== 'listSessions') {
        const owner = providerForSession(id);
        if (type === 'renameSession') await owner.rename(id, state.workspaceDir, string(msg.title));
        else {
          if (listActiveSessions().some(s => s.id === id)) throw new Error('Stop the conversation before deleting it');
          await owner.remove(id, state.workspaceDir); forgetSession(id);
          if (state.sessionId === id) { state.runtime?.dispose(); state.runtime = undefined; state.sessionId = undefined; }
        }
      }
      const lists = await Promise.all(providers().map(p => p.list(state.workspaceDir)));
      reply({ type: 'sessionList', sessions: lists.flat().sort((a, b) => b.updatedAt - a.updatedAt), currentId: viewing || state.sessionId });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider request failed';
    if (type === 'getModels') reply({ type: 'modelList', models: [], error: message });
    else if (type === 'getAccountUsage') reply({ type: 'accountUsage', account: { loggedIn: false }, rateLimits: [], usageError: message, usagePending: false });
    else if (type === 'getUsageLimits') reply({ type: 'usageLimits', windows: [], error: message });
    else if (type === 'getSkills') reply({ type: 'skills', skills: [], error: message });
    else reply({ type: 'providerNotice', message, error: true });
  }
  return true;
}
