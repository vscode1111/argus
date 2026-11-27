const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const settings = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-settings-'));
process.env.ARGUS_CONFIG = path.join(settings, 'settings.json'); process.env.ARGUS_STATS_DB = path.join(settings, 'stats.sqlite');
after(() => fs.rmSync(settings, { recursive: true, force: true }));
const node = id => ({ id, providerId: 'claude', role: 'work', workspace: 'D:/inventory', company: 'inventory', goal: 'stock', title: id, createdAt: 1, updatedAt: 1 });
function delivery(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-core-')); const { AgentGraph } = require('../out/backend/agentGraph');
  const graph = new AgentGraph(path.join(dir, 'graph.sqlite')); graph.link('parent', 'child', 'delegates', [node('parent'), node('child')]);
  const { createSessionState } = require('../out/backend/sessionState'); const states = ['parent', 'child'].map(id => { const s = createSessionState('D:/inventory'); s.sessionId = id; s.cliDone = true; return s; });
  const target = '../out/backend/agentDelivery'; const { AgentDelivery } = fs.existsSync(require.resolve('../out/backend/agentGraph').replace('agentGraph.js', 'agentDelivery.js')) ? require(target) : {};
  assert.equal(typeof AgentDelivery, 'function', 'bounded dispatcher exists');
  let now = 0; const sends = [];
  const d = new AgentDelivery(graph, { states: () => states, now: () => now,
    acquire: n => ({ state: states.find(s => s.sessionId === n.id), release() {} }),
    send: async (s, input, admission) => { if (!admission.valid()) return; admission.admitted(); sends.push({ id: s.sessionId, text: input.text }); } }, { coalesce: 0, interval: 0 });
  t.after(() => { d.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { graph, states, d, sends, advance: n => { now += n; } };
}
test('upward multi-parent delivery coalesces duplicate edge kinds and preserves current reports after long question waits', async t => {
  const { graph, states, d, sends, advance } = delivery(t);
  graph.link('parent', 'child', 'reviews'); graph.link('other', 'child', 'delegates', [node('other')]);
  const other = { ...states[0], sessionId: 'other' }; states.push(other);
  states[0].interaction = { id: 'human', kind: 'question', title: 'Choose' };
  d.observe(states[1], { type: 'error', text: 'Synthetic failure' }); d.observe(states[1], { type: 'done' });
  await d.flush(); assert.deepEqual(sends.map(s => s.id), ['other']); advance(180000);
  states[0].interaction = null; await d.flush();
  assert.equal(sends.length, 2); assert.equal(sends[1].id, 'parent'); assert.match(sends[1].text, /^🤖/); assert.match(sends[1].text, /error/);
  await d.flush(); assert.equal(sends.length, 2);
});
test('stop/unlink/relink cancels stale batches and manual resume does not revive them', async t => {
  const { graph, states, d, sends } = delivery(t);
  d.observe(states[1], { type: 'done' }); d.stop(states[0]); assert.equal(d.stats().timers, 0); await d.flush(); assert.equal(sends.length, 0);
  d.manual(states[0]); await d.flush(); assert.equal(sends.length, 0);
  d.observe(states[1], { type: 'thinking_start' }); d.observe(states[1], { type: 'done' });
  graph.unlink('parent', 'child', 'delegates'); graph.link('parent', 'child', 'delegates'); await d.flush(); assert.equal(sends.length, 0);
});
test('exchange awaiting-reply reflects each child and resolution arriving during native admission', async t => {
  const { graph, states, d, advance } = delivery(t);
  graph.link('parent', 'second', 'delegates', [node('second')]); const second = { ...states[1], sessionId: 'second' }; states.push(second);
  for (const state of [states[1], second]) { state.interaction = { id: state.sessionId + '-choice', kind: 'question', title: 'Choose' }; d.observe(state, { type: 'interaction', request: state.interaction }); }
  await d.flush(); advance(25); await d.flush();
  for (const edge of graph.snapshot().edges) assert.equal(edge.reverse.questionId, edge.to + '-choice');
  d.observe(states[1], { type: 'thinking_start' }); states[1].interaction = { id: 'next-choice', kind: 'question', title: 'Choose' }; d.observe(states[1], { type: 'interaction', request: states[1].interaction });
  d.deps.send = async (_state, _input, admission) => { admission.admitted(); states[1].interaction = null; d.observe(states[1], { type: 'interaction_resolved', id: 'next-choice', reason: 'answered' }); };
  await d.flush(); assert.equal(graph.snapshot().edges.find(e => e.to === 'child').reverse.awaitingReply, false);
});
test('equivalent Windows workspace spelling still admits the exact registered parent', { skip: process.platform !== 'win32' }, async t => {
  const { states, d, sends } = delivery(t); states[0].workspaceDir = 'd:\\INVENTORY';
  d.observe(states[1], { type: 'done' }); await d.flush(); assert.equal(sends.length, 1);
});
test('graph stop intent suppresses a terminal interruption error notification', async t => {
  const { states, d } = delivery(t); d.observe(states[1], { type: 'done' }); await d.flush();
  d.stop(states[0]); assert.equal(d.metadata(states[0], { type: 'error', text: 'Synthetic interruption failure' }).notificationBlocked, true);
});
test('D2 actual watchdog exhaustion is terminal journal error, ordinary retry is not', () => {
  const { SessionJournal } = require('../out/backend/sessionJournal');
  for (const timedOut of [true, false]) {
    const j = new SessionJournal(), owner = {};
    j.observe(owner, 'inventory', { type: 'thinking_start' });
    j.observe(owner, 'inventory', { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 0, autoRetry: 0, autoRetryMax: 0, ...(timedOut ? { timedOut: true } : {}) });
    if (timedOut) j.observe(owner, 'inventory', { type: 'done' });
    const page = j.read('inventory');
    assert.equal(page.events.find(e => e.kind === 'retry').data.timedOut, timedOut);
    if (timedOut) assert.equal(page.events.at(-1).data.outcome, 'error');
    else assert.equal(page.events.some(e => e.kind === 'end'), false);
  }
});
test('exhausted watchdog callback produces journal terminal error without another lifecycle owner', () => {
  const { SessionJournal } = require('../out/backend/sessionJournal'), { createWatchdog } = require('../out/backend/watchdog');
  const { writeConfig, readConfig } = require('../out/backend/config'); const prior = readConfig();
  writeConfig({ ...prior, watchdogEnabled: true, watchdogTimeout: 0, watchdogAutoRetries: 0 });
  const journal = new SessionJournal(), owner = {}; let tick; const interval = global.setInterval;
  let done = false;
  global.setInterval = fn => { tick = fn; return { unref() {} }; };
  try {
    const watchdog = createWatchdog({ broadcast: value => journal.observe(owner, 'inventory', JSON.parse(value)), getProc: () => undefined,
      getCliDone: () => done, setCliDone: value => { done = value; }, getPendingAskCount: () => 0, getLastMessage: () => null,
      sendLog() {}, emitSyntheticSend() { assert.fail('exhausted path cannot retry'); }, checkApiError: () => undefined });
    watchdog.state.active = true; watchdog.state.lastEventTime = 1; tick();
    assert.equal(journal.read('inventory').events.at(-1).data.outcome, 'error');
  } finally { global.setInterval = interval; writeConfig(prior); }
});
test('subscriptions opt in only explicit tool failures and retries/questions block admission', async t => {
  const { graph, states, d, sends, advance } = delivery(t);
  graph.configurePush('parent', 'child', 'delegates', { questions: false, errors: false, turnEnd: false, milestones: [] }, graph.snapshot().storeRevision);
  for (const outcome of ['failure', 'unknown', 'cancelled']) d.observe(states[1], { type: 'tool_end', call: { outcome } });
  await d.flush(); assert.equal(sends.length, 0);
  graph.configurePush('parent', 'child', 'delegates', { questions: true, errors: true, turnEnd: true, milestones: ['tool-failure'] }, graph.snapshot().storeRevision);
  states[0].errorRetry = { pending: true };
  d.observe(states[1], { type: 'tool_end', call: { outcome: 'failure' } }); await d.flush(); assert.equal(sends.length, 0);
  advance(120000); states[0].errorRetry = { pending: false }; await d.flush(); assert.equal(sends.length, 1); assert.match(sends[0].text, /tool failure/);
  const pending = d.pending('parent'); states[1].pendingBgTasks.set('task', 1); assert.equal(d.pending('parent').pendingAgentChildren, pending.pendingAgentChildren + 1);
  states.splice(1, 1); assert.equal(d.pending('parent').unknownAgentChildren, 1);
});
test('per-edge rate and bounded current reports survive bursts without native metadata or SQLite reads', async t => {
  const { graph, states, d, sends, advance } = delivery(t); d.limits.interval = 5000;
  let reads = 0; const snapshot = graph.snapshot; graph.snapshot = function() { reads++; return snapshot.call(this); };
  for (let i = 0; i < 5000; i++) d.observe(states[1], { type: 'text_chunk', text: 'Synthetic text' });
  assert.equal(reads, 0);
  d.observe(states[1], { type: 'done' }); await d.flush(); assert.equal(sends.length, 1);
  d.observe(states[1], { type: 'thinking_start' }); d.observe(states[1], { type: 'done' }); await d.flush(); assert.equal(sends.length, 1);
  assert.equal(d.stats().reports, 1); assert.ok(d.stats().bytes < 2048); assert.ok(d.stats().timers <= 1);
  advance(5000); await d.flush(); assert.equal(sends.length, 2); d.dispose(); assert.equal(d.stats().timers, 0); assert.equal(d.stats().reports, 0);
});
test('failed pre-admission preparation is rate bounded and keeps one dirty report', async t => {
  const { states, d, advance } = delivery(t); d.limits.interval = 5000; let attempts = 0;
  d.deps.send = async () => { attempts++; throw Error('Synthetic preparation failure'); };
  d.observe(states[1], { type: 'done' }); await d.flush(); advance(25); await d.flush(); assert.equal(attempts, 1);
  advance(5000); await d.flush(); assert.equal(attempts, 2); assert.equal(d.stats().reports, 1);
});
test('D1 stop intent and edge subscriptions persist, relinking does not reset them', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { AgentGraph } = require('../out/backend/agentGraph'); const file = path.join(dir, 'graph.sqlite'); const graph = new AgentGraph(file);
  graph.link('parent', 'child', 'delegates', [node('parent'), node('child')]);
  assert.equal(typeof graph.setUserStopped, 'function', 'small stop-intent mutation exists');
  graph.setUserStopped('parent', true);
  graph.configurePush('parent', 'child', 'delegates', { questions: false, errors: true, turnEnd: false, milestones: ['tool-failure'] }, graph.snapshot().storeRevision);
  graph.link('parent', 'child', 'delegates');
  const reopened = new AgentGraph(file).snapshot(); assert.equal(reopened.nodes.find(n => n.id === 'parent').userStopped, true);
  assert.deepEqual(reopened.edges[0].push, { questions: false, errors: true, turnEnd: false, milestones: ['tool-failure'] });
  assert.throws(() => graph.configurePush('parent', 'child', 'delegates', reopened.edges[0].push, 0), /revision/);
});

test('S4-I1 blocked and rate-limited prefixes leave slots for due parents without polling blocked work', async t => {
  for (const blocked of ['question', 'rate']) {
    const { graph, states, d, sends } = delivery(t); d.limits.concurrent = 1;
    graph.link('ready', 'child', 'delegates', [node('ready')]); states.push({ ...states[0], sessionId: 'ready' });
    if (blocked === 'question') states[0].interaction = { id: 'human', kind: 'question' };
    else { d.limits.interval = 5000; d.lastAttempt.set(graph.snapshot().edges.find(e => e.from === 'parent').id, 0); }
    d.observe(states[1], { type: 'done' }); await d.flush(); assert.deepEqual(sends.map(s => s.id), ['ready']);
    if (blocked === 'question') assert.equal(d.stats().timers, 0);
  }
});

test('S4-I1 sustained events deliver before the producer stops at production default timings', async t => {
  const { states, d, sends } = delivery(t);
  d.now = Date.now; d.limits.coalesce = 2000; d.limits.interval = 5000;
  d.observe(states[1], { type: 'error' });
  const producer = setInterval(() => d.observe(states[1], { type: 'error' }), 5);
  try {
    await new Promise(resolve => setTimeout(resolve, 2400));
    assert.equal(sends.length, 1, 'a marked send occurs while the error producer is still running');
    assert.match(sends[0].text, /^🤖/);
  } finally { clearInterval(producer); }
});

test('S4-I1 timers retain their deadline, move earlier and cancel when recipients block', t => {
  const { graph, states, d } = delivery(t); const timers = [], cancelled = [];
  graph.link('parent', 'second', 'delegates', [node('second')]); const second = { ...states[1], sessionId: 'second' }; states.push(second);
  const timeout = global.setTimeout, clear = global.clearTimeout;
  global.setTimeout = (_fn, delay) => { const timer = { delay, unref() {} }; timers.push(timer); return timer; };
  global.clearTimeout = timer => cancelled.push(timer);
  try {
    d.limits.coalesce = 1000; d.observe(states[1], { type: 'error' });
    d.observe(states[1], { type: 'error' }); assert.equal(timers.length, 1);
    d.limits.coalesce = 100; d.observe(second, { type: 'error' }); assert.equal(timers.length, 2); assert.equal(timers[1].delay, 100);
    states[0].interaction = { id: 'human', kind: 'question' }; d.observe(states[0], { type: 'interaction', request: states[0].interaction });
    assert.equal(d.stats().timers, 0); assert.equal(cancelled.length, 2);
    d.dispose(); assert.equal(d.stats().timers, 0);
  } finally { global.setTimeout = timeout; global.clearTimeout = clear; }
});

test('S4-I2 many injections retain one actual registry owner and settlement listener then zero', async t => {
  const { graph, states, d } = delivery(t), { EventEmitter } = require('node:events');
  const live = require('../out/backend/agentGraphLive'), channel = require('../out/backend/channel');
  let listeners = 0; const subscribe = live.onAgentGraphChange;
  live.onAgentGraphChange = fn => { listeners++; const off = subscribe(fn); return () => { listeners--; off(); }; };
  const ws = new EventEmitter(); ws.readyState = 1; ws.send = () => {};
  const registry = channel.getOrCreateChannel(states[0].workspaceDir); registry.addClient(ws, true);
  const parent = registry.getClientState(ws); parent.sessionId = 'parent'; parent.runtime = { active: true, dispose() {} };
  states[0] = parent; let owners = 0;
  d.deps.acquire = (n, settled) => { owners++; let released = false;
    const finish = () => { if (!released) { released = true; owners--; } settled?.(); };
    const owned = channel.acquireSessionEntry(n.workspace, n.id, 43210, finish);
    return { state: owned.state, release(force) { const done = owned.release(force); if (done && !released) finish(); return done; } }; };
  try {
    for (let i = 0; i < 100; i++) { d.observe(states[1], { type: 'thinking_start' }); d.observe(states[1], { type: 'done' }); await d.flush(); }
    assert.equal(owners, 1); assert.equal(listeners, 1);
    parent.runtime.active = false; live.observeAgentGraph(parent, { type: 'done' });
    assert.equal(d.owners.size, 0); d.observe(parent, { type: 'done' });
    assert.equal(owners, 0); assert.equal(listeners, 0);
    parent.runtime.active = true; d.observe(states[1], { type: 'thinking_start' }); d.observe(states[1], { type: 'done' }); await d.flush();
    assert.equal(owners, 1); assert.equal(listeners, 1);
    d.dispose(); assert.equal(owners, 0); assert.equal(listeners, 0); assert.equal(d.owners.size, 0);
  } finally { d.dispose(); live.onAgentGraphChange = subscribe; channel.destroyChannel(parent.workspaceDir); }
});

test('S4-I3 resolution during awaited admission cancels stale text and retains only current terminal facts', async t => {
  for (const reason of ['answered', 'superseded']) for (const terminal of [true, false]) {
    const { states, d, sends, advance } = delivery(t); let resume, entered;
    const waiting = new Promise(r => { entered = r; }), gate = new Promise(r => { resume = r; });
    states[1].interaction = { id: 'choice', kind: 'question', async: true };
    d.observe(states[1], { type: 'interaction', request: states[1].interaction }); if (terminal) d.observe(states[1], { type: 'done' });
    const send = d.deps.send; let valid;
    d.deps.send = async (_s, _input, admission) => { entered(); await gate; valid = admission.valid(); if (valid) admission.admitted(); };
    const pending = d.flush(); await waiting;
    states[1].interaction = null; d.observe(states[1], { type: 'interaction_resolved', id: 'choice', reason }); resume(); await pending;
    assert.equal(valid, false); d.deps.send = send; advance(25); await d.flush();
    assert.equal(sends.length, terminal ? 1 : 0); if (terminal) { assert.doesNotMatch(sends[0].text, /question pending/); assert.match(sends[0].text, /turn ended/); }
  }
});

test('question notice identifies the source session once', async t => {
  const { states, d, sends } = delivery(t);
  states[1].interaction = { id: 'choice', kind: 'question' };
  d.observe(states[1], { type: 'interaction', request: states[1].interaction });
  await d.flush();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, '🤖 question pending. Details: watch --session child');
});

test('S4-I4 independent parallel subscriptions union facts in both edge orders', async t => {
  for (const reverse of [false, true]) {
    const { graph, states, d, sends } = delivery(t); graph.unlink('parent', 'child', 'delegates');
    for (const kind of reverse ? ['reviews', 'delegates'] : ['delegates', 'reviews']) graph.link('parent', 'child', kind);
    for (const kind of ['delegates', 'reviews']) graph.configurePush('parent', 'child', kind,
      { questions: kind === 'delegates', errors: kind === 'reviews', turnEnd: false, milestones: [] }, graph.snapshot().storeRevision);
    states[1].interaction = { id: 'choice', kind: 'question' }; d.observe(states[1], { type: 'interaction', request: states[1].interaction }); d.observe(states[1], { type: 'error' });
    await d.flush(); assert.equal(sends.length, 1); assert.match(sends[0].text, /question pending/); assert.match(sends[0].text, /error/);
    assert.equal(d.stats().reports, 0); assert.equal(d.lastAttempt.size, 2);
    for (const edge of graph.snapshot().edges) assert.equal(edge.reverse.awaitingReply, true);
  }
});
