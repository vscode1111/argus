// Stop the running Argus daemon: read its pid from the discovery file, kill it,
// and remove the file. A force-kill skips the daemon's own exit cleanup, so we
// clear the discovery file here too. Exits 0 when nothing is running (idempotent).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const FILE = path.join(os.homedir(), '.claude', 'argus-daemon.json');

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

// Confirm an Argus daemon is really answering on the recorded port before we kill
// the recorded pid. The pid on its own is not evidence of anything: a dead daemon's
// pid gets recycled, and on Windows it lands on one of VS Code's many `Code.exe`
// processes often enough that this script would have force-killed part of the user's
// editor while reporting "[argus-daemon] stopped". /health is loopback-only and
// returns our own JSON, so only a real daemon can satisfy it.
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(res.statusCode === 200 && typeof parsed.pid === 'number' ? parsed.pid : null);
        } catch { resolve(null); }
      });
    });
    req.once('timeout', () => { req.destroy(); resolve(null); });
    req.once('error', () => resolve(null));
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
  const servingPid = typeof info.port === 'number' ? await probe(info.port) : null;

  if (servingPid !== null && isAlive(servingPid)) {
    try {
      process.kill(servingPid);
      console.log(`[argus-daemon] stopped (pid ${servingPid}, port ${info.port})`);
    } catch (err) {
      console.error(`[argus-daemon] failed to kill pid ${servingPid}:`, err.message);
    }
  } else if (typeof info.pid === 'number' && isAlive(info.pid)) {
    console.log(`[argus-daemon] nothing is serving port ${info.port}; leaving pid ${info.pid} alone (not our daemon) and cleaning up the stale file`);
  } else {
    console.log('[argus-daemon] discovery file is stale (daemon not reachable); cleaning up');
  }

  try { fs.unlinkSync(FILE); } catch { /* already gone */ }
}

main();
