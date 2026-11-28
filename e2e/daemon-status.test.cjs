// scripts/daemon-status.js: what cmd/start-argus-daemon.bat prints after a launch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { describe } = require('../scripts/daemon-status.js');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'daemon-status.js');

test('a running daemon prints the local address and the HTTPS network addresses', () => {
  const text = describe({ port: 41000, version: '1.2.3' }, { pid: 1234, https: { state: 'ready', port: 41443 } }, ['192.0.2.10']);
  assert.match(text, /running \(version 1\.2\.3, pid 1234\)/);
  assert.match(text, /http:\/\/127\.0\.0\.1:41000\//);
  assert.match(text, /https:\/\/192\.0\.2\.10:41443\//);
  // Never a plain-HTTP network address: that is where the password would cross in clear.
  assert.doesNotMatch(text, /http:\/\/192\.0\.2/);
});

test('HTTPS that is waiting or failed says why instead of printing an address', () => {
  const waiting = describe({ port: 1 }, { pid: 2, https: { state: 'starting', port: 41443, error: 'listen EADDRINUSE' } }, ['10.0.0.5']); // leak-check: allow (fixture)
  assert.match(waiting, /waiting for the port: listen EADDRINUSE/);
  assert.doesNotMatch(waiting, /https:\/\/10\.0\.0\.5/);
  const failed = describe({ port: 1 }, { pid: 2, https: { state: 'failed', port: 41444, error: 'listen EACCES' } }, ['10.0.0.5']); // leak-check: allow (fixture)
  assert.match(failed, /HTTPS is not working: listen EACCES/);
  // HTTPS off: only the local line.
  assert.doesNotMatch(describe({ port: 1 }, { pid: 2, https: { state: 'off' } }, ['10.0.0.5']), /https|HTTPS/); // leak-check: allow (fixture)
});

test('no daemon, or a registered one that does not answer, is reported as not running', () => {
  assert.match(describe(undefined, undefined), /NOT running[\s\S]*No daemon is registered/);
  assert.match(describe({ port: 41000 }, undefined), /NOT running[\s\S]*Registered on port 41000, but it does not answer/);
});

function run(file, wait = '1') {
  return new Promise((resolve) => execFile(process.execPath, [SCRIPT, '--wait', wait], { env: { ...process.env, ARGUS_DAEMON_FILE: file } },
    (err, stdout) => resolve({ code: err ? err.code : 0, stdout })));
}

test('the script reads the registration and asks /health on that port', async () => {
  // A stand-in daemon: the script must find it through the discovery file and its /health.
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pid: 4242, configPath: 'x', https: { state: 'off' } }));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-status-'));
  const file = path.join(dir, 'daemon.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ port: server.address().port, version: '9.9.9', pid: 4242, nonce: 'n' }));
    const up = await run(file);
    assert.equal(up.code, 0);
    assert.match(up.stdout, /running \(version 9\.9\.9, pid 4242\)/);
    assert.match(up.stdout, new RegExp(`http://127\\.0\\.0\\.1:${server.address().port}/`));
  } finally {
    await new Promise((r) => server.close(r));
  }
  // Same registration, nothing listening any more: exit 1 and say so.
  const down = await run(file);
  assert.equal(down.code, 1);
  assert.match(down.stdout, /NOT running/);
  fs.rmSync(dir, { recursive: true, force: true });
});

const { lanAddresses, tunnelAddresses } = require('../scripts/daemon-status.js');

test('network addresses leave out Hyper-V/WSL switches, which no other device can reach', () => {
  const ifaces = {
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.0.2.10' }],
    'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.31.240.1' }], // leak-check: allow (fixture)
    'vEthernet (Default Switch)': [{ family: 'IPv4', internal: false, address: '172.31.250.1' }], // leak-check: allow (fixture)
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  };
  assert.deepEqual(lanAddresses(ifaces), ['192.0.2.10']);
});

test('tunnel addresses come from allowedOrigins entries that name a port, and are shown only with HTTPS up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-status-cfg-'));
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ allowedOrigins: '198.51.100.20, 198.51.100.7:41443 ,bad/host:1' }));
  try {
    assert.deepEqual(tunnelAddresses(cfg), ['198.51.100.7:41443']);
    assert.deepEqual(tunnelAddresses(path.join(dir, 'missing.json')), []);
    const ready = describe({ port: 1 }, { pid: 2, https: { state: 'ready', port: 41443 } }, [], ['198.51.100.7:41443']);
    assert.match(ready, /Through tunnel\/proxy:\s+https:\/\/198\.51\.100\.7:41443\//);
    const failed = describe({ port: 1 }, { pid: 2, https: { state: 'failed', error: 'x' } }, [], ['198.51.100.7:41443']);
    assert.doesNotMatch(failed, /198\.51\.100\.7/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
