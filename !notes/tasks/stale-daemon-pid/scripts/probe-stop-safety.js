// daemon-stop.js used to kill whatever pid the discovery file named. With a recycled
// pid that is somebody else's process. This stands a decoy in for that process and
// asserts the script leaves it alone. Restores the real discovery file afterwards.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.claude', 'argus-daemon.json');
const BACKUP = FILE + '.probe-backup';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const hadReal = fs.existsSync(FILE);
if (hadReal) fs.copyFileSync(FILE, BACKUP);

// A live process that is NOT serving anything - the recycled pid's stand-in.
const decoy = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
setTimeout(() => {
  try {
    console.log(`decoy pid ${decoy.pid} alive before: ${alive(decoy.pid)}`);
    // Point the discovery file at the decoy, on a port nothing listens on.
    fs.writeFileSync(FILE, JSON.stringify({ port: 59999, nonce: 'x', pid: decoy.pid, version: '0', startedAt: 0 }));

    const out = execFileSync(process.execPath, [path.join(__dirname, '..', '..', '..', '..', 'scripts', 'daemon-stop.js')], { encoding: 'utf-8' });
    console.log('daemon-stop said:', out.trim());
    console.log(`decoy pid ${decoy.pid} alive after : ${alive(decoy.pid)}   (expect true - must NOT be killed)`);
    console.log(`stale file cleaned up            : ${!fs.existsSync(FILE)}   (expect true)`);
  } finally {
    if (hadReal) { fs.copyFileSync(BACKUP, FILE); fs.unlinkSync(BACKUP); console.log('real discovery file restored'); }
    decoy.kill();
  }
}, 400);
