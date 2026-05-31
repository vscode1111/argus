import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CONFIG_PATH = process.env.ARGUS_CONFIG || path.join(os.homedir(), '.claude', 'argus.json');

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
