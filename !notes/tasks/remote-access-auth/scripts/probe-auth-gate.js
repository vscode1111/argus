// Slice 1 end to end: does the gate actually refuse a remote peer, let a local one
// through untouched, and open only for a client that logged in?
//
// A connection to this machine's own LAN address (192.168.0.136) has a NON-loopback peer
// address, so it is classified remote by the same code path a phone hits - which makes
// every case below testable without a second machine.
//
//   node "!notes/tasks/remote-access-auth/scripts/probe-auth-gate.js"

const os = require('os');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..', '..', '..', '..');
const cfg = path.join(os.tmpdir(), `argus-probe-authgate-${process.pid}.json`);
const authFile = path.join(os.tmpdir(), `argus-probe-auth-${process.pid}.json`);
fs.writeFileSync(cfg, JSON.stringify({ allowNetworkAccess: true }));
process.env.ARGUS_CONFIG = cfg;
process.env.ARGUS_AUTH_FILE = authFile;   // never the real ~/.claude/argus-auth.json
process.env.ARGUS_USAGE_POLL = '0';

const WebSocket = require(path.join(root, 'node_modules', 'ws'));
const { startServer } = require(path.join(root, 'out', 'backend', 'index.js'));
const auth = require(path.join(root, 'out', 'backend', 'auth.js'));

const PORT = 3097;
const LAN = '192.168.0.136';   // this machine, reached over the network stack
const PASSWORD = 'scub-secret-123';
const USER = 'scub';

function ws(host, extra = '') {
  return new Promise((resolve) => {
    const url = `ws://${host}:${PORT}/agent?nonce=${NONCE}&dir=${encodeURIComponent(process.cwd())}${extra}`;
    const sock = new WebSocket(url);
    const done = (r) => { try { sock.close(); } catch {} resolve(r); };
    sock.on('open', () => done('CONNECTED'));
    sock.on('unexpected-response', (_q, res) => done(`refused ${res.statusCode}`));
    sock.on('error', (e) => done(`error ${e.message}`));
  });
}

async function nonceReq(host, token) {
  const res = await fetch(`http://${host}:${PORT}/nonce${token ? `?auth=${token}` : ''}`);
  return res.status;
}

async function login(host, user, password) {
  const res = await fetch(`http://${host}:${PORT}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let NONCE = '';
const line = (label, value) => console.log(`  ${label.padEnd(46)} ${value}`);

(async () => {
  const server = await startServer({ port: PORT });
  NONCE = server.nonce;

  console.log('\n== no password configured ==');
  line('remote WS, no Origin header (the hole)', await ws(LAN));
  line('remote GET /nonce', await nonceReq(LAN));
  line('LOCAL WS (control: must be untouched)', await ws('127.0.0.1'));
  line('LOCAL GET /nonce (control)', await nonceReq('127.0.0.1'));
  const noPass = await login(LAN, USER, 'anything');
  line('remote POST /login', `${noPass.status} ${noPass.body.error ?? ''}`);

  console.log('\n== password configured ==');
  console.log('  ' + JSON.stringify(auth.setPassword(USER, PASSWORD)));
  const wrong = await login(LAN, USER, 'wrong-password');
  line('remote POST /login (wrong)', `${wrong.status} ${wrong.body.error ?? ''}`);
  const right = await login(LAN, USER, PASSWORD);
  line('remote POST /login (right)', `${right.status} token=${String(right.body.token).slice(0, 8)}...`);
  const token = right.body.token;

  line('remote GET /nonce WITH token', await nonceReq(LAN, token));
  line('remote GET /nonce WITHOUT token', await nonceReq(LAN));
  line('remote WS WITH token', await ws(LAN, `&auth=${token}`));
  line('remote WS WITHOUT token', await ws(LAN));
  line('remote WS with a made-up token', await ws(LAN, '&auth=' + 'f'.repeat(64)));
  line('LOCAL WS (control: still no login needed)', await ws('127.0.0.1'));

  console.log('\n== rate limiting ==');
  for (let i = 1; i <= 6; i++) {
    const r = await login(LAN, USER, `bad-${i}`);
    line(`attempt ${i}`, `${r.status} ${r.body.error ?? ''}${r.body.retryAfterMs ? ` (retry in ${Math.round(r.body.retryAfterMs / 1000)}s)` : ''}`);
  }
  const blocked = await login(LAN, USER, PASSWORD);
  line('correct password while locked out', `${blocked.status} ${blocked.body.error ?? ''}`);

  console.log('\n== password change revokes sessions ==');
  auth.resetAuthState();
  const t2 = (await login(LAN, USER, PASSWORD)).body.token;
  line('fresh token works', await ws(LAN, `&auth=${t2}`));
  console.log('  ' + JSON.stringify(auth.setPassword(USER, 'scub-other-456', PASSWORD)));
  line('same token after password change', await ws(LAN, `&auth=${t2}`));

  console.log('\n== stored file ==');
  const stored = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  line('contains plaintext password?', JSON.stringify(stored).includes('scub-other-456') ? 'YES - BUG' : 'no');
  line('fields', Object.keys(stored).join(', '));

  server.close();
  fs.unlinkSync(cfg);
  fs.unlinkSync(authFile);
  setTimeout(() => process.exit(0), 200);
})().catch((err) => { console.error('probe failed:', err); process.exit(1); });
