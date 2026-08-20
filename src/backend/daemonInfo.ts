import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
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

// Remove the discovery file. Pass `onlyIfPid` to make the removal ownership-aware:
// the file is left alone unless it registers that pid. A daemon that exits early
// (port taken, startup failure) must not wipe the registration of the live daemon
// that actually owns the port - doing so strands the extension, which then can
// neither connect (no file) nor respawn (port held), with the nonce lost to memory.
export function clearDaemonInfo(onlyIfPid?: number): void {
  if (onlyIfPid !== undefined && readDaemonInfo()?.pid !== onlyIfPid) return;
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

// Ground-truth check: is anything actually accepting connections on the daemon's
// recorded port. A pid can look alive (isProcessAlive) for reasons that have
// nothing to do with the daemon - Windows recycles pids quickly, and the tasklist
// disambiguation above is itself a heuristic that could misfire on a differently
// localized system. A real TCP connect can't be fooled by any of that, so it backs
// isProcessAlive up as the final word before ensureDaemon decides to trust (or
// discard) a discovery file.
export function isPortListening(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
