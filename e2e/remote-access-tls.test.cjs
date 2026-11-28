// Backend tests for HTTPS remote access (src/backend/tls.ts and the HTTPS listener in
// src/backend/index.ts). Certificates are generated per run; see remote-test-helpers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { lanAddress, makeCerts } = require('./remote-test-helpers.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-tls-test-'));
const cfgFile = path.join(root, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ allowNetworkAccess: true }));
Object.assign(process.env, {
  ARGUS_CONFIG: cfgFile,
  ARGUS_AUTH_FILE: path.join(root, 'auth.json'),
  ARGUS_ACCESS_LOG_DB: path.join(root, 'access.sqlite'),
  ARGUS_USAGE_POLL: '0',
  ARGUS_MODEL_REFRESH: '0',
});

const lanIps = Object.values(os.networkInterfaces()).flatMap((e) => (e ?? []))
  .filter((e) => e.family === 'IPv4' && !e.internal).map((e) => e.address);
const certs = makeCerts(root, { ips: ['127.0.0.1', ...lanIps] });
const SKIP = certs ? false : 'openssl is not available to generate test certificates';

const { startServer } = require('../out/backend/index');
const auth = require('../out/backend/auth');
const accessLog = require('../out/backend/accessLog');

const HTTP_PORT = 3193;
const TLS_PORT = 3194;
const PW = 'scub-tls-test-password';
let server;

/** Fresh connection every time (agent: false): a pooled, already-verified socket would
 * let an untrusted request "succeed" without any handshake - a false pass seen while
 * writing this. */
function request(url, options = {}) {
  const { method = 'GET', body } = options;
  // 'ca' in options, not a destructuring default: a default would turn an explicit
  // `ca: undefined` (the "untrusted client" control) back into the trusted CA.
  const ca = 'ca' in options ? options.ca : certs?.ca;
  return new Promise((resolve) => {
    const req = https.request(url, { method, ca, agent: false, timeout: 3000, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
function openSocket(url, options = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, options);
    ws.on('open', () => resolve({ ws, result: 'open' }));
    ws.on('unexpected-response', (_q, res) => resolve({ ws, result: `refused ${res.statusCode}` }));
    ws.on('error', (e) => resolve({ ws, result: `error ${e.message}` }));
  });
}
function serverInfo(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no serverInfo')), 5000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'serverInfo') { clearTimeout(timer); resolve(msg); }
    });
    ws.send(JSON.stringify({ type: 'getServerInfo' }));
  });
}
const health = async (port) => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).https;
const localNonce = async () => (await fetch(`http://127.0.0.1:${HTTP_PORT}/nonce`)).text();
async function waitFor(check, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

before(async () => {
  if (SKIP) return;
  server = await startServer({ port: HTTP_PORT, tls: { port: TLS_PORT, cert: certs.cert, key: certs.key } });
  assert.ok(await waitFor(async () => (await request(`https://127.0.0.1:${TLS_PORT}/`)).status === 200), 'HTTPS came up');
});
after(() => {
  server?.close();
  accessLog.closeAccessLog();   // Windows cannot delete a database file that is still open
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- loadTlsSettings -------------------------------------------------------------
// CONFIG_PATH is fixed at import, so each case runs in a child process with its own
// ARGUS_CONFIG. The key command is a tiny script printing a file, optionally failing.

const printer = path.join(root, 'print-key.js');
fs.writeFileSync(printer, `
const [file, code] = process.argv.slice(2);
if (file) process.stdout.write(require('fs').readFileSync(file, 'utf8'));
process.stderr.write(code ? 'vault: key not found' : '');
process.exit(Number(code) || 0);
`);
const keyCommand = (file, code = 0) => `"${process.execPath}" "${printer}" "${file}" ${code}`;

function loadIn(config) {
  const file = path.join(root, `cfg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(config));
  const script = `
    const logs = [];
    const s = require(${JSON.stringify(path.resolve(__dirname, '..', 'out', 'backend', 'tls.js'))}).loadTlsSettings((m) => logs.push(m));
    process.stdout.write(JSON.stringify({ loaded: !!s, port: s && s.port, keyOk: !!s && s.key.includes('PRIVATE KEY'), logs }));`;
  const run = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, ARGUS_CONFIG: file }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('loadTlsSettings: off unless tlsPort is set', { skip: SKIP }, () => {
  assert.deepEqual(loadIn({}), { loaded: false, keyOk: false, logs: [] });
  assert.deepEqual(loadIn({ tlsPort: 0, tlsCertFile: certs.certFile, tlsKeyCommand: keyCommand(certs.keyFile) }).loaded, false);
});

test('loadTlsSettings: loads the certificate and the key from the command', { skip: SKIP }, () => {
  const r = loadIn({ tlsPort: 4443, tlsCertFile: certs.certFile, tlsKeyCommand: keyCommand(certs.keyFile) });
  assert.deepEqual(r, { loaded: true, port: 4443, keyOk: true, logs: [] });
});

test('loadTlsSettings: refuses incomplete settings, a missing cert and a mismatched key', { skip: SKIP }, () => {
  const missing = loadIn({ tlsPort: 4443, tlsCertFile: certs.certFile });
  assert.equal(missing.loaded, false);
  assert.match(missing.logs.join('\n'), /tlsCertFile or tlsKeyCommand is missing/);

  const noCert = loadIn({ tlsPort: 4443, tlsCertFile: path.join(root, 'nope.pem'), tlsKeyCommand: keyCommand(certs.keyFile) });
  assert.equal(noCert.loaded, false);
  assert.match(noCert.logs.join('\n'), /cannot read/);

  // Valid key, wrong one: serving it would fail every handshake, so refuse at load.
  const mismatch = loadIn({ tlsPort: 4443, tlsCertFile: certs.certFile, tlsKeyCommand: keyCommand(certs.otherKeyFile) });
  assert.equal(mismatch.loaded, false);
  assert.match(mismatch.logs.join('\n'), /does not match/);
});

test('loadTlsSettings: a failing command reports its stderr and never the key', { skip: SKIP }, () => {
  // The command prints the real key to stdout AND fails: the log must carry the
  // reason (stderr) without a single byte of stdout.
  const r = loadIn({ tlsPort: 4443, tlsCertFile: certs.certFile, tlsKeyCommand: keyCommand(certs.keyFile, 3) });
  assert.equal(r.loaded, false);
  const log = r.logs.join('\n');
  assert.match(log, /exit 3/);
  assert.match(log, /vault: key not found/);
  assert.ok(!log.includes('PRIVATE KEY'), 'key material leaked into the log');
});

// ---- HTTPS listener ---------------------------------------------------------------

test('HTTPS serves the app with a certificate the CA verifies, and only to clients that trust it', { skip: SKIP }, async () => {
  const page = await request(`https://127.0.0.1:${TLS_PORT}/`);
  assert.equal(page.status, 200);
  assert.match(page.data, /<html/i);
  // Control: the same request without the CA must fail the handshake.
  const untrusted = await request(`https://127.0.0.1:${TLS_PORT}/`, { ca: undefined });
  assert.equal(untrusted.status, 0);
  assert.match(untrusted.error, /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY/);
  // No plaintext on the TLS port: it is not a second HTTP port.
  const plain = await fetch(`http://127.0.0.1:${TLS_PORT}/`).then((r) => r.status).catch(() => 'error');
  assert.notEqual(plain, 200);
  // And the HTTP port is untouched for local panels.
  assert.equal((await fetch(`http://127.0.0.1:${HTTP_PORT}/nonce`)).status, 200);
  assert.deepEqual(await health(HTTP_PORT), { state: 'ready', port: TLS_PORT });
});

test('a remote client over HTTPS goes through the same login gate', { skip: SKIP }, async (t) => {
  const LAN = await lanAddress(TLS_PORT);
  if (!LAN) return t.skip('no non-loopback interface on this machine');
  auth.resetAuthState();
  assert.equal(auth.setPassword('scub', PW).ok, true);
  const dir = encodeURIComponent(root);
  const base = `https://${LAN}:${TLS_PORT}`;
  assert.equal((await request(`${base}/nonce`)).status, 401);
  assert.equal((await request(`${base}/login`, { method: 'POST', body: { user: 'scub', password: 'wrong-one' } })).status, 401);
  const ok = await request(`${base}/login`, { method: 'POST', body: { user: 'scub', password: PW } });
  assert.equal(ok.status, 200);
  const token = JSON.parse(ok.data).token;
  const nonceRes = await request(`${base}/nonce?auth=${token}`);
  assert.equal(nonceRes.status, 200);

  const refused = await openSocket(`wss://${LAN}:${TLS_PORT}/agent?nonce=${nonceRes.data}&dir=${dir}`, { ca: certs.ca });
  assert.equal(refused.result, 'refused 401');
  const open = await openSocket(`wss://${LAN}:${TLS_PORT}/agent?nonce=${nonceRes.data}&dir=${dir}&auth=${token}`, { ca: certs.ca });
  assert.equal(open.result, 'open');
  open.ws.close();
  // The access log sees HTTPS attempts like any other.
  const { DatabaseSync } = require('node:sqlite');
  assert.ok(await waitFor(() => {
    const db = new DatabaseSync(process.env.ARGUS_ACCESS_LOG_DB, { readOnly: true });
    try { return db.prepare("SELECT count(*) n FROM access_log WHERE event = 'ws_open'").get().n > 0; } finally { db.close(); }
  }));
});

test('a connection over HTTPS reports the daemon port, not the TLS port', { skip: SKIP }, async () => {
  // Channels and spawned agents are keyed by the server port. A TLS socket's own local
  // port is the TLS port, so without the explicit mapping a phone would land in a
  // channel of its own, apart from the local panels in the same workspace.
  const nonce = await localNonce();
  const dir = encodeURIComponent(root);
  const secure = await openSocket(`wss://127.0.0.1:${TLS_PORT}/agent?nonce=${nonce}&dir=${dir}`, { ca: certs.ca });
  assert.equal(secure.result, 'open');
  const plain = await openSocket(`ws://127.0.0.1:${HTTP_PORT}/agent?nonce=${nonce}&dir=${dir}`);
  assert.equal(plain.result, 'open');
  try {
    assert.equal((await serverInfo(secure.ws)).port, HTTP_PORT);
    assert.equal((await serverInfo(plain.ws)).port, HTTP_PORT);   // control
  } finally {
    secure.ws.close();
    plain.ws.close();
  }
});

test('HTTPS waits for a busy port (daemon handoff) and HTTP is never held up by it', { skip: SKIP }, async () => {
  // A replacement daemon starts while the outgoing one still holds the TLS port.
  const port = 3196;
  // Drops every connection at once, so a probe gets a prompt failure instead of a
  // handshake that never completes.
  const blocker = net.createServer((s) => s.destroy()).listen(port);
  await new Promise((r) => blocker.once('listening', r));
  const second = await startServer({ port: 3195, tls: { port, cert: certs.cert, key: certs.key } });
  try {
    // HTTP is up immediately, before the TLS port is free.
    assert.equal((await fetch('http://127.0.0.1:3195/nonce')).status, 200);
    assert.equal((await request(`https://127.0.0.1:${port}/`)).status, 0);
    const waiting = await health(3195);
    assert.equal(waiting.state, 'starting');
    assert.match(waiting.error, /EADDRINUSE/);
    await new Promise((r) => blocker.close(r));
    assert.ok(await waitFor(async () => (await request(`https://127.0.0.1:${port}/`)).status === 200), 'HTTPS took the port once released');
    assert.deepEqual(await health(3195), { state: 'ready', port });
  } finally {
    second.close();
  }
});

// ---- HTTPS status on /health --------------------------------------------------------
// The daemon runs with its output discarded, so a failed HTTPS listener used to be
// invisible: on 2026-11-28 a live daemon came up without HTTPS and nothing said why.

test('a TLS port held past the fast retries is waited out, and /health says why', { skip: SKIP }, async () => {
  // The 2026-11-28 failure: a move to a new HTTP port left the old daemon holding the TLS
  // port for ~7 s, longer than the 5 s of fast retries, and HTTPS stayed down for good.
  const port = 3197;
  const blocker = net.createServer((s) => s.destroy()).listen(port);
  await new Promise((r) => blocker.once('listening', r));
  const s = await startServer({ port: 3198, tls: { port, cert: certs.cert, key: certs.key } });
  try {
    await new Promise((r) => setTimeout(r, 7000));   // past the fast window
    const waiting = await health(3198);
    assert.equal(waiting.state, 'starting');
    assert.equal(waiting.port, port);
    assert.match(waiting.error, /EADDRINUSE/);
    assert.equal((await fetch('http://127.0.0.1:3198/nonce')).status, 200);   // HTTP unaffected
    await new Promise((r) => blocker.close(r));
    assert.ok(await waitFor(async () => (await health(3198)).state === 'ready', 8000), 'HTTPS took the port once released');
    assert.deepEqual(await health(3198), { state: 'ready', port });
    assert.equal((await request(`https://127.0.0.1:${port}/`)).status, 200);
  } finally {
    s.close();
    if (blocker.listening) await new Promise((r) => blocker.close(r));
  }
});

test('close() stops a pending HTTPS wait, so a closed server never takes the port later', { skip: SKIP }, async () => {
  const port = 3203;
  const blocker = net.createServer((s) => s.destroy()).listen(port);
  await new Promise((r) => blocker.once('listening', r));
  const s = await startServer({ port: 3204, tls: { port, cert: certs.cert, key: certs.key } });
  await waitFor(async () => (await health(3204)).state === 'starting');
  s.close();
  await new Promise((r) => blocker.close(r));
  await new Promise((r) => setTimeout(r, 3000));    // longer than a slow retry
  const probe = net.createServer().listen(port);    // free again: nothing grabbed it
  const bound = await new Promise((r) => { probe.once('listening', () => r(true)); probe.once('error', () => r(false)); });
  if (bound) await new Promise((r) => probe.close(r));
  assert.equal(bound, true);
});

// A port Windows reserved (WinNAT blocks for Hyper-V/WSL) answers EACCES, and no amount
// of waiting frees it, so this is the one case reported as failed.
function reservedPort() {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = require('node:child_process').execFileSync('netsh', ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], { encoding: 'latin1' });
    // Rows marked * are administered exclusions, which a listener can still bind; the
    // WinNAT blocks are the unmarked rows, and those answer EACCES.
    const m = out.match(/^\s*(\d+)\s+(\d+)\s*$/m);
    return m ? Number(m[1]) : undefined;
  } catch { return undefined; }
}

test('a port Windows reserved is reported as failed with EACCES, not waited on', { skip: SKIP }, async (t) => {
  const port = reservedPort();
  if (!port) return t.skip('no Windows excluded port range on this machine');
  const s = await startServer({ port: 3205, tls: { port, cert: certs.cert, key: certs.key } });
  try {
    assert.ok(await waitFor(async () => (await health(3205)).state === 'failed', 5000), 'reported failed');
    const h = await health(3205);
    assert.equal(h.port, port);
    assert.match(h.error, /EACCES/);
  } finally {
    s.close();
  }
});

test('/health says off when HTTPS is not configured, and failed with the load problem', { skip: SKIP }, async () => {
  const off = await startServer({ port: 3199 });
  const broken = await startServer({ port: 3200, tlsProblem: 'tlsKeyCommand failed (exit 3): vault: key not found' });
  try {
    assert.deepEqual(await health(3199), { state: 'off' });
    assert.deepEqual(await health(3200), { state: 'failed', error: 'tlsKeyCommand failed (exit 3): vault: key not found' });
  } finally {
    off.close();
    broken.close();
  }
});

test('a real daemon with a broken key command reports why on /health, with its output discarded', { skip: SKIP }, async () => {
  // The decisive case: the daemon is spawned exactly as the update helper spawns it
  // (stdio ignored), so /health is the only place the reason can surface.
  const dir = fs.mkdtempSync(path.join(root, 'daemon-'));
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({
    tlsPort: 3202, tlsCertFile: certs.certFile, tlsKeyCommand: keyCommand(certs.keyFile, 3),
  }));
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'out', 'backend', 'daemon.js')], {
    stdio: 'ignore', windowsHide: true,
    env: {
      ...process.env, ARGUS_CONFIG: cfg, ARGUS_DAEMON_PORT: '3201', ARGUS_DAEMON_FILE: path.join(dir, 'daemon.json'),
      ARGUS_MODEL_REFRESH: '0', ARGUS_USAGE_POLL: '0', ARGUS_AUTH_FILE: path.join(dir, 'auth.json'),
      ARGUS_ACCESS_LOG_DB: path.join(dir, 'access.sqlite'), ARGUS_DAEMON_FORCE_START: '',
    },
  });
  try {
    let h;
    assert.ok(await waitFor(async () => { try { h = await health(3201); return true; } catch { return false; } }, 15000), 'daemon answered /health');
    assert.equal(h.state, 'failed');
    assert.match(h.error, /exit 3/);
    assert.match(h.error, /vault: key not found/);
    assert.ok(!h.error.includes('PRIVATE KEY'), 'key material leaked into /health');
  } finally {
    child.kill();
  }
});
