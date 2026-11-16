import type { SessionState } from './sessionState';

// Only entry-owned execution may identify an agent. Metadata helpers have no owner.
export function agentEnvironment(state?: Pick<SessionState, 'agentToken' | 'daemonPort'>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^ARGUS_(AGENT_TOKEN|DAEMON_PORT)$/i.test(key)) delete env[key];
  }
  if (state) {
    env.ARGUS_AGENT_TOKEN = state.agentToken;
    if (state.daemonPort !== undefined) env.ARGUS_DAEMON_PORT = String(state.daemonPort);
  }
  return env;
}
