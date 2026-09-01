// Smoke-test a freshly installed Argus daemon build BEFORE swapping the live one.
// A broken build would otherwise leave the machine with no daemon at all: the
// restart script kills the running owner and the replacement never binds.
//
// Runs the target daemon.js on a private port with a throwaway discovery file
// (so ~/.claude/argus-daemon.json and the real port are never touched), then
// checks the three things the extension and the browser UI actually need:
//   1. it registers itself (discovery file with the expected version)
//   2. GET /nonce answers (the WS handshake source for both hosts)
//   3. GET / serves the browser UI (proves media/ made it into the package)
//
// Usage: node probe-new-daemon.js <path-to-out/backend/daemon.js>

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const daemonJs = process.argv[2];
if (!daemonJs || !fs.existsSync(daemonJs)) {
  console.error(`no such daemon build: ${daemonJs}`);
  process.exit(1);
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const get = (port, urlPath) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 4000 }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
  });
  req.on('error', (err) => resolve({ error: err.message }));
  req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const port = await freePort();
  const file = path.join(os.tmpdir(), `argus-probe-${process.pid}.json`);
  const child = spawn(process.execPath, [daemonJs], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      ARGUS_DAEMON_PORT: String(port),
      ARGUS_DAEMON_FILE: file,
      ARGUS_DAEMON_IDLE_MS: '20000',
      ARGUS_DAEMON_FORCE_START: '1',
      // Never let a probe spawn a real CLI turn or hit the rate-limited usage API.
      ARGUS_MODEL_REFRESH: '0',
      ARGUS_USAGE_POLL: '0',
    },
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });

  let info;
  for (let i = 0; i < 40 && !info; i++) {
    await sleep(250);
    try { info = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* not written yet */ }
  }

  const results = {};
  results.registered = info ? `pid ${info.pid} v${info.version} port ${info.port}` : 'NO discovery file';
  if (info) {
    const nonce = await get(port, '/nonce');
    results.nonce = nonce.error ? `ERROR ${nonce.error}` : `${nonce.status} (${String(nonce.body).length} bytes)`;
    const root = await get(port, '/');
    const html = String(root.body || '');
    results.browserUi = root.error
      ? `ERROR ${root.error}`
      : `${root.status} ${root.type} ${html.includes('<div id="root"') || html.includes('id="root"') ? 'has #root' : 'NO #root'}`;
  }

  try { child.kill(); } catch { /* already gone */ }
  await sleep(400);
  try { fs.unlinkSync(file); } catch { /* best-effort */ }

  for (const [k, v] of Object.entries(results)) console.log(`${k}: ${v}`);
  if (stderr.trim()) console.log(`stderr: ${stderr.trim().slice(0, 500)}`);
  const ok = info && String(results.nonce).startsWith('200') && String(results.browserUi).startsWith('200');
  console.log(ok ? 'PROBE OK' : 'PROBE FAILED');
  process.exit(ok ? 0 : 1);
})();
