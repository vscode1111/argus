#!/usr/bin/env node
// Swap the live Argus daemon for a rebuilt binary of the SAME version.
//
// !notes/common/scripts/restart-daemon-detached.js is the general tool, but it decides
// "is the swap needed?" by comparing the discovery file's `version` against the target
// install's - so when the fix is a rebuild of an already-installed version (0.0.98 ->
// 0.0.98, different bytes) it short-circuits with "already vX; nothing to do". Same
// documented target-first sequence here, keyed on **pid** instead:
//   1. Spawn the target with ARGUS_DAEMON_FORCE_START=1 so it skips the single-instance
//      guard and camps on the port, retrying EADDRINUSE every 200ms for ~5s.
//   2. ~1.2s later kill the pid in the discovery file. The camper binds within 200ms and
//      rewrites the file, beating any old-install daemon a racing ensureDaemon started.
//   3. ~6s later confirm the registered pid actually changed and is alive.
//
// Must be spawned DETACHED with a --delay when run from inside an Argus conversation:
// the CLI answering it is a child of the daemon, so the kill in step 2 ends that turn.
//
// Usage: node swap-daemon-same-version.js --daemon-js <path> [--delay <ms>]

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.claude', 'argus-daemon.json');
const LOG = path.join(__dirname, 'swap-daemon-same-version.log');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const log = (m) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch { /* best-effort */ } };

const daemonJs = arg('--daemon-js', '');
const delay = Number(arg('--delay', '0'));

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

function readOwner() {
  try {
    const info = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    if (info && typeof info.pid === 'number') return { ...info, alive: isAlive(info.pid) };
  } catch { /* no file */ }
  return undefined;
}

if (!daemonJs || !fs.existsSync(daemonJs)) {
  log(`no such daemon build: ${daemonJs}; aborting`);
  process.exit(1);
}

setTimeout(() => {
  const before = readOwner();
  log(`start: registered pid ${before ? before.pid : '(none)'} v${before ? before.version : '?'} port ${before ? before.port : '?'}`);

  const child = spawn(process.execPath, [daemonJs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // Needed to skip the guard and camp on the still-held port. The daemon deletes this
    // from its own process.env once it has read it, so it is not inherited any further -
    // which is the entire point of this swap.
    env: { ...process.env, ARGUS_DAEMON_FORCE_START: '1' },
  });
  child.unref();
  log(`spawned target ${daemonJs} (pid ${child.pid}, force-start, camping on the port)`);

  setTimeout(() => {
    const cur = readOwner();
    if (cur && cur.alive && (!before || cur.pid === before.pid)) {
      try { process.kill(cur.pid); log(`killed old daemon pid ${cur.pid}`); }
      catch (err) { log(`failed to kill pid ${cur.pid}: ${err.message}`); }
    } else {
      log(`skipped kill: registered pid is now ${cur ? cur.pid : '(none)'}`);
    }

    setTimeout(() => {
      const fin = readOwner();
      if (fin && fin.alive && (!before || fin.pid !== before.pid)) {
        log(`success: daemon now pid ${fin.pid} v${fin.version} on port ${fin.port}`);
      } else {
        log(`FAILED: registered ${fin ? `pid ${fin.pid} alive=${fin.alive}` : '(no file)'}, expected a new pid`);
      }
    }, 6000);
  }, 1200);
}, delay);
