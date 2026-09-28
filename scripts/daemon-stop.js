// Stop the running Argus daemon: read its pid from the discovery file, kill it,
// and remove the file. A force-kill skips the daemon's own exit cleanup, so we
// clear the discovery file here too. Exits 0 when nothing is running (idempotent).
//
// The one thing this script must never do is remove the discovery file of a daemon
// that is still alive. That file is the only way anything reaches the daemon (its
// nonce exists nowhere else), and the port stays held, so a replacement dies on
// EADDRINUSE - the extension is then stranded permanently, which is a far worse
// outcome than "stop didn't work". Every branch below is written around that.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// ARGUS_DAEMON_FILE mirrors src/backend/daemonInfo.ts, so a test (or a second daemon
// on a private port) can point this script at a throwaway registration.
const FILE = process.env.ARGUS_DAEMON_FILE
  || path.join(os.homedir(), '.claude', 'argus-daemon.json');

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

async function waitGone(pid, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

// Confirm an Argus daemon is really answering on the recorded port before we kill
// the recorded pid. The pid on its own is not evidence of anything: a dead daemon's
// pid gets recycled, and on Windows it lands on one of VS Code's many `Code.exe`
// processes often enough that this script would have force-killed part of the user's
// editor while reporting "[argus-daemon] stopped". /health is loopback-only and
// returns our own JSON, so only a real daemon can satisfy it.
//
// Mirrors probeDaemon in src/backend/daemonInfo.ts, including the distinction that
// matters most here: a timeout AFTER the socket connected is 'busy', not 'down'. The
// daemon is single-threaded, so a long synchronous stretch (a large transcript read,
// an execFileSync in the kill path) stalls its HTTP handler well past any sane
// timeout. This script used to resolve that to "not serving" and then delete the file
// anyway, which is one of the ways a live daemon loses its registration. The rule is
// duplicated rather than imported on purpose: `yarn daemon:stop` has to work before
// anything is compiled, so this file stays dependency-free.
function probe(port) {
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    const done = (state, pid = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ state, pid });
    };
    const timer = setTimeout(() => done(connected ? 'busy' : 'down'), 3000);
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode === 200 && typeof parsed.pid === 'number') done('up', parsed.pid);
          else done('down'); // answered, but not with our JSON - someone else owns this port
        } catch { done('down'); }
      });
    });
    req.once('socket', (s) => { s.once('connect', () => { connected = true; }); });
    req.once('error', () => done('down'));
  });
}

async function main() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch {
    console.log('[argus-daemon] no discovery file; daemon not running');
    process.exit(0);
  }

  // Kill the pid the *port* reports, never the one the file merely claims. When
  // nothing answers, the file is stale and the pid it names belongs to somebody else.
  const { state, pid: servingPid } = typeof info.port === 'number'
    ? await probe(info.port)
    : { state: 'down', pid: null };

  if (state === 'busy') {
    // Something holds the port but did not answer in time, which is what a stalled
    // daemon looks like. Touching the file here is the one move that could turn a slow
    // daemon into an unreachable one, so leave both it and the process alone.
    console.error(`[argus-daemon] port ${info.port} is accepting connections but /health did not answer in time;`
      + ' leaving the daemon and its discovery file alone. Retry in a moment.');
    process.exit(1);
  }

  if (state === 'up' && servingPid !== null && isAlive(servingPid)) {
    try {
      process.kill(servingPid);
    } catch (err) {
      console.error(`[argus-daemon] failed to kill pid ${servingPid}: ${err.message};`
        + ' leaving the discovery file in place');
      process.exit(1);
    }
    // Verify rather than assume. A signal that was accepted is not a process that has
    // exited, and the file may only go once the daemon really has.
    if (!(await waitGone(servingPid, 3000))) {
      console.error(`[argus-daemon] pid ${servingPid} is still alive after the stop signal;`
        + ' leaving the discovery file in place');
      process.exit(1);
    }
    console.log(`[argus-daemon] stopped (pid ${servingPid}, port ${info.port})`);
  } else if (typeof info.pid === 'number' && isAlive(info.pid)) {
    console.log(`[argus-daemon] nothing is serving port ${info.port}; leaving pid ${info.pid} alone (not our daemon) and cleaning up the stale file`);
  } else {
    console.log('[argus-daemon] discovery file is stale (daemon not reachable); cleaning up');
  }

  try { fs.unlinkSync(FILE); } catch { /* already gone */ }
}

main();
