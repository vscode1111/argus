import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { startServer } from './index';
import { readConfig } from './config';
import {
  DEFAULT_DAEMON_PORT,
  readDaemonInfo,
  writeDaemonInfo,
  clearDaemonInfo,
  isProcessAlive,
} from './daemonInfo';

// Always-on daemon: a single shared server on a fixed port that stays alive while
// at least one webview is connected and self-exits after 10 minutes of zero
// clients. Started on demand by the launcher (cmd/start-argus-daemon.bat /
// `yarn daemon`); the extension is connect-only and never spawns its own server.

const cfg = readConfig();
// Idle precedence: ARGUS_DAEMON_IDLE_MS env (used by e2e) > argus.json daemonIdleMs
// > 10 min. Port precedence: ARGUS_DAEMON_PORT env > argus.json daemonPort > 3017.
// The discovery file records the actual port, so the extension and the daemon-served
// browser pick it up automatically. Both need a daemon restart to apply.
const IDLE_TIMEOUT_MS = Number(process.env.ARGUS_DAEMON_IDLE_MS) || cfg.daemonIdleMs || 10 * 60 * 1000;
const PORT = process.env.ARGUS_DAEMON_PORT
  ? parseInt(process.env.ARGUS_DAEMON_PORT, 10)
  : (cfg.daemonPort || DEFAULT_DAEMON_PORT);
const MODEL = process.env.ARGUS_MODEL ?? '';
// A force-start replacement (spawned by an in-browser "restart daemon" request) must
// skip the single-instance guard - the old daemon is still alive while it hands off.
const FORCE_START = process.env.ARGUS_DAEMON_FORCE_START === '1';

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '';
  } catch {
    return '';
  }
}

// Idempotent launch: if a discovery file points at a live daemon process, do not
// start a second one. A crashed daemon leaves a stale file whose pid is dead, so we
// fall through and start fresh. A force-start replacement skips this entirely.
if (!FORCE_START) {
  const existing = readDaemonInfo();
  if (existing && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
    console.log(`[argus-daemon] already running (pid ${existing.pid}, port ${existing.port}); exiting`);
    process.exit(0);
  }
}

// Skip clearing the discovery file when handing off to a replacement (the new daemon
// owns it), so a same-pid handoff doesn't leave the extension without a file.
let handingOff = false;
let shuttingDown = false;
function cleanup(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!handingOff) clearDaemonInfo();
}

// Spawn a replacement daemon that takes over (used to apply a new port/idle from the
// browser-served UI, where there is no extension to respawn us). The replacement
// force-starts and retries binding until we release the port, then writes the
// discovery file; we exit shortly after.
function respawn(): void {
  handingOff = true;
  // Reconstruct the exact launch: process.execArgv carries any node flags - critically
  // the tsx loader (--require/--import) when running `yarn daemon` (tsx src/...ts).
  // Spawning bare `node src/backend/daemon.ts` would crash on the TypeScript syntax;
  // for the compiled out/backend/daemon.js, execArgv is empty so it is just `node daemon.js`.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, ARGUS_DAEMON_FORCE_START: '1' },
  });
  child.unref();
}

// Bind, retrying on EADDRINUSE for a short window so a force-start replacement can
// wait for the outgoing daemon to release the (possibly same) port.
async function listen(attempt = 0): Promise<void> {
  try {
    const server = await startServer({
      port: PORT,
      model: MODEL,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      onIdleShutdown: () => { cleanup(); process.exit(0); },
      onRespawn: respawn,
    });
    writeDaemonInfo({
      port: server.port,
      nonce: server.nonce,
      pid: process.pid,
      version: readVersion(),
      startedAt: Date.now(),
    });
    console.log(`[argus-daemon] listening on ws://localhost:${server.port}/agent (pid ${process.pid}); idle-exit in ${IDLE_TIMEOUT_MS / 60000}m with no clients`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE' && FORCE_START && attempt < 25) {
      // Outgoing daemon hasn't released the port yet - wait and retry.
      await new Promise((r) => setTimeout(r, 200));
      return listen(attempt + 1);
    }
    if (e.code === 'EADDRINUSE') {
      console.error(`[argus-daemon] port ${PORT} already in use; another process owns it. Exiting.`);
    } else {
      console.error('[argus-daemon] failed to start:', e);
    }
    process.exit(1);
  }
}

listen();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { cleanup(); process.exit(0); });
}
process.on('exit', cleanup);
