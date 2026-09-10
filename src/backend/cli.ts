import { execFileSync, type spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const IS_WIN = process.platform === 'win32';

// Image/process name of the Claude Code CLI, shared by everything that has to find
// those processes on the machine (killAllClaude here, the process listing in
// processes.ts) so the two can never disagree about what they are looking at.
export const CLAUDE_IMAGE_WIN = 'claude.exe';
export const CLAUDE_PROC_POSIX = 'claude';

let resolvedClaudeBin: string | null = null;
export function resolveClaudeBin(): string {
  if (resolvedClaudeBin) return resolvedClaudeBin;
  if (!IS_WIN) { resolvedClaudeBin = 'claude'; return 'claude'; }
  try {
    const out = execFileSync('where', ['claude.cmd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
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

// Ends the CLI's current turn without ending the process, over the control channel the
// stream-json input format already carries (the CLI's stdin parser accepts
// `type: "control_request"` and rejects one with no `request`). Returns whether the frame
// could be written; the caller falls back to killProc when it could not.
//
// Why this exists: killing the CLI mid-turn leaves its transcript ending on a user message
// nobody answered, and the next `--resume` repairs that by splicing a synthetic
// "No response requested." assistant turn into the conversation. That repair is sent to the
// model on every later turn (measured), and once several accumulate the model starts
// answering real questions with the same four words. An interrupted process stays alive and
// is reused by the next send, so no rebuild happens and no repair is spliced.
export function interruptProc(proc: ReturnType<typeof spawn>): boolean {
  if (!proc.stdin?.writable) return false;
  try {
    const frame = { type: 'control_request', request_id: `argus-stop-${Date.now()}`, request: { subtype: 'interrupt' } };
    proc.stdin.write(JSON.stringify(frame) + '\n');
    return true;
  } catch {
    return false;
  }
}

export function killProc(proc: ReturnType<typeof spawn>) {
  if (!proc.pid) return;
  if (IS_WIN) {
    try { execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true }); } catch {}
  } else {
    proc.kill();
  }
}

export interface KillAllResult {
  count: number;
  error?: string;
}

// Force-terminates every Claude Code CLI process on the machine, not just the one(s)
// this server spawned - the same scope as cmd/kill-claude.bat. Since any running
// claude.exe shares the same image name, this can kill unrelated sessions (e.g. a
// terminal-driven CLI session elsewhere on the box); that is the intended "panic
// button" behavior, not a bug.
export function killAllClaude(): KillAllResult {
  if (IS_WIN) {
    // Count first via CSV output (locale-independent - it echoes the literal image
    // name, unlike taskkill's own human-readable success/error sentences) so the
    // reported count doesn't depend on taskkill's localized text.
    let count = 0;
    try {
      const csv = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${CLAUDE_IMAGE_WIN}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      count = csv.split(/\r?\n/).filter(line => line.trim().startsWith(`"${CLAUDE_IMAGE_WIN}"`)).length;
    } catch {}
    if (count === 0) return { count: 0 };
    try {
      execFileSync('taskkill', ['/F', '/IM', CLAUDE_IMAGE_WIN], { stdio: 'ignore', windowsHide: true });
      return { count };
    } catch (err) {
      return { count: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }
  try {
    const listed = execFileSync('pgrep', ['-x', CLAUDE_PROC_POSIX], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const pids = listed.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (pids.length === 0) return { count: 0 };
    execFileSync('pkill', ['-x', CLAUDE_PROC_POSIX], { stdio: 'ignore' });
    return { count: pids.length };
  } catch {
    return { count: 0 };
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
