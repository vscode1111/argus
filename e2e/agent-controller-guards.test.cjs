const { test, after } = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-guards-'));
process.env.ARGUS_CONFIG = path.join(dir, 'settings.json'); process.env.ARGUS_GRAPH_DB = path.join(dir, 'graph.sqlite');
process.env.ARGUS_STATS_DB = path.join(dir, 'stats.sqlite'); process.env.ARGUS_USAGE_POLL = '0'; process.env.ARGUS_MODEL_REFRESH = '0';
fs.writeFileSync(process.env.ARGUS_CONFIG, JSON.stringify({ defaultProvider: 'claude', watchdogEnabled: false }));
const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel'), { attachClientHandlers } = require('../out/backend/session');
const { agentGraphService } = require('../out/backend/agentGraphRequests');
const { authorizeAgent, handleAgentCommand } = require('../out/backend/agentCommands');
const tick = () => new Promise(r => setImmediate(r));
after(() => { agentGraphService().dispose(); require('../out/backend/sessionStats').closeStatsDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(t) {
  const workspace = path.join(dir, randomUUID()); fs.mkdirSync(workspace); const channel = getOrCreateChannel(workspace), states = [], sockets = [];
  for (const role of ['parent', 'child', 'foreign']) {
    const ws = new EventEmitter(); ws.readyState = 1; ws.frames = []; ws.send = raw => ws.frames.push(JSON.parse(raw));
    attachClientHandlers(ws, channel, '', { fresh: true, panelId: randomUUID() });
    const state = channel.getClientState(ws); state.sessionId = role + '-' + randomUUID(); state.selection.providerId = 'claude'; state.cliDone = false;
    states.push(state); sockets.push(ws);
  }
  const store = agentGraphService().store, [parent, child, foreign] = states;
  const node = state => ({ id: state.sessionId, providerId: 'claude', role: 'other', title: 'Inventory', workspace, company: 'inventory', goal: 'stock', createdAt: 1, updatedAt: 1 });
  store.link(parent.sessionId, child.sessionId, 'delegates', states.map(node));
  const effects = []; child.runtime = { active: true, async send(input, admission) { if (admission && !admission.valid()) return; admission?.admitted(); effects.push('send'); }, async stop() { effects.push('stop'); }, respond() { effects.push('respond'); }, dispose() { effects.push('dispose'); }, queueConfiguration() { effects.push('deferred'); } };
  child.lastMessage = { text: 'Synthetic inventory input', mode: 'full-access' };
  t.after(() => { for (const ws of sockets) ws.emit('close'); destroyChannel(workspace); });
  return { workspace, channel, states, sockets, store, effects };
}
test('routed invalid/foreign tokens refuse all equivalent input effects before cancellation or dispatch', async t => {
  const { states: [parent, child, foreign], sockets: [, ws], effects } = fixture(t);
  for (const token of ['invalid', foreign.agentToken]) for (const type of ['send', 'steer', 'retry', 'stop', 'forceError', 'toolAnswer', 'providerResponse', 'configureSession', 'queueSessionConfiguration']) {
    ws.frames.length = 0; ws.emit('message', Buffer.from(JSON.stringify({ type, agentToken: token, text: 'Synthetic input', id: 'choice', response: {}, providerId: 'claude', model: '', effort: '' })));
    await tick(); assert.equal(effects.length, 0, type); assert.ok(ws.frames.some(f => f.code === 'agent_forbidden'), type);
  }
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'send', agentToken: parent.agentToken, text: 'Synthetic input' }))); await tick(); assert.deepEqual(effects, ['send']);
});
test('own-child permission is direct/current, not peer, transitive or stale scope membership', t => {
  const { states: [parent, child, foreign], store } = fixture(t);
  assert.doesNotThrow(() => authorizeAgent(store, parent.agentToken, child, child.sessionId));
  store.link(child.sessionId, foreign.sessionId, 'reviews');
  assert.throws(() => authorizeAgent(store, parent.agentToken, foreign, foreign.sessionId), /forbidden/);
  store.unlink(parent.sessionId, child.sessionId, 'delegates'); store.link(parent.sessionId, child.sessionId, 'peer');
  assert.throws(() => authorizeAgent(store, parent.agentToken, child, child.sessionId), /forbidden/);
});

test('R12 I1 browsing and explicit-ID aliases cannot affect another actual entry', async t => {
  const { channel, states: [parent, child, foreign], sockets: [, own, other], effects } = fixture(t);
  foreign.runtime = { active: true, send() { effects.push('foreign:send'); }, stop() { effects.push('foreign:stop'); }, dispose() { effects.push('foreign:dispose'); } };
  foreign.lastMessage = { text: 'Synthetic inventory' };
  channel.setBrowsing(other, true, child.sessionId);
  for (const type of ['stop', 'retry', 'forceError', 'toolAnswer', 'configureSession']) {
    other.frames.length = 0; other.emit('message', Buffer.from(JSON.stringify({ type, agentToken: parent.agentToken, id: 'choice' }))); await tick();
    assert.deepEqual(effects, [], type); assert.ok(other.frames.some(f => f.code === 'agent_forbidden'), type);
  }
  for (const type of ['deleteSession', 'renameSession']) {
    own.frames.length = 0; own.emit('message', Buffer.from(JSON.stringify({ type, id: foreign.sessionId, title: 'Inventory', agentToken: parent.agentToken }))); await tick();
    assert.ok(own.frames.some(f => f.code === 'agent_forbidden'), type);
  }
  const { claudeProvider } = require('../out/backend/providers/claude');
  const remove = claudeProvider.remove, list = claudeProvider.list;
  claudeProvider.remove = async id => effects.push('remove:' + id); claudeProvider.list = async () => [];
  t.after(() => { claudeProvider.remove = remove; claudeProvider.list = list; });
  own.emit('message', Buffer.from(JSON.stringify({ type: 'deleteSession', id: foreign.sessionId, agentToken: parent.agentToken }))); await tick();
  assert.deepEqual(effects, []);
  other.emit('message', Buffer.from(JSON.stringify({ type: 'stop' }))); await tick();
  assert.deepEqual(effects, ['foreign:stop'], 'tokenless browsing keeps its existing actual-entry behavior');
});

test('R12 I4 child deferred input is rejected before queue while verified self remains allowed', async t => {
  const { states: [parent, child], sockets: [self, own], effects } = fixture(t);
  const input = { type: 'queueSessionConfiguration', operationId: 'inventory-op', expectedTurnId: 'inventory-turn', model: 'inventory-model', effort: 'low', continuation: 'Synthetic continuation', agentToken: parent.agentToken };
  own.emit('message', Buffer.from(JSON.stringify(input))); await tick();
  assert.ok(own.frames.some(f => f.code === 'agent_forbidden')); assert.deepEqual(effects, []);
  parent.runtime = { active: true, queueConfiguration(_request, current) { assert.equal(current(), true); effects.push('self:queue'); return { status: 'queued' }; }, dispose() {} };
  self.emit('message', Buffer.from(JSON.stringify(input))); await tick(); assert.deepEqual(effects, ['self:queue']);
});

test('R12 I3 replaced async answer during native validation writes nothing and preserves the new question', async t => {
  for (const change of ['replaced', 'resolved', 'current']) {
  const { states: [parent, child], sockets: [, ws], store } = fixture(t), { CodexSession } = require('../out/backend/providers/codex');
  child.sessionId = 'codex:' + randomUUID(); child.selection = { providerId: 'codex', model: '', effort: '', thinking: true };
  store.link(parent.sessionId, child.sessionId, 'delegates', [{ id: child.sessionId, providerId: 'codex', role: 'work', title: 'Inventory', workspace: child.workspaceDir, company: 'inventory', goal: 'stock', createdAt: 1, updatedAt: 1 }]);
  const question = id => ({ id, kind: 'question', title: 'Inventory', async: true, questions: [{ id: 'section', question: 'Section', options: ['Stock'] }] });
  child.interaction = question('old'); let resume; const gate = new Promise(r => { resume = r; }), calls = [];
  child.runtime = new CodexSession(child, { async start() {}, async request(method) { calls.push(method); return { turn: { id: 'inventory-turn' } }; }, dispose() {} }, () => gate);
  child.runtime.threadId = 'inventory-thread';
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'send', text: 'Synthetic answer', expectedInteractionId: 'old', agentToken: parent.agentToken })));
  await tick(); assert.equal(child.interaction?.id, 'old', 'do not supersede before validation');
  if (change === 'replaced') child.interaction = question('new');
  if (change === 'resolved') child.interaction = null;
  resume(); await tick(); await tick();
  assert.deepEqual(calls, change === 'current' ? ['turn/start'] : []);
  assert.equal(child.interaction?.id ?? null, change === 'replaced' ? 'new' : null);
  }
});

test('R12 I4 actual self configuration continues after its controller disconnects', async t => {
  const { states: [parent], sockets: [ws] } = fixture(t), { CodexSession } = require('../out/backend/providers/codex');
  parent.sessionId = 'codex:' + randomUUID(); parent.selection = { providerId: 'codex', model: 'inventory-model', effort: 'low', thinking: true };
  let starts = 0; const rpc = { async start() {}, async request(method) { if (method === 'turn/start') starts++; return { turn: { id: 'inventory-turn-' + starts } }; }, dispose() {} };
  parent.runtime = new CodexSession(parent, rpc, async () => {}); parent.runtime.threadId = 'inventory-thread';
  await parent.runtime.send({ text: 'Synthetic inventory input' });
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'queueSessionConfiguration', operationId: 'inventory-op', expectedTurnId: 'inventory-turn-1',
    model: 'inventory-next', effort: 'high', continuation: 'Synthetic continuation', agentToken: parent.agentToken })));
  await tick(); await tick(); assert.ok(ws.frames.some(f => f.type === 'sessionConfigurationQueued'));
  ws.emit('close');
  rpc.onMessage('turn/completed', { threadId: 'inventory-thread', turn: { id: 'inventory-turn-1', status: 'completed' } });
  await tick(); await tick(); assert.equal(starts, 2); assert.equal(parent.selection.model, 'inventory-next');
});

test('steer reaching an idle child refuses explicitly and cannot start a cold turn', async t => {
  const { states: [parent, child], sockets: [, ws], effects } = fixture(t);
  child.runtime.active = false; child.cliDone = true; ws.frames.length = 0;
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'steer', text: 'Synthetic input', agentToken: parent.agentToken })));
  await tick(); assert.equal(effects.length, 0); assert.ok(ws.frames.some(f => f.type === 'providerNotice' && f.error), 'explicit admission refusal');
});

test('authorized selection metadata uses the child binding rather than the caller provider', async t => {
  const { states: [parent, child], sockets: [ws], store, workspace } = fixture(t);
  const id = 'codex:' + randomUUID();
  store.link(parent.sessionId, id, 'delegates', [{ id, providerId: 'codex', role: 'work', title: 'Inventory', workspace, company: 'inventory', goal: 'selection', createdAt: 1, updatedAt: 1 }]);
  const data = { version: 1, goal: { title: 'Inventory', status: 'active', profile: 'normal', profileRevision: 1, createdAt: 1, updatedAt: 1 }, reviewCycles: [],
    workers: { work: { sessionId: id, providerId: 'codex', role: 'work', title: 'Inventory', workspace, model: '', effort: '', profile: 'normal' } } };
  store.updateScope('inventory', 'selection', data, 0); data.workers.work.model = 'inventory-model';
  const update = { type: 'updateAgentScope', requestId: 'selection', company: 'inventory', goal: 'selection', agentToken: parent.agentToken, expectedRevision: 1, data };
  await handleAgentCommand(ws, { getClientState: () => parent }, update, store, () => {});
  assert.equal(ws.frames.at(-1).ok, true, 'cross-provider own-child metadata is allowed');
  data.workers.work.sessionId = child.sessionId;
  await handleAgentCommand(ws, { getClientState: () => parent }, { ...update, expectedRevision: 2 }, store, () => {});
  assert.equal(ws.frames.at(-1).ok, false, 'metadata cannot adopt another session');
});
test('native admission rechecks authority after an awaited validation/unlink', async t => {
  const { states: [parent, child], store } = fixture(t), { CodexSession } = require('../out/backend/providers/codex');
  child.sessionId = 'codex:' + randomUUID();
  child.selection = { providerId: 'codex', model: '', effort: '', thinking: true };
  store.link(parent.sessionId, child.sessionId, 'delegates', [{ id: child.sessionId, providerId: 'codex', role: 'other', title: 'Inventory', workspace: child.workspaceDir, company: 'inventory', goal: 'stock', createdAt: 1, updatedAt: 1 }]);
  let resume; const gate = new Promise(r => { resume = r; }), calls = [];
  const runtime = new CodexSession(child, { async start() {}, async request(method) { calls.push(method); return { thread: { id: 'inventory' } }; }, dispose() {} }, () => gate); child.runtime = runtime;
  const pending = runtime.send({ text: 'Synthetic input' }, { valid: () => { try { authorizeAgent(store, parent.agentToken, child, child.sessionId); return true; } catch { return false; } }, admitted() { assert.fail('stale input'); } });
  await tick(); store.unlink(parent.sessionId, child.sessionId, 'delegates'); resume(); await assert.rejects(pending, /current/); assert.deepEqual(calls, []); runtime.dispose();
});
test('fresh proof is socket-local and cannot be transferred, resumed or revived after close', async t => {
  const { channel, sockets: [first, second], store, workspace } = fixture(t);
  const data = { version: 1, goal: { title: 'Inventory', status: 'active', profile: 'normal', profileRevision: 1, createdAt: 1, updatedAt: 1 }, reviewCycles: [], workers: {} };
  const goal = 'stock-' + randomUUID(); store.updateScope('inventory', goal, data, 0);
  const worker = { role: 'work', providerId: 'claude', title: 'Inventory', workspace, model: '', effort: '', profile: 'normal', sessionId: null };
  await handleAgentCommand(first, channel, { type: 'reserveAgentTurn', requestId: 'reserve', company: 'inventory', goal, key: 'work', fresh: true, worker }, store, () => {});
  assert.equal(first.frames.at(-1).ok, true);
  const link = { type: 'linkAgents', requestId: 'register', company: 'inventory', goal, key: 'work', child: null, parent: 'parent', parentProviderId: 'claude', worker, expectedRevision: 1 };
  await handleAgentCommand(second, channel, link, store, () => {}); assert.equal(second.frames.at(-1).ok, false);
  channel.getClientState(first).sessionId = 'unexpected-resume';
  await handleAgentCommand(first, channel, link, store, () => {}); assert.equal(first.frames.at(-1).ok, false);
  first.emit('close'); assert.equal(store.readScope('inventory', goal).data.workers.work, undefined);
});

test('fresh assignment rejects late IDs, CAS changes and native collisions without granting an edge', async t => {
  const live = require('../out/backend/agentGraphLive');
  for (const failure of ['close', 'cas', 'collision']) {
    const { channel, states: [parent], sockets: [ws], store, workspace } = fixture(t);
    const goal = 'assignment-' + randomUUID(), company = 'inventory';
    const data = { version: 1, goal: { title: 'Inventory', status: 'active', profile: 'normal', profileRevision: 1, createdAt: 1, updatedAt: 1 }, reviewCycles: [], workers: {} };
    store.updateScope(company, goal, data, 0);
    const worker = { role: 'work', providerId: 'claude', title: 'Inventory', workspace, model: '', effort: '', profile: 'normal', sessionId: null };
    await handleAgentCommand(ws, channel, { type: 'reserveAgentTurn', requestId: 'reserve', company, goal, key: 'work', fresh: true, worker }, store, () => {});
    const fresh = channel.getClientState(ws); assert.notEqual(fresh, parent); assert.equal(fresh.sessionId, undefined);
    fresh.selection = { providerId: worker.providerId, model: worker.model, effort: worker.effort, thinking: true };
    await handleAgentCommand(ws, channel, { type: 'linkAgents', requestId: 'register', company, goal, key: 'work', child: null, parent: parent.sessionId, parentProviderId: 'claude', worker, expectedRevision: 1 }, store, () => {});
    assert.equal(ws.frames.at(-1).pending, true);
    const id = failure === 'collision' ? parent.sessionId : 'assigned-' + randomUUID();
    if (failure === 'close') ws.emit('close');
    if (failure === 'cas') { const scope = store.readScope(company, goal); store.updateScope(company, goal, { ...scope.data, goal: { ...scope.data.goal, title: 'Updated inventory' } }, scope.revision); }
    fresh.sessionId = id; let disposed = 0; fresh.runtime = { active: false, dispose() { disposed++; } };
    live.notifyAgentGraph(fresh, { type: 'sessionId', id });
    assert.equal(store.readScope(company, goal).data.workers.work.sessionId, null);
    assert.equal(store.snapshot().edges.some(e => e.from === parent.sessionId && e.to === id && e.from !== e.to), false);
    assert.equal(disposed, failure === 'close' ? 0 : 1, 'only a still-owned fresh entry is disposed');
  }
});

test('command reservations keep one real entry owner across many active releases and settle to zero', async t => {
  const { channel, states: [parent, child], sockets: [, ws], store, workspace } = fixture(t);
  const live = require('../out/backend/agentGraphLive'), registry = require('../out/backend/channel');
  const subscribe = live.onAgentGraphChange; let listeners = 0;
  live.onAgentGraphChange = fn => { listeners++; const off = subscribe(fn); return () => { listeners--; off(); }; };
  t.after(() => { live.onAgentGraphChange = subscribe; require('../out/backend/agentCommands').disposeAgentCommands(); });
  const goal = 'ownership-' + randomUUID();
  store.updateScope('inventory', goal, { version: 1, goal: { title: 'Inventory', status: 'active', profile: 'normal', profileRevision: 1, createdAt: 1, updatedAt: 1 }, reviewCycles: [],
    workers: { work: { role: 'work', providerId: 'claude', title: 'Inventory', workspace, model: '', effort: '', profile: 'normal', sessionId: child.sessionId } } }, 0);
  for (let i = 0; i < 100; i++) {
    await handleAgentCommand(ws, channel, { type: 'reserveAgentTurn', requestId: 'reserve-' + i, company: 'inventory', goal, key: 'work', agentToken: parent.agentToken }, store, () => {});
    assert.equal(ws.frames.at(-1).ok, true);
    await handleAgentCommand(ws, channel, { type: 'releaseAgentTurn', requestId: 'release-' + i }, store, () => {});
    assert.equal(listeners, 1, 'one registry settlement subscription');
    assert.equal(registry.hasDispatchOwnership(), true);
  }
  child.runtime.active = false; child.cliDone = true; live.notifyAgentGraph(child, { type: 'done' });
  assert.equal(listeners, 0); assert.equal(registry.hasDispatchOwnership(), false);
});
