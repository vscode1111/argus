// Swap the Argus daemon to a target build from outside its own process tree,
// optionally after a delay. Needed when the restart is requested from INSIDE an
// Argus conversation: the CLI serving that conversation is a child of the
// daemon, and its stdout pipe breaks the moment the daemon dies; an immediate
// daemon-stop kills the very turn that asked for it. Scheduling this script
// detached with --delay lets the turn finish first.
//
// Usage: node restart-daemon-detached.js [--delay <ms>] [--daemon-js <path>]
//   --delay      ms to wait before acting (default 0)
//   --daemon-js  daemon build to start; default: newest
//                ~/.vscode/extensions/local.argus-*/out/backend/daemon.js
//
// Spawn it detached so it survives the caller (and the caller's CLI):
//   node -e "const{spawn}=require('child_process');spawn(process.execPath,
//     ['<this file>','--delay','15000'],
//     {detached:true,stdio:'ignore',windowsHide:true}).unref()"
//
// Sequence (target-first, to win the respawn race): any still-open VS Code
// window running an OLD extension install respawns its own build via
// ensureDaemon within the same second the daemon dies (observed 2026-08-06:
// a 0.0.80 window respawned 0.0.80 while 0.0.82 was installed). A
// kill-then-start script loses that race. So instead:
//   1. Spawn the TARGET build with ARGUS_DAEMON_FORCE_START=1. It skips the
//      single-instance guard and retries EADDRINUSE every 200ms for ~5s,
//      camping on the port the old daemon still holds.
//   2. ~1.2s later, kill the discovery-file pid. The port frees; the camping
//      target binds within 200ms and writes the discovery file. An old-install
//      daemon spawned by a racing ensureDaemon boots slower than that, then
//      exits via its own single-instance guard or non-force EADDRINUSE.
//   3. ~6s later, verify the discovery file shows the target version; retry
//      the whole sequence once if not.
// A daemon registered at the target version is never killed (pre-check per
// attempt), so racing against a window that runs the TARGET install is fine.
// Appends what it did to restart-daemon-detached.log next to it.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.claude', 'argus-daemon.json');
const LOG = path.join(__dirname, 'restart-daemon-detached.log');
const MAX_ATTEMPTS = 2;

function log(msg) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch { /* best-effort */ }
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function newestInstalledDaemon() {
  const extDir = path.join(os.homedir(), '.vscode', 'extensions');
  let names;
  try { names = fs.readdirSync(extDir); } catch { return undefined; }
  const installs = names
    .filter((n) => /^local\.argus-\d+\.\d+\.\d+$/.test(n))
    .sort((a, b) => {
      const va = a.split('-').pop().split('.').map(Number);
      const vb = b.split('-').pop().split('.').map(Number);
      return (va[0] - vb[0]) || (va[1] - vb[1]) || (va[2] - vb[2]);
    });
  if (!installs.length) return undefined;
  return path.join(extDir, installs[installs.length - 1], 'out', 'backend', 'daemon.js');
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

// {pid, version, port, alive} from the discovery file, or undefined.
function readOwner() {
  try {
    const info = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    if (info && typeof info.pid === 'number') return { ...info, alive: isAlive(info.pid) };
  } catch { /* no file */ }
  return undefined;
}

const delay = Number(arg('--delay', '0'));
const daemonJs = arg('--daemon-js', '') || newestInstalledDaemon();
// Known only for installed-extension paths; a repo out/ build has no version
// in its path, so verification degrades to logging the final owner.
const targetVersion = daemonJs ? (daemonJs.match(/local\.argus-(\d+\.\d+\.\d+)/) || [])[1] : undefined;

function attempt(n) {
  const owner = readOwner();
  if (owner && owner.alive && targetVersion && owner.version === targetVersion) {
    log(`daemon already v${targetVersion} (pid ${owner.pid}); nothing to do`);
    return;
  }
  const child = spawn(process.execPath, [daemonJs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ARGUS_DAEMON_FORCE_START: '1' },
  });
  child.unref();
  log(`attempt ${n}: started ${daemonJs} (pid ${child.pid}, force-start, camping on the port)`);

  setTimeout(() => {
    const cur = readOwner();
    if (cur && cur.alive && (!targetVersion || cur.version !== targetVersion)) {
      try {
        process.kill(cur.pid);
        log(`killed old daemon pid ${cur.pid} (v${cur.version}, port ${cur.port})`);
      } catch (err) {
        log(`failed to kill pid ${cur.pid}: ${err.message}`);
      }
    }

    setTimeout(() => {
      const fin = readOwner();
      if (fin && fin.alive && targetVersion && fin.version === targetVersion) {
        log(`success: daemon now pid ${fin.pid} v${fin.version} on port ${fin.port}`);
        return;
      }
      if (fin && fin.alive && !targetVersion) {
        log(`final owner: pid ${fin.pid} v${fin.version} on port ${fin.port} (target version unknown, verify manually)`);
        return;
      }
      const state = fin && fin.alive ? `still v${fin.version} (pid ${fin.pid})` : 'no live daemon registered';
      if (n < MAX_ATTEMPTS) {
        log(`${state}; retrying`);
        return attempt(n + 1);
      }
      log(`gave up: ${state}`);
    }, 6000);
  }, 1200);
}

if (!daemonJs || !fs.existsSync(daemonJs)) {
  log(`no daemon build found (looked for: ${daemonJs}); aborting`);
  process.exit(1);
}
setTimeout(() => attempt(1), delay);
