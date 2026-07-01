import { readConfig } from './config';
import { killProc } from './cli';
import type { spawn } from 'child_process';

export interface WatchdogState {
  lastEventTime: number;
  active: boolean;
  retrying: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  autoRetryCount: number;
}

export interface WatchdogDeps {
  broadcast: (msg: string) => void;
  getProc: () => ReturnType<typeof spawn> | undefined;
  getCliDone: () => boolean;
  setCliDone: (v: boolean) => void;
  getPendingAskCount: () => number;
  getLastMessage: () => { text: string; images?: Array<{ data: string; mediaType: string; name?: string }>; mode?: string } | null;
  sendLog: (level: 'debug' | 'info' | 'warn' | 'error', text: string) => void;
  emitSyntheticSend: (msg: string) => void;
  checkApiError: () => string | undefined;
}

export function createWatchdog(deps: WatchdogDeps): { state: WatchdogState; interval: ReturnType<typeof setInterval>; getRetryDelay: (attempt: number, base: number, factor: number) => number } {
  const state: WatchdogState = {
    lastEventTime: 0,
    active: false,
    retrying: false,
    retryTimer: null,
    autoRetryCount: 0,
  };

  function getRetryDelay(attempt: number, baseDelaySec: number, factor: number): number {
    return baseDelaySec * 1000 * Math.pow(factor, attempt);
  }

  const interval = setInterval(() => {
    if (!state.active || deps.getCliDone() || state.lastEventTime === 0 || deps.getPendingAskCount() > 0) return;
    const cfg = readConfig();
    if (!cfg.watchdogEnabled) return;
    const elapsed = (Date.now() - state.lastEventTime) / 1000;
    if (elapsed < cfg.watchdogTimeout) return;

    const errContent = deps.checkApiError();
    if (errContent) {
      deps.setCliDone(true);
      state.active = false;
      const proc = deps.getProc();
      if (proc) killProc(proc);
      deps.broadcast(JSON.stringify({ type: 'error', text: errContent, errorKind: 'generic' }));
      deps.broadcast(JSON.stringify({ type: 'done' }));
      return;
    }

    const lastMessage = deps.getLastMessage();
    if (state.autoRetryCount < cfg.watchdogAutoRetries && lastMessage) {
      state.autoRetryCount++;
      const delay = getRetryDelay(state.autoRetryCount - 1, cfg.watchdogRetryDelay, cfg.watchdogDelayFactor);
      deps.sendLog('warn', `Watchdog: no CLI events for ${Math.round(elapsed)}s, auto-retry ${state.autoRetryCount}/${cfg.watchdogAutoRetries} in ${delay / 1000}s`);
      deps.broadcast(JSON.stringify({
        type: 'retry_status',
        attempt: 0,
        maxRetries: 0,
        delayMs: delay,
        autoRetry: state.autoRetryCount,
        autoRetryMax: cfg.watchdogAutoRetries,
      }));
      state.lastEventTime = Date.now();
      state.retrying = true;
      const proc = deps.getProc();
      if (proc) killProc(proc);
      state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        state.retrying = false;
        if (!deps.getLastMessage() || deps.getCliDone()) return;
        deps.emitSyntheticSend(JSON.stringify({
          type: 'send',
          text: lastMessage.text,
          images: lastMessage.images,
          mode: lastMessage.mode,
          _silent: true,
        }));
      }, delay);
    } else {
      deps.sendLog('error', `Watchdog: no CLI events for ${Math.round(elapsed)}s, all retries exhausted`);
      state.active = false;
      deps.setCliDone(true);
      if (state.retryTimer) {
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
      }
      state.retrying = false;
      const proc = deps.getProc();
      if (proc) killProc(proc);
      deps.broadcast(JSON.stringify({
        type: 'retry_status',
        attempt: 0, maxRetries: 0, delayMs: 0,
        autoRetry: state.autoRetryCount,
        autoRetryMax: cfg.watchdogAutoRetries,
        timedOut: true,
      }));
      deps.broadcast(JSON.stringify({ type: 'done' }));
    }
  }, 5000);

  return { state, interval, getRetryDelay };
}
