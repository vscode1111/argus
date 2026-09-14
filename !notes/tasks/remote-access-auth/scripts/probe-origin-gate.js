// What exactly does the current network gate protect?
//
// `originAllowed()` in src/backend/index.ts decides on the **Origin header** alone; the
// upgrade handler never looks at `req.socket.remoteAddress`. If that reading is right,
// then with `allowNetworkAccess: false` a browser on the LAN is refused (it must send an
// Origin) while any non-browser client - curl, a script, anything that simply omits the
// header - is treated as local and let in from anywhere.
//
// Run against an isolated server so the user's real daemon is untouched:
//   node "!notes/tasks/remote-access-auth/scripts/probe-origin-gate.js"

const os = require('os');
const path = require('path');
const fs = require('fs');

const cfg = path.join(os.tmpdir(), `argus-probe-auth-${process.pid}.json`);
// The toggle OFF: "only this machine may connect" is what the UI promises here.
fs.writeFileSync(cfg, JSON.stringify({ allowNetworkAccess: false }));
process.env.ARGUS_CONFIG = cfg;
process.env.ARGUS_USAGE_POLL = '0';

const root = path.join(__dirname, '..', '..', '..', '..');
const WebSocket = require(path.join(root, 'node_modules', 'ws'));
const { startServer } = require(path.join(root, 'out', 'backend', 'index.js'));

const PORT = 3098;

function attempt(label, headers) {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${PORT}/agent?nonce=${NONCE}&dir=${encodeURIComponent(process.cwd())}`;
    const ws = new WebSocket(url, { headers });
    const done = (result) => { try { ws.close(); } catch {} resolve({ label, result }); };
    ws.on('open', () => done('CONNECTED'));
    ws.on('unexpected-response', (_req, res) => done(`refused ${res.statusCode}`));
    ws.on('error', (err) => done(`error ${err.message}`));
  });
}

let NONCE = '';

(async () => {
  const server = await startServer({ port: PORT });
  NONCE = server.nonce;

  const results = [];
  // A LAN browser: sends its page's Origin. Expected to be refused with the toggle off.
  results.push(await attempt('LAN browser  (Origin: http://192.168.0.136:5173)', { Origin: 'http://192.168.0.136:5173' }));
  // A script from anywhere: sends no Origin at all. This is the case under test.
  results.push(await attempt('script       (no Origin header)', {}));
  // Control: a genuine local browser must keep working.
  results.push(await attempt('local browser(Origin: http://localhost:5173)', { Origin: 'http://localhost:5173' }));

  console.log('allowNetworkAccess: false\n');
  for (const r of results) console.log(`  ${r.label} -> ${r.result}`);

  // And the second half of the question: is the nonce itself a secret?
  const res = await fetch(`http://127.0.0.1:${PORT}/nonce`);
  console.log(`\n  GET /nonce (no credentials) -> ${res.status} ${(await res.text()).slice(0, 8)}...`);

  server.close();
  fs.unlinkSync(cfg);
  setTimeout(() => process.exit(0), 200);
})().catch((err) => { console.error('probe failed:', err); process.exit(1); });
