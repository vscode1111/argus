import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const CONFIG_PATH = process.env.ARGUS_CONFIG || path.join(os.homedir(), '.claude', 'argus.json');

export interface ArgusConfig {
  verboseTools: boolean;
  showTimer: boolean;
  showOutput: boolean;
  showLogs: boolean;
  showLogTime: boolean;
  showLogType: boolean;
  soundOnComplete: boolean;
  notifyOnComplete: boolean;
  watchdogEnabled: boolean;
  watchdogTimeout: number;
  watchdogAutoRetries: number;
  watchdogRetryDelay: number;
  watchdogDelayFactor: number;
  // Master switch for non-local WS access: when false, only localhost/loopback and
  // the VS Code webview can connect (LAN ranges and allowedOrigins are rejected).
  allowNetworkAccess: boolean;
  // Extra origin hosts (IPs/hostnames) allowed to connect over WS, comma-separated.
  // Only honored while allowNetworkAccess is true.
  allowedOrigins: string;
  // Fixed port the always-on daemon listens on. Env ARGUS_DAEMON_PORT overrides it.
  // Changing this needs a daemon restart (yarn daemon:stop; it re-spawns on next use).
  daemonPort: number;
  // Idle timeout in ms: the daemon self-exits after this long with zero connected
  // clients. Env ARGUS_DAEMON_IDLE_MS overrides it. Needs a daemon restart to apply.
  daemonIdleMs: number;
  // Active model override. Empty string defers to the Claude CLI default.
  model: string;
  // Detected CLI default model (written by the daemon's daily model-data refresh,
  // manually via `yarn update-models`). Empty string means not yet detected.
  runtimeDefaultModel: string;
  // Unix ms of the last daemon start (written by the daemon on every launch).
  daemonLastStartAt: number;
  // Unix ms of the last model-data refresh that actually fetched a model list.
  // The daemon refreshes when older than a day. Only a real fetch advances this, so a
  // failed one (expired token, offline) cannot hide a stale context window for a day.
  modelDataUpdatedAt: number;
  // Unix ms of the last refresh *attempt*, successful or not. Backs off retries after
  // a failure: without it a permanently broken environment would re-attempt on every
  // daemon start, and the daemon idle-exits and respawns many times a day.
  modelDataAttemptedAt: number;
  // Per-family model descriptions (fable/opus/sonnet/haiku) extracted from the
  // installed Claude CLI bundle. Empty falls back to baked-in strings (modelData.ts).
  modelFamilyDescriptions: Record<string, string>;
  // Last successful /v1/models list, used as the model picker fallback when the
  // live fetch fails, and as the source of per-model context windows (modelData.ts
  // contextWindowFor). Updated on successful fetches and by the daily refresh.
  modelListCache: Array<{ id: string; displayName: string; contextWindow?: number }>;
  // Effort level passed to the CLI (low|medium|high|xhigh|max). Empty defers to CLI default.
  effort: string;
  // Whether extended thinking is enabled. When false, forces --effort low.
  thinking: boolean;
  // Text appended to the default Claude CLI system prompt (--append-system-prompt).
  // Empty string disables.
  appendSystemPrompt: string;
}

export const DEFAULT_CONFIG: ArgusConfig = {
  verboseTools: false,
  showTimer: true,
  showOutput: false,
  showLogs: true,
  showLogTime: true,
  showLogType: true,
  soundOnComplete: true,
  notifyOnComplete: true,
  watchdogEnabled: true,
  watchdogTimeout: 120,
  watchdogAutoRetries: 3,
  watchdogRetryDelay: 5,
  watchdogDelayFactor: 2,
  allowNetworkAccess: true,
  allowedOrigins: '',
  daemonPort: 3017,
  daemonIdleMs: 10 * 60 * 1000,
  model: '',
  runtimeDefaultModel: '',
  daemonLastStartAt: 0,
  modelDataUpdatedAt: 0,
  modelDataAttemptedAt: 0,
  modelFamilyDescriptions: {},
  modelListCache: [],
  effort: 'high',
  thinking: true,
  appendSystemPrompt: '',
};

let cachedConfig: ArgusConfig | null = null;
let cachedMtime = 0;

export function readConfig(): ArgusConfig {
  try {
    const mtime = fs.statSync(CONFIG_PATH).mtimeMs;
    if (cachedConfig && mtime === cachedMtime) return cachedConfig;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    cachedConfig = config;
    cachedMtime = mtime;
    return config;
  } catch {
    if (cachedConfig) return cachedConfig;
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(config: ArgusConfig): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    cachedConfig = config;
  } catch (err) {
    console.error(`[argus] Failed to write config to ${CONFIG_PATH}:`, (err as Error).message);
  }
}
