import { readConfig } from './config';
import type { TurnInput } from './providers/types';

const MAX_PATTERNS = 20;
const MAX_PATTERN_LENGTH = 200;
const MAX_PATTERN_TEXT_LENGTH = 4096;

export function parseErrorRetryPatterns(value: unknown): { patterns: RegExp[]; error?: string } {
  if (typeof value !== 'string' || value.length > MAX_PATTERN_TEXT_LENGTH) return { patterns: [], error: 'Error patterns must be text of at most 4096 characters' };
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > MAX_PATTERNS) return { patterns: [], error: 'Use at most 20 error patterns' };
  const patterns: RegExp[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.length > MAX_PATTERN_LENGTH) return { patterns: [], error: `Error pattern ${index + 1} exceeds 200 characters` };
    try { patterns.push(new RegExp(line, 'i')); }
    catch { return { patterns: [], error: `Error pattern ${index + 1} is not a valid regular expression` }; }
  }
  return { patterns };
}

interface ErrorRetryDeps {
  broadcast: (message: string) => void;
  getLastMessage: () => TurnInput | null;
  retry: (input: TurnInput) => void;
  log: (message: string) => void;
}

export interface ErrorRetryController {
  broadcast: (message: string) => void;
  cancel: (finishTurn: boolean) => boolean;
  beginTurn: () => void;
}

export function createErrorRetry(deps: ErrorRetryDeps): ErrorRetryController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let ignoreLateTerminal = false;

  function cancel(finishTurn: boolean): boolean {
    if (!timer) return false;
    clearTimeout(timer);
    timer = undefined;
    attempts = 0;
    ignoreLateTerminal = true;
    if (finishTurn) deps.broadcast(JSON.stringify({ type: 'done', interrupted: true }));
    return true;
  }

  function beginTurn(): void { ignoreLateTerminal = false; }

  function broadcast(message: string): void {
    let event: { type?: string; text?: string };
    try { event = JSON.parse(message); }
    catch { deps.broadcast(message); return; }
    if (event.type === 'thinking_start' || event.type === 'message') ignoreLateTerminal = false;
    if ((event.type === 'error' || event.type === 'done') && (timer || ignoreLateTerminal)) return;
    if (event.type === 'error' && typeof event.text === 'string') {
      const config = readConfig();
      const { patterns } = parseErrorRetryPatterns(config.errorRetryPatterns);
      const maxRetries = Number.isFinite(config.errorRetryMaxRetries) ? Math.min(20, Math.max(0, Math.floor(config.errorRetryMaxRetries))) : 0;
      const input = deps.getLastMessage();
      const errorText = event.text.slice(0, 4000);
      if (config.watchdogEnabled && input && attempts < maxRetries && patterns.some(pattern => pattern.test(errorText))) {
        const delaySeconds = Number.isFinite(config.errorRetryDelay) ? Math.min(3600, Math.max(1, config.errorRetryDelay)) : 10;
        const attempt = ++attempts;
        deps.log(`Error retry ${attempt}/${maxRetries} in ${delaySeconds}s`);
        deps.broadcast(JSON.stringify({ type: 'retry_status', attempt, maxRetries, delayMs: delaySeconds * 1000, errorRetry: true }));
        timer = setTimeout(() => {
          timer = undefined;
          deps.retry({ ...input, _silent: true });
        }, delaySeconds * 1000);
        return;
      }
    }
    if (event.type === 'done') { attempts = 0; ignoreLateTerminal = true; }
    deps.broadcast(message);
  }

  return { broadcast, cancel, beginTurn };
}
