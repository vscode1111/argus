const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const cp = require('node:child_process');
const { PassThrough } = require('node:stream');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-identity-'));
process.env.ARGUS_CONFIG = path.join(dir, 'settings.json');
process.env.ARGUS_USAGE_POLL = '0';
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const channels = require('../out/backend/channel');
const { attachClientHandlers } = require('../out/backend/session');
const { provider } = require('../out/backend/providers/registry');

function socket() {
  const ws = new EventEmitter(); ws.readyState = 1; ws.frames = [];
  ws.send = text => ws.frames.push(JSON.parse(text));
  return ws;
}
function entry(t, port = 3973) {
  const workspace = path.join(dir, randomUUID()); fs.mkdirSync(workspace);
  const channel = channels.getOrCreateChannel(workspace, port);
  const ws = socket(); attachClientHandlers(ws, channel, '', { panelId: randomUUID() });
  t.after(() => { ws.emit('close'); channels.destroyChannel(workspace); });
  return { workspace, channel, ws, state: channel.getClientState(ws), port };
}
async function lookup(ws, agentToken) {
  const requestId = randomUUID();
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'whoami', requestId, agentToken })));
  const end = Date.now() + 300;
  while (!ws.frames.some(f => f.requestId === requestId) && Date.now() < end) await new Promise(r => setTimeout(r, 5));
  const replies = ws.frames.filter(f => f.requestId === requestId);
  assert.equal(replies.length, 1, 'exactly one correlated identity response');
  return replies[0];
}

test('identity is entry-owned across pending, assignment, rebind, clear and new entries', async t => {
  const { state, ws, channel, workspace } = entry(t);
  assert.match(state.agentToken || '', /^[a-f0-9]{64}$/);
  const token = state.agentToken;
  assert.deepEqual(await lookup(ws, token), { type: 'whoami', requestId: ws.frames.at(-1).requestId,
    sessionId: null, providerId: state.selection.providerId, workspace, title: '' });
  const p = provider(state.selection.providerId), list = p.list;
  p.list = async () => [{ id: state.sessionId, title: 'Inventory review' }];
  t.after(() => { p.list = list; });
  for (const id of [`codex:${randomUUID()}`, `codex:${randomUUID()}`]) {
    state.sessionId = id;
    state.runtime = { active: false, dispose() {} };
    const result = await lookup(ws, token);
    assert.equal(result.sessionId, id); assert.equal(result.title, 'Inventory review');
    assert.equal(state.agentToken, token);
  }
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'send', text: '/clear' })));
  await new Promise(r => setImmediate(r));
  assert.equal((await lookup(ws, token)).sessionId, null);
  assert.equal(state.agentToken, token);
  const fresh = channel.moveToNewSession(ws);
  assert.notEqual(fresh.agentToken, token); assert.equal(fresh.daemonPort, 3973);
  assert.equal((await lookup(ws, token)).sessionId, null, 'old entry remains valid until removed');
  channels.destroyChannel(workspace);
  const observer = entry(t);
  assert.equal((await lookup(observer.ws, token)).error, 'Agent identity unavailable');
});

test('lookup from another workspace is read-only, fresh and does not create a runtime', async t => {
  const target = entry(t), observer = entry(t);
  target.state.selection.providerId = 'claude'; target.state.sessionId = randomUUID();
  let disposed = 0;
  observer.state.runtime = { active: true, dispose() { disposed++; } };
  const p = provider('claude'), list = p.list;
  let title = 'Inventory draft';
  p.list = async () => [{ id: target.state.sessionId, title }]; t.after(() => { p.list = list; });
  assert.equal((await lookup(observer.ws, target.state.agentToken)).title, title);
  title = 'Inventory final';
  const result = await lookup(observer.ws, target.state.agentToken);
  assert.equal(result.title, title); assert.equal(result.workspace, target.workspace);
  assert.equal(result.providerId, 'claude'); assert.equal(target.state.runtime, undefined);
  assert.equal(disposed, 0); assert.notEqual(observer.state, target.state);
  assert.equal(JSON.stringify(result).includes(target.state.agentToken), false);
});

test('invalid, missing and expired identity share one error; async removal and rebind are rechecked', async t => {
  const target = entry(t), observer = entry(t);
  for (const token of [undefined, '', {}, randomBytes(32).toString('hex')]) {
    const result = await lookup(observer.ws, token);
    assert.equal(result.type, 'whoami'); assert.equal(result.error, 'Agent identity unavailable');
    assert.deepEqual(Object.keys(result).sort(), ['error', 'requestId', 'type']);
  }
  const p = provider(target.state.selection.providerId), list = p.list;
  target.state.sessionId = `codex:${randomUUID()}`;
  p.list = async () => { target.state.sessionId = `codex:${randomUUID()}`; return []; };
  t.after(() => { p.list = list; });
  assert.equal((await lookup(observer.ws, target.state.agentToken)).error, 'Agent identity unavailable');
  p.list = async () => { channels.destroyChannel(target.workspace); return []; };
  assert.equal((await lookup(observer.ws, target.state.agentToken)).error, 'Agent identity unavailable');
});

test('malformed identity input never logs the supplied token', async t => {
  const target = entry(t);
  target.ws.frames.length = 0;
  target.ws.emit('message', Buffer.from('{"type":"whoami","agentToken":"' + target.state.agentToken));
  await new Promise(r => setImmediate(r));
  assert.equal(JSON.stringify(target.ws.frames).includes(target.state.agentToken), false);
});

test('helper environments remove case variants of inherited identity', t => {
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^ARGUS_(AGENT_TOKEN|DAEMON_PORT)$/i.test(key)));
  for (const key of Object.keys(previous)) delete process.env[key];
  process.env.argus_agent_token = randomBytes(32).toString('hex');
  process.env.argus_daemon_port = '3999';
  t.after(() => {
    for (const key of Object.keys(process.env)) if (/^ARGUS_(AGENT_TOKEN|DAEMON_PORT)$/i.test(key)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const env = require('../out/backend/agentEnvironment').agentEnvironment();
  assert.equal(Object.keys(env).some(key => /^ARGUS_(AGENT_TOKEN|DAEMON_PORT)$/i.test(key)), false);
});

test('both execution spawns overwrite inherited identity; metadata RPC strips it and keeps PATH', async t => {
  const originalSpawn = cp.spawn;
  const previous = { token: process.env.ARGUS_AGENT_TOKEN, port: process.env.ARGUS_DAEMON_PORT };
  process.env.ARGUS_AGENT_TOKEN = randomBytes(32).toString('hex'); process.env.ARGUS_DAEMON_PORT = '3999';
  const calls = [];
  cp.spawn = (binary, args, options) => {
    calls.push(options);
    const child = new EventEmitter(); child.pid = undefined;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', data => {
      const msg = JSON.parse(String(data));
      if (msg.method === 'initialize') queueMicrotask(() => child.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\n'));
    });
    return child;
  };
  t.after(() => {
    cp.spawn = originalSpawn;
    for (const [key, value] of [['ARGUS_AGENT_TOKEN', previous.token], ['ARGUS_DAEMON_PORT', previous.port]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { state, port } = entry(t);
  state.selection.providerId = 'claude';
  require('../out/backend/providers/claudeExecution').handleSend(state, { text: 'Check inventory totals.' });
  const execution = calls.at(-1).env;
  assert.equal(execution?.ARGUS_AGENT_TOKEN === state.agentToken, true, 'execution token matches owning entry');
  assert.equal(execution?.ARGUS_DAEMON_PORT, String(port));
  state.currentProc = undefined;
  const { AppServerRpc } = require('../out/backend/providers/rpc');
  const rpc = new AppServerRpc(process.execPath, [], state); await rpc.start();
  const owned = calls.at(-1).env;
  assert.equal(owned.ARGUS_AGENT_TOKEN === state.agentToken, true); assert.equal(owned.ARGUS_DAEMON_PORT, String(port));
  rpc.dispose();
  const helper = new AppServerRpc(process.execPath, []); await helper.start();
  const unowned = calls.at(-1).env;
  assert.equal(unowned.ARGUS_AGENT_TOKEN, undefined); assert.equal(unowned.ARGUS_DAEMON_PORT, undefined);
  if (process.platform === 'win32') {
    const key = Object.keys(unowned).find(k => k.toLowerCase() === 'path');
    assert.equal(unowned[key].startsWith(path.win32.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin') + ';'), true);
  }
  helper.dispose();
  assert.equal(process.env.ARGUS_DAEMON_PORT, '3999');
});
