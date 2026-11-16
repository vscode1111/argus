const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { WebSocket } = require('ws');
const root = path.resolve(__dirname, '..');
const harness = path.join(__dirname, 'fixtures/identity-server.cjs');

test('private checkout wire and real fake-provider children resolve pending and assigned identity', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-wire-'));
  const discovery = path.join(dir, 'daemon.json');
  const config = path.join(dir, 'settings.json');
  fs.writeFileSync(config, JSON.stringify({ defaultProvider: 'claude', watchdogEnabled: false, errorRetryEnabled: false }));
  const env = { ...process.env, ARGUS_CONFIG: config, ARGUS_STATS_DB: path.join(dir, 'stats.sqlite'),
    ARGUS_DAEMON_FILE: discovery, ARGUS_AGENT_TOKEN: randomBytes(32).toString('hex'), ARGUS_DAEMON_PORT: '1',
    IDENTITY_WORKSPACE: root, ARGUS_ENTRY_GRACE_MS: '100' };
  for (const key of Object.keys(env)) if (/^(CODEX_|CLAUDE|ANTHROPIC_|VSCODE_)/.test(key)) delete env[key];
  const preload = process.env.ARGUS_TEST_SERVER_PRELOAD;
  const server = spawn(process.execPath, [...(preload ? ['--require', preload] : []), '--require', path.join(__dirname, 'fixtures/identity-spawn.cjs'), harness, discovery],
    { env, cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const spawns = []; server.on('message', message => spawns.push(message));
  t.after(async () => {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(server.pid)], { stdio: 'ignore', windowsHide: true });
    else server.kill();
    await new Promise(r => setTimeout(r, 200));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const end = Date.now() + 5000;
  while (!fs.existsSync(discovery)) { assert.ok(Date.now() < end, 'private discovery created'); await new Promise(r => setTimeout(r, 20)); }
  const info = JSON.parse(fs.readFileSync(discovery, 'utf8'));
  const health = await (await fetch(`http://127.0.0.1:${info.port}/health`)).json();
  assert.equal(health.pid, server.pid); assert.equal(health.configPath.toLowerCase(), config.toLowerCase());
  assert.notEqual(info.port, 1);
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/agent?nonce=${info.nonce}&dir=${encodeURIComponent(root)}&client=browser`);
  const frames = []; ws.on('message', data => frames.push(JSON.parse(String(data))));
  t.after(() => ws.close());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  async function wait(predicate) {
    const until = Date.now() + 5000;
    while (!frames.some(predicate)) { assert.ok(Date.now() < until, 'expected private wire response'); await new Promise(r => setTimeout(r, 10)); }
    return frames.find(predicate);
  }
  async function request(type, extra, response) {
    const requestId = randomUUID(); ws.send(JSON.stringify({ type, requestId, ...extra }));
    return wait(f => f.requestId === requestId && f.type === response);
  }
  assert.equal((await request('whoami', { agentToken: randomBytes(32).toString('hex') }, 'whoami')).error, 'Agent identity unavailable');
  for (const providerId of ['claude', 'codex']) {
    if (providerId === 'codex') {
      ws.send(JSON.stringify({ type: 'switchProvider', providerId }));
      await wait(f => f.type === 'providerSelection' && f.providerId === providerId);
      const configured = await request('configureSession', { providerId, model: 'inventory-model', effort: '' }, 'sessionConfigured');
      assert.equal(configured.selection.providerId, providerId);
    }
    frames.length = 0;
    ws.send(JSON.stringify({ type: 'send', text: 'Check inventory totals.' }));
    await wait(f => f.type === 'done');
    const text = frames.filter(f => f.type === 'text_chunk').map(f => f.text).join('');
    const checks = JSON.parse(text);
    assert.deepEqual(checks, { pending: true, assigned: true, workspace: true, provider: true, port: true });
    assert.equal(text.includes(env.ARGUS_AGENT_TOKEN), false);
    const own = spawns.filter(s => typeof s.agentToken === 'string').at(-1);
    assert.equal(typeof own?.agentToken, 'string');
    assert.equal(own.agentToken === env.ARGUS_AGENT_TOKEN, false, 'caller token replaced');
    assert.equal(own.serverModule, path.join(root, 'out/backend/index.js'));
    assert.equal(own.moduleLoaded, true);
    assert.equal(own.serverHash, createHash('sha256').update(fs.readFileSync(own.serverModule)).digest('hex'));
    assert.equal(own.daemonPort, String(info.port));
    const assigned = await request('whoami', { agentToken: own.agentToken }, 'whoami');
    assert.equal(typeof assigned.sessionId, 'string'); assert.equal(assigned.providerId, providerId);
    frames.length = 0;
    ws.send(JSON.stringify({ type: 'send', text: '/clear' }));
    await wait(f => f.type === 'clear');
    const cleared = await request('whoami', { agentToken: own.agentToken }, 'whoami');
    assert.equal(cleared.sessionId, null); assert.equal(cleared.title, '');
    assert.equal(cleared.error, undefined, 'clear preserves entry identity');
    frames.length = 0; ws.send(JSON.stringify({ type: 'newSession' }));
    await wait(f => f.type === 'clear');
    await new Promise(r => setTimeout(r, 250));
    assert.equal((await request('whoami', { agentToken: own.agentToken }, 'whoami')).error, 'Agent identity unavailable');
  }
  assert.equal(spawns.some(s => s.rpc && s.agentToken === undefined && s.daemonPort === undefined), true, 'metadata helper has no identity');
});
