// Backend tests for the remote access log (src/backend/accessLog.ts).
//
// A real server on a private port, reached through this machine's LAN address so the
// peer is non-loopback - the same path a phone or the tunnel takes.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { lanAddress } = require('./remote-test-helpers.cjs');

// config.ts pins CONFIG_PATH at import, so the isolated environment is set up before
// anything from out/backend is loaded. node --test runs each file in its own process.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-access-log-'));
const cfgFile = path.join(root, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ allowNetworkAccess: true }));
Object.assign(process.env, {
  ARGUS_CONFIG: cfgFile,
  ARGUS_AUTH_FILE: path.join(root, 'auth.json'),
  ARGUS_ACCESS_LOG_DB: path.join(root, 'access.sqlite'),
  ARGUS_USAGE_POLL: '0',
  ARGUS_MODEL_REFRESH: '0',
});

const { startServer } = require('../out/backend/index');
const auth = require('../out/backend/auth');
const accessLog = require('../out/backend/accessLog');
const { DatabaseSync } = require('node:sqlite');

const PORT = 3191;
const PW = 'scub-access-log-password';
let server;
let LAN;

function rows() {
  const db = new DatabaseSync(process.env.ARGUS_ACCESS_LOG_DB, { readOnly: true });
  try { return db.prepare('SELECT event, address, user, user_agent, detail FROM access_log ORDER BY id').all(); } finally { db.close(); }
}
async function eventuallyRows(predicate, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < end) {
    last = rows();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}
const login = async (host, user, password, contentType = 'application/json', body) => {
  const res = await fetch(`http://${host}:${PORT}/login`, {
    method: 'POST', headers: { 'Content-Type': contentType },
    body: body ?? JSON.stringify({ user, password }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const connect = (host, query) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://${host}:${PORT}/agent?${query}`);
  const done = (r) => { try { ws.close(); } catch { /* closing */ } resolve(r); };
  ws.on('open', () => done('open'));
  ws.on('unexpected-response', (_q, res) => done(`refused ${res.statusCode}`));
  ws.on('error', (e) => done(`error ${e.message}`));
});

before(async () => {
  server = await startServer({ port: PORT });
  LAN = await lanAddress(PORT);
});
after(() => {
  server?.close();
  accessLog.closeAccessLog();
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  // Every test starts from an empty log, no password and no lockout.
  accessLog.closeAccessLog();
  for (const f of ['', '-wal', '-shm']) fs.rmSync(process.env.ARGUS_ACCESS_LOG_DB + f, { force: true });
  fs.rmSync(process.env.ARGUS_AUTH_FILE, { force: true });
  auth.resetAuthState();
});

test('every remote attempt is recorded in order, failures included', async (t) => {
  if (!LAN) return t.skip('no non-loopback interface on this machine');
  const dir = encodeURIComponent(root);
  const nonce = await (await fetch(`http://127.0.0.1:${PORT}/nonce`)).text();

  assert.equal((await login(LAN, 'scub', PW)).status, 403);          // nothing configured yet
  assert.equal(auth.setPassword('scub', PW).ok, true);
  assert.equal((await login(LAN, 'intruder', 'wrong-password')).status, 401);
  assert.equal((await fetch(`http://${LAN}:${PORT}/nonce`)).status, 401);
  assert.equal(await connect(LAN, `nonce=${nonce}&dir=${dir}`), 'refused 401');
  const ok = await login(LAN, 'scub', PW);
  assert.equal(ok.status, 200);
  assert.equal(await connect(LAN, `nonce=${nonce}&dir=${dir}&auth=${ok.body.token}`), 'open');

  const want = ['login_unconfigured', 'login_failed', 'nonce_refused', 'ws_refused', 'login_ok', 'ws_open', 'ws_close'];
  const got = await eventuallyRows((r) => r.length >= want.length);
  assert.deepEqual(got.map((r) => r.event), want);
  assert.ok(got.every((r) => r.address === LAN), 'every row carries the remote address');
  assert.equal(got.find((r) => r.event === 'login_failed').user, 'intruder');
  assert.equal(got.find((r) => r.event === 'login_failed').detail, '1 failed in a row');
  assert.equal(got.find((r) => r.event === 'login_ok').user, 'scub');
  assert.match(got.find((r) => r.event === 'ws_close').detail, /^code \d+, \d+s$/);
  // Secrets never reach the log: neither password tried, nor the issued token.
  const dump = JSON.stringify(got);
  assert.ok(!dump.includes(PW) && !dump.includes('wrong-password') && !dump.includes(ok.body.token));
});

test('a local peer is never recorded', async () => {
  // The control for everything above: local panels connect constantly, and logging them
  // would bury the remote attempts. Also covers a local login attempt.
  const dir = encodeURIComponent(root);
  const nonce = await (await fetch(`http://127.0.0.1:${PORT}/nonce`)).text();
  assert.equal(auth.setPassword('scub', PW).ok, true);
  assert.equal(await connect('127.0.0.1', `nonce=${nonce}&dir=${dir}`), 'open');
  assert.equal((await login('127.0.0.1', 'scub', 'wrong-password')).status, 401);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(process.env.ARGUS_ACCESS_LOG_DB) ? rows().length : 0, 0);
});

test('lockout and malformed login requests are recorded', async (t) => {
  if (!LAN) return t.skip('no non-loopback interface on this machine');
  assert.equal(auth.setPassword('scub', PW).ok, true);
  assert.equal((await login(LAN, 'scub', PW, 'text/plain')).status, 415);
  assert.equal((await login(LAN, 'scub', PW, 'application/json', '{not json')).status, 400);
  for (let i = 0; i < 5; i++) await login(LAN, 'guess', `bad-${i}`);
  assert.equal((await login(LAN, 'scub', PW)).status, 429);   // even the right password

  const got = await eventuallyRows((r) => r.some((x) => x.event === 'login_locked'));
  const events = got.map((r) => r.event);
  assert.deepEqual(events.slice(0, 2), ['login_bad_request', 'login_bad_request']);
  assert.deepEqual(got.slice(0, 2).map((r) => r.detail), ['expected application/json', 'malformed body']);
  assert.equal(events.filter((e) => e === 'login_failed').length, 5);
  assert.equal(got.find((r) => r.event === 'login_failed' && r.detail === '5 failed in a row')?.user, 'guess');
  assert.match(got.at(-1).detail, /^retry after \d+s$/);
  assert.equal(got.at(-1).event, 'login_locked');
});

test('a broken log never breaks the request it describes', async (t) => {
  if (!LAN) return t.skip('no non-loopback interface on this machine');
  // Point the log at a directory: SQLite cannot open it, so every write fails.
  accessLog.closeAccessLog();
  const prior = process.env.ARGUS_ACCESS_LOG_DB;
  process.env.ARGUS_ACCESS_LOG_DB = root;
  try {
    assert.equal(auth.setPassword('scub', PW).ok, true);
    assert.equal((await login(LAN, 'scub', 'wrong-password')).status, 401);
    const ok = await login(LAN, 'scub', PW);
    assert.equal(ok.status, 200);
    assert.match(ok.body.token, /^[0-9a-f]{64}$/);
  } finally {
    accessLog.closeAccessLog();
    process.env.ARGUS_ACCESS_LOG_DB = prior;
  }
});
