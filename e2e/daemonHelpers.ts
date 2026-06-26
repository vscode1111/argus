import { spawn, execSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';

// Helpers for the daemon integration specs. They spawn the real compiled daemon
// (out/backend/daemon.js) the extension auto-starts, but pointed at a throwaway
// discovery file and a private port via env, so they never touch the user's real
// ~/.claude/argus-daemon.json or collide with a running daemon.

const ROOT = path.resolve(__dirname, '..');
const DAEMON_JS = path.join(ROOT, 'out', 'backend', 'daemon.js');
const WEBVIEW_JS = path.join(ROOT, 'media', 'webview.js');
const WS_BRIDGE_JS = path.join(ROOT, 'media', 'ws-bridge.js');

// The daemon runs as compiled JS, so it must be built. Compile on demand (only when
// missing) so a fresh checkout still works without a manual step.
export function ensureCompiled(): void {
  if (!fs.existsSync(DAEMON_JS)) execSync('yarn compile', { cwd: ROOT, stdio: 'ignore' });
}

// The daemon-served browser UI needs the webview bundle + the shared ws-bridge.
export function ensureBuilt(): void {
  if (!fs.existsSync(WEBVIEW_JS) || !fs.existsSync(WS_BRIDGE_JS)) {
    execSync('yarn build', { cwd: ROOT, stdio: 'ignore' });
  }
}

export interface DaemonHandle {
  proc: ChildProcess;
  port: number;
  file: string;
}

export function uniqueDaemonFile(tag: string): string {
  return path.join(os.tmpdir(), `argus-daemon-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

export interface StartOpts {
  // Sets ARGUS_DAEMON_PORT (an env override). Omit when configPath is given so the
  // daemon takes its port from the config's daemonPort (lets a restart move the port).
  port?: number;
  idleMs?: number;
  file?: string;
  // Sets ARGUS_CONFIG to an isolated argus.json - the daemon reads daemonPort/idle
  // from it. Rewriting this file then restarting moves the daemon to the new port.
  configPath?: string;
}

export function uniqueConfigFile(tag: string): string {
  return path.join(os.tmpdir(), `argus-cfg-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

export function writeDaemonConfig(configPath: string, cfg: { daemonPort?: number; daemonIdleMs?: number }): void {
  fs.writeFileSync(configPath, JSON.stringify(cfg));
}

export function isPortUp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/nonce`, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(900, () => { req.destroy(); resolve(false); });
  });
}

// Spawn the daemon and resolve once it has written its discovery file (i.e. it is
// listening). Throws if the file never appears.
export async function startDaemon(opts: StartOpts): Promise<DaemonHandle> {
  const file = opts.file ?? uniqueDaemonFile('test');
  try { fs.unlinkSync(file); } catch { /* not there */ }
  const env: NodeJS.ProcessEnv = { ...process.env, ARGUS_DAEMON_FILE: file };
  if (opts.port != null) env.ARGUS_DAEMON_PORT = String(opts.port);
  else delete env.ARGUS_DAEMON_PORT; // let config drive the port
  if (opts.configPath) env.ARGUS_CONFIG = opts.configPath;
  if (opts.idleMs != null) env.ARGUS_DAEMON_IDLE_MS = String(opts.idleMs);
  else delete env.ARGUS_DAEMON_IDLE_MS;
  const proc = spawn(process.execPath, [DAEMON_JS], { cwd: ROOT, env, stdio: 'ignore' });
  const ok = await waitFor(() => fs.existsSync(file), 10_000);
  if (!ok) { try { proc.kill(); } catch { /* */ } throw new Error('daemon did not write its discovery file'); }
  return { proc, port: opts.port ?? readInfo(file).port, file };
}

export function readInfo(file: string): { port: number; nonce: string; pid: number; version: string; startedAt: number } {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function stopDaemon(h: DaemonHandle | undefined): void {
  if (!h) return;
  // Kill both the process we spawned and whatever the discovery file currently points
  // at - after a self-restart the live daemon is a different (handed-off) process.
  const pids = new Set<number>();
  if (h.proc.pid) pids.add(h.proc.pid);
  try { pids.add(readInfo(h.file).pid); } catch { /* no file */ }
  for (const pid of pids) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
  try { fs.unlinkSync(h.file); } catch { /* already gone */ }
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return await cond();
}
