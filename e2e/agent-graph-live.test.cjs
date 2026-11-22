const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-live-')); process.env.ARGUS_CONFIG = path.join(dir, 'settings.json'); process.env.ARGUS_GRAPH_DB = path.join(dir, 'wire.sqlite');
after(() => { require('../out/backend/sessionStats').closeStatsDatabase(); fs.rmSync(dir, { recursive: true, force: true }); });
const { createSessionState } = require('../out/backend/sessionState');
const { projectAgentState, observeAgentGraph, notifyAgentGraph } = require('../out/backend/agentGraphLive');
const { AgentGraph } = require('../out/backend/agentGraph');
const { AgentGraphService, agentGraphService, handleAgentGraphRequest } = require('../out/backend/agentGraphRequests');
const node = id => ({ id, providerId: 'claude', role: 'work', title: id, workspace: dir, company: 'inventory', goal: 'stock', createdAt: 1, updatedAt: 1 });
const socket = () => { const ws = new EventEmitter(); ws.readyState = 1; ws.bufferedAmount = 0; ws.frames = []; ws.send = text => ws.frames.push(JSON.parse(text)); return ws; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('S2-I3 filtered unrelated events and status reads do not list native history repeatedly', async () => {
  const store = new AgentGraph(path.join(dir, 'titles.sqlite')); store.putNodes([node('cold')]); let calls = 0;
  const service = new AgentGraphService(store, () => [], async () => { calls++; return []; }); const ws = socket(), unrelated = createSessionState(dir); unrelated.sessionId = 'outside';
  try {
    await service.get(ws, 'initial', { company: 'other' }, true); await delay(60); const before = calls;
    for (let i = 0; i < 4; i++) { observeAgentGraph(unrelated, { type: 'text_chunk', text: 'Inventory update' }); await delay(40); }
    assert.equal(calls, before); assert.equal(before, 0, 'an empty filtered snapshot needs no native titles'); assert.equal(ws.frames.length, 1);
    const matching = socket(); await service.get(matching, 'matching', {}, true); const loaded = calls;
    for (let i = 0; i < 3; i++) { await service.get(socket(), 'status', {}, false); notifyAgentGraph(); await delay(40); }
    assert.equal(calls, loaded, 'cached status/live refreshes must stay memory-only');
    store.putNodes([node('new-worker')]); await delay(70); assert.equal(calls, loaded + 1, 'relevant new registration refreshes missing titles once');
    const attached = createSessionState(dir); attached.sessionId = 'cold'; notifyAgentGraph(attached, { type: 'sessionAttached' }); await delay(70);
    assert.equal(calls, loaded + 2, 'a relevant entry registration refreshes title metadata');
    notifyAgentGraph(undefined, { type: 'sessionRenamed', id: 'cold', title: 'Updated title' }); await delay(70);
    assert.equal(calls, loaded + 2, 'reuse the native rename accessor result');
    assert.equal(matching.frames.at(-1).upsert.nodes.find(n => n.id === 'cold').title, 'Updated title');
  } finally { service.dispose(); }
});
test('S2-I4 watchdog timedOut remains error through done while scheduled retry remains running', () => {
  const state = createSessionState(dir); observeAgentGraph(state, { type: 'retry_status', attempt: 0, maxRetries: 0, autoRetry: 0, autoRetryMax: 0, timedOut: true });
  observeAgentGraph(state, { type: 'done' }); assert.equal(projectAgentState(state).status, 'error');
  observeAgentGraph(state, { type: 'thinking_start' }); observeAgentGraph(state, { type: 'retry_status', autoRetry: 1, timedOut: false });
  assert.equal(projectAgentState(state).status, 'running');
});
test('graph title lookup requests only the sessions visible in the requested scope', async t => {
  const store = new AgentGraph(path.join(dir, 'scoped-titles.sqlite'));
  store.putNodes([node('visible'), { ...node('outside'), company: 'shipping' }]);
  const service = new AgentGraphService(store, () => [], async (_providerId, _workspace, ids) => {
    assert.deepEqual(ids, ['visible']);
    return [{ id: 'visible', title: 'Stock count' }];
  });
  t.after(() => service.dispose());
  const ws = socket();
  await service.get(ws, 'scoped', { company: 'inventory' }, false);
  assert.equal(ws.frames[0].snapshot.nodes[0].title, 'Stock count');
});
test('S2-I4 actual exhausted watchdog producer projects error without changing its frames', () => {
  const { readConfig, writeConfig } = require('../out/backend/config'); const { createWatchdog } = require('../out/backend/watchdog');
  const previous = readConfig(), interval = global.setInterval; let tick; const state = createSessionState(dir), frames = [];
  writeConfig({ ...previous, watchdogEnabled: true, watchdogTimeout: 0, watchdogAutoRetries: 0 });
  global.setInterval = callback => { tick = callback; return 1; };
  try {
    const watchdog = createWatchdog({ broadcast: line => { const event = JSON.parse(line); frames.push(event); observeAgentGraph(state, event); },
      getProc: () => undefined, getCliDone: () => false, setCliDone: done => { state.cliDone = done; }, getPendingAskCount: () => 0,
      getLastMessage: () => ({ text: '' }), sendLog: () => {}, emitSyntheticSend: () => assert.fail('no retry'), checkApiError: () => undefined });
    watchdog.state.active = true; watchdog.state.lastEventTime = Date.now() - 1000; tick();
    assert.deepEqual(frames.map(e => e.type), ['retry_status', 'done']); assert.equal(frames[0].timedOut, true); assert.equal(projectAgentState(state).status, 'error');
  } finally { global.setInterval = interval; writeConfig(previous); }
});
test('S2-I3 native rename boundary supplies fresh titles without an additional graph history list', async () => {
  const { provider } = require('../out/backend/providers/registry'); const { handleProviderRequest } = require('../out/backend/providers/requests');
  const owner = provider('claude'), other = provider('codex'), originals = [owner.rename, owner.list, other.list];
  let title = 'Before', graphLists = 0, nativeLists = 0;
  const store = new AgentGraph(path.join(dir, 'rename.sqlite')); store.putNodes([node('rename-target')]);
  const state = createSessionState(dir); state.sessionId = 'rename-target'; state.selection.providerId = 'claude';
  const service = new AgentGraphService(store, () => [state], async () => { graphLists++; return [{ id: 'rename-target', title }]; });
  try {
    await service.get(socket(), 'initial', {}, true);
    owner.rename = async (_id, _workspace, value) => { title = value; };
    owner.list = async () => { nativeLists++; return [{ id: 'rename-target', title }]; }; other.list = async () => [];
    await handleProviderRequest(socket(), { getClientState: () => state, getViewingSessionId: () => undefined }, { type: 'renameSession', id: 'rename-target', title: 'After' }, () => {});
    await delay(70); const result = socket(); await service.get(result, 'status', {}, false);
    assert.equal(result.frames[0].snapshot.nodes[0].title, 'After'); assert.equal(nativeLists, 1); assert.equal(graphLists, 1);
  } finally { [owner.rename, owner.list, other.list] = originals; service.dispose(); }
});
test('S2-I3 memory-only refresh still projects rebind away from a registered ID', async () => {
  const store = new AgentGraph(path.join(dir, 'rebind.sqlite')); store.putNodes([node('previous')]); const state = createSessionState(dir); state.sessionId = 'previous';
  const service = new AgentGraphService(store, () => [state], async () => []), ws = socket();
  try { await service.get(ws, 'initial', {}, true); await delay(70); assert.equal(ws.frames.length, 1);
    state.sessionId = 'outside'; observeAgentGraph(state, { type: 'sessionId' }); await delay(70);
    assert.equal(ws.frames.at(-1).upsert?.nodes[0].live, false);
  } finally { service.dispose(); }
});
test('both providers project normalized needs-input/running/idle/terminal facts without guessing completion or active settings', () => {
  for (const providerId of ['claude', 'codex']) {
    const s = createSessionState(dir); s.selection.providerId = providerId;
    assert.equal(projectAgentState(s).status, 'idle'); s.runtime = { active: true };
    observeAgentGraph(s, { type: 'thinking_start' }); assert.equal(projectAgentState(s).status, 'running'); assert.equal(projectAgentState(s).activeSelection, null);
    s.interaction = { id: 'choice', kind: 'question', async: true, title: 'Choose section', questions: [] }; s.runtime.active = false;
    observeAgentGraph(s, { type: 'done' }); assert.equal(projectAgentState(s).status, 'needs-input'); s.interaction = null;
    observeAgentGraph(s, { type: 'interaction', request: null }); assert.equal(projectAgentState(s).status, 'idle');
    observeAgentGraph(s, { type: 'error' }); observeAgentGraph(s, { type: 'done' }); assert.equal(projectAgentState(s).status, 'error');
    observeAgentGraph(s, { type: 'thinking_start' }); observeAgentGraph(s, { type: 'retry_status', errorRetry: true }); assert.equal(projectAgentState(s).status, 'running');
    observeAgentGraph(s, { type: 'done', interrupted: true }); assert.equal(projectAgentState(s).status, 'stopped');
    s.sessionId = 'different'; assert.equal(projectAgentState(s).status, 'idle', 'rebind cannot inherit a previous terminal result');
  }
  assert.deepEqual(projectAgentState(undefined), { live: false, status: null, pendingInteraction: null, selected: null, activeSelection: null, lastEventAt: null, lastEventSummary: null });
});
test('initial snapshots, coalesced diffs, selection/title/removal and reconnect preserve client revision continuity', async t => {
  const store = new AgentGraph(path.join(dir, 'subscribe.sqlite')); store.putNodes([node('parent'), node('child')]);
  const state = createSessionState(dir); state.sessionId = 'child'; state.selection.providerId = 'claude'; let states = [state], title = 'Fresh title';
  const service = new AgentGraphService(store, () => states, async () => [{ id: 'child', title }]); t.after(() => service.dispose());
  const ws = socket(); await service.get(ws, 'initial', {}, true); const initial = ws.frames[0].snapshot;
  assert.equal(initial.nodes.find(n => n.id === 'child').title, title); notifyAgentGraph(); await delay(60); assert.equal(ws.frames.length, 1);
  state.interaction = { id: 'question', kind: 'question', title: 'Choose', questions: [] }; observeAgentGraph(state, { type: 'interaction', request: state.interaction }); state.selection.model = 'inventory-model'; title = 'Renamed'; notifyAgentGraph(state, { type: 'sessionRenamed', id: 'child' });
  await delay(80); const diff = ws.frames[1]; assert.deepEqual(diff.baseRevision, initial.revision); assert.equal(diff.upsert.nodes[0].status, 'needs-input'); assert.equal(diff.upsert.nodes[0].selected.model, 'inventory-model'); assert.equal(diff.upsert.nodes[0].title, title);
  states = []; notifyAgentGraph(); await delay(80); assert.equal(ws.frames[2].upsert.nodes[0].live, false);
  const reconnect = socket(); await service.get(reconnect, 'reconnect', {}, true); assert.deepEqual(reconnect.frames[0].snapshot.revision, ws.frames[2].revision);
  const filtered = socket(); await service.get(filtered, 'filtered', { company: 'other' }, false); assert.deepEqual(filtered.frames[0].snapshot.nodes, []); ws.emit('close'); reconnect.emit('close');
});
test('token callers cannot adopt, forge parent, mutate another edge or use invalid/pending identity', async t => {
  const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel'); const channel = getOrCreateChannel(dir), ws = socket(); channel.addClient(ws, true);
  const caller = channel.getClientState(ws); caller.sessionId = 'parent'; caller.selection.providerId = 'claude';
  const service = agentGraphService(); t.after(() => { service.dispose(); destroyChannel(dir); }); service.store.putNodes(['parent', 'child', 'other'].map(node));
  const request = async value => { const client = socket(); await handleAgentGraphRequest(client, { requestId: 'request', agentToken: caller.agentToken, parent: 'parent', child: 'child', kind: 'delegates', ...value }); return client.frames[0]; };
  assert.equal((await request({ type: 'linkAgents' })).error?.code, 'graph_assignment_required');
  service.store.link('parent', 'child', 'delegates'); service.store.link('other', 'child', 'reviews');
  assert.equal((await request({ type: 'linkAgents' })).ok, true);
  assert.equal((await request({ type: 'linkAgents', role: 'work' })).ok, true, 'an unchanged descriptive role remains idempotent');
  assert.equal((await request({ type: 'unlinkAgents', parent: 'other', kind: 'reviews' })).error.code, 'graph_forbidden');
  assert.equal((await request({ type: 'unlinkAgents', agentToken: 'invalid' })).error.code, 'graph_forbidden');
  caller.sessionId = undefined; assert.equal((await request({ type: 'unlinkAgents' })).error.code, 'graph_forbidden'); caller.sessionId = 'parent';
  assert.equal((await request({ type: 'unlinkAgents' })).ok, true); assert.equal((await request({ type: 'linkAgents' })).error.code, 'graph_assignment_required');
  assert.equal(service.store.snapshot().edges.length, 1);
});
test('notification bursts do not queue unbounded refresh jobs behind a slow metadata accessor', async () => {
  const store = new AgentGraph(path.join(dir, 'slow.sqlite')); store.putNodes([node('slow')]); let block = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = new AgentGraphService(store, () => [], async () => { if (block) await gate; return []; });
  const ws = socket(); await service.get(ws, 'initial', {}, true); await delay(50); block = true;
  const publish = service.publish; let started = 0; service.publish = function() { started++; return publish.call(this); };
  try {
    notifyAgentGraph(undefined, { type: 'sessionRenamed', id: 'slow' });
    for (let i = 0; i < 5; i++) { notifyAgentGraph(); await delay(35); }
    assert.equal(started, 1, 'only one publish job may wait on metadata');
  } finally { release(); await delay(70); service.dispose(); }
});
test('published active settings are independent of selected settings and later runtime mutations', () => {
  const state = createSessionState(dir), running = { ...state.selection, model: 'running-model' };
  state.runtime = { active: true, getSessionControl: () => ({ activeSelection: running }) };
  const before = projectAgentState(state); state.selection.model = 'next-model'; running.model = 'later-model';
  assert.equal(before.activeSelection.model, 'running-model'); assert.notEqual(before.selected.model, 'next-model');
});
