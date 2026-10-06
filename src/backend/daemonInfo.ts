import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { execFileSync } from 'child_process';
import { ARGUS_DIR, LEGACY_ARGUS_DIR } from './paths';

// Discovery file the daemon writes on startup and the extension reads to find it.
// Holds the per-process nonce, so it is written mode 600.
// ARGUS_DAEMON_FILE overrides the path (used by e2e to isolate from the real daemon).
export const DAEMON_FILE = process.env.ARGUS_DAEMON_FILE
  || path.join(ARGUS_DIR, 'daemon.json');
const LEGACY_DAEMON_FILE = path.join(LEGACY_ARGUS_DIR, 'argus-daemon.json');

function discoveryFile(): string {
  return fs.existsSync(DAEMON_FILE) || process.env.ARGUS_DAEMON_FILE ? DAEMON_FILE : LEGACY_DAEMON_FILE;
}

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
    const raw = fs.readFileSync(discoveryFile(), 'utf-8');
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
  fs.mkdirSync(path.dirname(DAEMON_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(DAEMON_FILE, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
}

// Remove the discovery file. Pass `onlyIfPid` to make the removal ownership-aware:
// the file is left alone unless it registers that pid. A daemon that exits early
// (port taken, startup failure) must not wipe the registration of the live daemon
// that actually owns the port - doing so strands the extension, which then can
// neither connect (no file) nor respawn (port held), with the nonce lost to memory.
export function clearDaemonInfo(onlyIfPid?: number): void {
  if (onlyIfPid !== undefined && readDaemonInfo()?.pid !== onlyIfPid) return;
  try { fs.unlinkSync(discoveryFile()); } catch { /* already gone */ }
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

// What a liveness probe concluded about the daemon's recorded port:
//   'up'    - an Argus server answered /health there
//   'down'  - nothing is listening, or what answered is not an Argus server
//   'busy'  - the port accepts connections but /health did not answer in time
// 'busy' exists because the daemon is single-threaded: a long synchronous stretch
// (a big transcript read, an execFileSync in the kill path) can stall the HTTP
// handler well past any sane timeout. Reporting that as 'down' would let a caller
// discard the discovery file of a daemon that owns the port and is perfectly fine,
// whose replacement then exits on EADDRINUSE - stranding the extension with no file
// and no nonce, which is a worse failure than the one this probe exists to fix.
// So a timeout is deliberately NOT evidence of death; only a refused connection, or
// an answer that isn't ours, is.
export type DaemonProbe = 'up' | 'down' | 'busy';

// Ask the recorded port whether an Argus daemon is really there. /health is
// loopback-only and returns {configPath, pid}, so a valid answer proves three
// things a pid check cannot: something is listening, it is an Argus server, and
// which process it is. Used instead of isProcessAlive wherever the decision is
// "may I discard this discovery file / start a daemon", because the pid alone
// routinely says yes to a process that has nothing to do with Argus (measured:
// a discovery file's pid recycled onto a `Code.exe` VS Code utility process 15h
// after the daemon died, which the name heuristic above cannot reject - the
// extension launches the daemon as Code.exe, so Code.exe must stay allowed).
export function probeDaemon(port: number, timeoutMs = 3000): Promise<DaemonProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: DaemonProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(r);
    };
    // Tracks whether we ever got a socket: a timeout before connecting means
    // nothing is there ('down'), a timeout after means it is busy.
    let connected = false;
    const timer = setTimeout(() => done(connected ? 'busy' : 'down'), timeoutMs);
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c: string) => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { pid?: unknown };
          done(res.statusCode === 200 && typeof parsed.pid === 'number' ? 'up' : 'down');
        } catch {
          done('down'); // answered, but not with our JSON - someone else owns this port
        }
      });
    });
    req.once('socket', (s) => { s.once('connect', () => { connected = true; }); });
    req.once('error', () => done('down'));
  });
}

// Is the daemon recorded in `info` actually reachable. The pid is checked first
// only as a cheap negative (a dead pid is conclusive); the port probe is what
// decides, and an ambiguous 'busy' counts as alive on purpose - see DaemonProbe.
export async function isDaemonUp(info: DaemonInfo): Promise<boolean> {
  if (!isProcessAlive(info.pid)) return false;
  return (await probeDaemon(info.port)) !== 'down';
}
