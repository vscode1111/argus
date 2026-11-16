const { test, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-admission-'));
process.env.ARGUS_CONFIG = path.join(dir, 'settings.json'); process.env.ARGUS_STATS_DB = path.join(dir, 'stats.sqlite');
process.env.ARGUS_USAGE_POLL = '0';
process.env.ARGUS_MODEL_REFRESH = '0';
const { createSessionState } = require('../out/backend/sessionState');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
test('busy native autonomous injection preserves parser discriminator and cancelled admission writes nothing', async () => {
  const { claudeProvider } = require('../out/backend/providers/claude'); const state = createSessionState(dir), events = [], writes = [];
  state.broadcast = text => events.push(JSON.parse(text)); state.sendLog = () => {};
  state.currentProc = { stdin: { writable: true, write: text => writes.push(text) } }; state.cliDone = false; state.autonomousTurn = true;
  const runtime = claudeProvider.createSession(state);
  await runtime.send({ text: '🤖 Synthetic inventory report' }, { automatic: true, valid: () => true, admitted() {} });
  assert.equal(state.autonomousTurn, true, 'native result discriminator survives automatic injection');
  assert.equal(writes.length, 1);
  await assert.rejects(runtime.send({ text: 'Synthetic cancelled report' }, { automatic: true, valid: () => false, admitted() { assert.fail('not admitted'); } }), /current/);
  assert.equal(writes.length, 1);
});
test('cold native orphan result cannot finish an ordinary graph-origin request', () => {
  const { handleCliEvent } = require('../out/backend/cliHandler'); const state = createSessionState(dir), frames = [];
  state.broadcast = text => frames.push(JSON.parse(text)); state.sendLog = () => {}; state.resetStaleTimer = () => {};
  state.watchdog = { state: {} }; state.cliDone = false; state.autonomousTurn = false;
  handleCliEvent(state, { type: 'result', subtype: 'success', num_turns: 0, origin: { kind: 'task-notification' } });
  assert.equal(frames.some(f => f.type === 'done'), false); assert.equal(state.cliDone, false);
});
test('native async preparation checks admission after validation and never submits a stale turn', async () => {
  const { CodexSession } = require('../out/backend/providers/codex'); const { saveSession } = require('../out/backend/providers/store');
  const state = createSessionState(dir), frames = [], calls = []; state.selection.providerId = 'codex'; state.sessionId = 'codex:inventory';
  saveSession({ id: state.sessionId, cwd: dir, selection: state.selection, title: 'Inventory', updatedAt: 1 });
  state.broadcast = text => frames.push(JSON.parse(text));
  let valid = true, release; const gate = new Promise(resolve => { release = resolve; });
  const rpc = { async start() {}, async request(method) { calls.push(method); return method === 'thread/resume' ? { thread: { id: 'inventory' } } : { turn: { id: 'report' } }; }, dispose() {} };
  const runtime = new CodexSession(state, rpc, async () => gate); state.runtime = runtime;
  try {
    const send = runtime.send({ text: '🤖 Synthetic report' }, { automatic: true, valid: () => valid, admitted() { assert.fail('stale admission'); } });
    await new Promise(r => setImmediate(r)); valid = false; release(); await assert.rejects(send, /current/);
    assert.deepEqual(calls, []); assert.equal(frames.some(f => f.type === 'message' || f.type === 'done' || f.type === 'error'), false);
  } finally { release(); runtime.dispose(); }
});
test('registry acquisition protects idle writer and releases only after pending work settles', () => {
  const { getOrCreateChannel, acquireSessionEntry, hasDispatchOwnership, reapIdleCliProcs, destroyChannel } = require('../out/backend/channel');
  const { observeAgentGraph } = require('../out/backend/agentGraphLive'); const { EventEmitter } = require('node:events');
  const channel = getOrCreateChannel(dir), ws = new EventEmitter(); ws.readyState = 1; ws.send = () => {}; channel.addClient(ws, true);
  const state = channel.getClientState(ws); state.sessionId = 'inventory'; state.cliDone = true;
  let disposed = 0; state.runtime = { active: false, dispose() { disposed++; } };
  const owned = acquireSessionEntry(dir, 'inventory', 43210); assert.equal(owned.state, state); assert.equal(hasDispatchOwnership(), true);
  assert.deepEqual(reapIdleCliProcs(1, Date.now() + 10000), []); assert.equal(disposed, 0);
  state.interaction = { id: 'human', kind: 'question', title: 'Choose' }; owned.release(); assert.equal(hasDispatchOwnership(), true);
  state.interaction = null; observeAgentGraph(state, { type: 'interaction_resolved', id: 'human' }); assert.equal(hasDispatchOwnership(), false);
  destroyChannel(dir);
});
test('subscription wire updates require the existing parent and exact store revision', async t => {
  const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel');
  const { agentGraphService, handleAgentGraphRequest } = require('../out/backend/agentGraphRequests');
  const { EventEmitter } = require('node:events'); const channel = getOrCreateChannel(dir), ws = new EventEmitter(); ws.readyState = 1; const frames = []; ws.send = value => frames.push(JSON.parse(value));
  channel.addClient(ws, true); const state = channel.getClientState(ws); state.sessionId = 'inventory-parent';
  const graph = agentGraphService(); t.after(() => { graph.dispose(); destroyChannel(dir); });
  const node = id => ({ id, providerId: 'claude', role: 'work', workspace: dir, company: 'inventory', goal: 'stock', title: 'Inventory', createdAt: 1, updatedAt: 1 });
  graph.store.link('inventory-parent', 'inventory-child', 'delegates', [node('inventory-parent'), node('inventory-child')]);
  graph.store.link('other-parent', 'inventory-child', 'reviews', [node('other-parent')]);
  const push = { questions: false, errors: true, turnEnd: true, milestones: [] };
  const send = async value => { frames.length = 0; await handleAgentGraphRequest(ws, { type: 'setAgentEdgePush', requestId: 'settings', parent: 'inventory-parent', child: 'inventory-child', kind: 'delegates', push,
    expectedStoreRevision: graph.store.snapshot().storeRevision, agentToken: state.agentToken, ...value }); return frames[0]; };
  assert.equal((await send({ agentToken: 'invalid' })).error.code, 'graph_forbidden');
  assert.equal((await send({ parent: 'other-parent', kind: 'reviews' })).error.code, 'graph_forbidden');
  assert.equal((await send({ expectedStoreRevision: 0 })).error.code, 'graph_revision_conflict');
  assert.equal((await send({})).ok, true); assert.equal(graph.store.snapshot().edges.find(e => e.from === 'inventory-parent').push.questions, false);
});
test('socketless dispatch ownership inhibits existing server idle shutdown until release', async () => {
  const { startServer } = require('../out/backend/index'), { acquireSessionEntry, destroyChannel } = require('../out/backend/channel');
  const { observeAgentGraph } = require('../out/backend/agentGraphLive');
  let stopped = 0; const server = await startServer({ port: 0, idleTimeoutMs: 40, onIdleShutdown: () => { stopped++; } });
  const owned = acquireSessionEntry(dir, 'idle-parent', server.port); owned.state.interaction = { id: 'human', kind: 'question', title: 'Choose' };
  try {
    owned.release(); await new Promise(r => setTimeout(r, 80)); assert.equal(stopped, 0);
    owned.state.interaction = null; observeAgentGraph(owned.state, { type: 'interaction_resolved', id: 'human' });
    await new Promise(r => setTimeout(r, 80)); assert.equal(stopped, 1);
  } finally { owned.release(true); server.close(); destroyChannel(dir); }
});
