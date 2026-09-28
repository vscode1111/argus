import type { AgentProvider } from './types';
import { handleSend, handleStop, handleToolAnswer } from './claudeExecution';
import { killProc } from '../cli';
import { readConfig, writeConfig } from '../config';
import { fetchModels, fetchAccountInfo } from '../accountUsage';
import { requestUsageRefresh } from '../usagePoller';
import { describeModel } from '../modelData';
import { getSkills } from '../skills';
import { listSessions, loadSession, renameSession, deleteSession } from '../sessions';

export const claudeProvider: AgentProvider = {
  descriptor: { id: 'claude', label: 'Claude Code', thinkingToggle: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], inputKinds: ['text', 'image', 'pdf'] },
  createSession: state => ({
    get active() { return !!state.currentProc && !state.cliDone; },
    get pid() { return state.currentProc?.pid; },
    async send(input) { handleSend(state, input); },
    async stop() { handleStop(state); },
    respond(id, answers) { handleToolAnswer(state, { type: 'toolAnswer', id, answers }); },
    dispose() {
      const proc = state.currentProc;
      state.currentProc = undefined; state.currentProcKey = undefined;
      if (state.stopKillTimer) clearTimeout(state.stopKillTimer);
      if (proc) killProc(proc);
    },
  }),
  async models() {
    const { models, error } = await fetchModels(); const cfg = readConfig();
    if (models.length && JSON.stringify(models) !== JSON.stringify(cfg.modelListCache)) writeConfig({ ...cfg, modelListCache: models });
    return { models: (models.length ? models : cfg.modelListCache).map(m => ({ ...m, description: describeModel(m.id, cfg.modelFamilyDescriptions), efforts: claudeProvider.descriptor.efforts })),
      error, runtimeDefaultModel: cfg.runtimeDefaultModel };
  },
  async account() {
    const [account, usage] = await Promise.all([fetchAccountInfo(), requestUsageRefresh()]);
    return { account, rateLimits: usage.windows, usageError: usage.error };
  },
  async skills(cwd) { return getSkills(cwd); },
  async list(cwd) { return listSessions(cwd).map(s => ({ ...s, providerId: 'claude' })); },
  async load(id, cwd) { return loadSession(id, cwd); },
  async rename(id, cwd, title) { if (!renameSession(id, cwd, title)) throw new Error('Cannot rename conversation'); },
  async remove(id, cwd) { deleteSession(id, cwd); },
  async validate(selection) {
    if (selection.model.length > 200 || !/^[a-zA-Z0-9._:/-]*$/.test(selection.model)) throw new Error('Invalid model');
    if (selection.effort && !claudeProvider.descriptor.efforts.includes(selection.effort)) throw new Error('Unsupported effort');
  },
};
