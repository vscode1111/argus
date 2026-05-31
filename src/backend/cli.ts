import { execFileSync, type spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const IS_WIN = process.platform === 'win32';

let resolvedClaudeBin: string | null = null;
export function resolveClaudeBin(): string {
  if (resolvedClaudeBin) return resolvedClaudeBin;
  if (!IS_WIN) { resolvedClaudeBin = 'claude'; return 'claude'; }
  try {
    const out = execFileSync('where', ['claude.cmd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const hit = out.split(/\r?\n/).map(l => l.trim()).find(Boolean);
    if (hit && fs.existsSync(hit)) { resolvedClaudeBin = hit; return hit; }
  } catch {}
  const nvmHome = process.env.NVM_HOME;
  if (nvmHome) {
    try {
      const versions = fs.readdirSync(nvmHome).filter(d => /^v\d/.test(d)).sort().reverse();
      for (const v of versions) {
        const candidate = path.join(nvmHome, v, 'claude.cmd');
        if (fs.existsSync(candidate)) { resolvedClaudeBin = candidate; return candidate; }
      }
    } catch {}
  }
  resolvedClaudeBin = 'claude';
  return 'claude';
}

export function killProc(proc: ReturnType<typeof spawn>) {
  if (!proc.pid) return;
  if (IS_WIN) {
    try { execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore' }); } catch {}
  } else {
    proc.kill();
  }
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? singular + 's')}`;
}

export type ErrorKind = 'auth' | 'not_found' | 'session' | 'generic';

const AUTH_PATTERNS = [/auth/i, /login/i, /token/i, /unauthorized/i, /401/i, /403/i, /credential/i, /oauth/i, /api[_ ]?key/i];
const SESSION_PATTERNS = [/session/i, /resume/i, /expired/i, /not found.*session/i];

export function classifyError(stderr: string, exitCode: number | null): { message: string; errorKind: ErrorKind } {
  const text = stderr.trim();
  if (text) {
    if (AUTH_PATTERNS.some(p => p.test(text))) return { message: text, errorKind: 'auth' };
    if (SESSION_PATTERNS.some(p => p.test(text))) return { message: text, errorKind: 'session' };
  }
  if (exitCode === 1 && text) return { message: text, errorKind: 'auth' };
  return { message: text || `claude exited with code ${exitCode}`, errorKind: 'generic' };
}

export const URL_PATTERNS = [
  /(https:\/\/[^\s"]+oauth[^\s"]*)/i,
  /(https:\/\/claude\.ai\/[^\s"]+)/i,
  /(https:\/\/console\.anthropic\.com\/[^\s"]+)/i,
  /(https:\/\/[^\s"]+anthropic[^\s"]*)/i,
];

export const API_ERROR_RE = /API Error:|Failed to authenticate|Request not allowed|socket connection was closed|overloaded_error|invalid_api_key|permission_error/i;
