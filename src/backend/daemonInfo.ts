import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// Discovery file the daemon writes on startup and the extension reads to find it.
// Lives in the user-owned ~/.claude/ (same trust boundary as .dev-nonce and
// .credentials.json). Holds the per-process nonce, so it is written mode 600.
// ARGUS_DAEMON_FILE overrides the path (used by e2e to isolate from the real daemon).
export const DAEMON_FILE = process.env.ARGUS_DAEMON_FILE
  || path.join(os.homedir(), '.claude', 'argus-daemon.json');

// Fixed default port for the daemon, distinct from dev's 3001. Override via
// ARGUS_DAEMON_PORT for testing or to dodge a port conflict.
export const DEFAULT_DAEMON_PORT = parseInt(process.env.ARGUS_DAEMON_PORT ?? '3017', 10);

export interface DaemonInfo {
  port: number;
  nonce: string;
  pid: number;
  version: string;
  startedAt: number;
}

export function readDaemonInfo(): DaemonInfo | undefined {
  try {
    const raw = fs.readFileSync(DAEMON_FILE, 'utf-8');
    const info = JSON.parse(raw) as Partial<DaemonInfo>;
    if (typeof info.port !== 'number' || typeof info.nonce !== 'string' || typeof info.pid !== 'number') {
      return undefined;
    }
    return info as DaemonInfo;
  } catch {
    return undefined;
  }
}

export function writeDaemonInfo(info: DaemonInfo): void {
  fs.mkdirSync(path.dirname(DAEMON_FILE), { recursive: true });
  fs.writeFileSync(DAEMON_FILE, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
}

export function clearDaemonInfo(): void {
  try { fs.unlinkSync(DAEMON_FILE); } catch { /* already gone */ }
}

// Whether a process with the given pid is currently running. `kill(pid, 0)` sends
// no signal but throws ESRCH if the process does not exist (EPERM means it exists
// but is owned by another user - still alive).
// On Windows, PIDs recycle quickly. After confirming the pid exists, we verify it
// belongs to node.exe or Code.exe (Electron-as-node) so a stale discovery file
// whose pid was recycled by an unrelated process (e.g. conhost) doesn't block a
// fresh daemon from starting.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (process.platform !== 'win32') return true;
  try {
    const out = execFileSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'],
      { encoding: 'utf-8', timeout: 2000 }) as string;
    return /^"(node|Code)\.exe"/im.test(out);
  } catch {
    return true; // can't verify, assume alive
  }
}
