// Stop the running Argus daemon: read its pid from the discovery file, kill it,
// and remove the file. A force-kill skips the daemon's own exit cleanup, so we
// clear the discovery file here too. Exits 0 when nothing is running (idempotent).
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.claude', 'argus-daemon.json');

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

let info;
try {
  info = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
} catch {
  console.log('[argus-daemon] no discovery file; daemon not running');
  process.exit(0);
}

if (typeof info.pid === 'number' && isAlive(info.pid)) {
  try {
    process.kill(info.pid);
    console.log(`[argus-daemon] stopped (pid ${info.pid}, port ${info.port})`);
  } catch (err) {
    console.error(`[argus-daemon] failed to kill pid ${info.pid}:`, err.message);
  }
} else {
  console.log('[argus-daemon] discovery file is stale (pid not alive); cleaning up');
}

try { fs.unlinkSync(FILE); } catch { /* already gone */ }
