const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-contract-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { AgentGraph } = require('../out/backend/agentGraph'); const file = path.join(dir, 'graph.sqlite');
  return { dir, file, graph: new AgentGraph(file), AgentGraph };
}
const node = (id, role = 'work') => ({ id, providerId: 'claude', role, workspace: 'D:/inventory', company: 'inventory', goal: 'stock', title: id, createdAt: 1, updatedAt: 1 });
const document = () => ({ version: 1, goal: { title: 'Inventory', status: 'done', profile: 'normal', profileRevision: 1, createdAt: 1, updatedAt: 1 },
  reviewCycles: [{ deliverable: 'report', count: 3 }], workers: { work: { role: 'work', providerId: 'claude', workspace: 'D:/inventory', title: 'Inventory worker', profile: 'normal', model: '', effort: '', sessionId: null } } });

test('worker sandbox mode validates, binds and round-trips with legacy compatibility', t => {
  const { graph, file, AgentGraph } = fixture(t);
  const { worker } = require('../out/backend/agentGraphValidation');
  assert.deepEqual(worker(document().workers.work), document().workers.work);
  for (const mode of ['edit', 'plan', 'full-access']) {
    const data = document(); data.workers.work.mode = mode;
    const scope = graph.updateScope('inventory', mode, data, 0);
    const bound = graph.bindWorker('inventory', mode, 'work', { ...node('parent-' + mode, 'coordinator'), goal: mode }, { ...node('child-' + mode), goal: mode }, scope.revision);
    assert.equal(bound.data.workers.work.mode, mode);
    assert.equal(new AgentGraph(file).readScope('inventory', mode).data.workers.work.mode, mode);
  }
  for (const mode of ['unsafe', '', null, 1]) assert.throws(() => worker({ ...document().workers.work, mode }), /invalid_graph_choice/);
});

test('snapshot import keeps worker sandbox mode', t => {
  const { graph, dir } = fixture(t); const { readAgentImport, commitAgentImport } = require('../out/backend/agentGraphImport');
  const root = path.join(dir, 'source'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'stock.goal.json'), JSON.stringify({ company: 'inventory', goal: 'stock', ...document().goal }));
  fs.writeFileSync(path.join(root, 'work.json'), JSON.stringify({ company: 'inventory', goal: 'stock', key: 'work', ...document().workers.work, mode: 'plan' }));
  const candidate = readAgentImport({ root, company: 'inventory', goal: 'stock' });
  assert.equal(candidate.data.workers.work.mode, 'plan');
  commitAgentImport(graph, candidate, () => false);
  assert.equal(graph.readScope('inventory', 'stock').data.workers.work.mode, 'plan');
});
test('S2-I1 actual checkpoint locks reject live/unreadable flat and nested sources and are rechecked', t => {
  const { graph, dir } = fixture(t); const { readAgentImport, commitAgentImport } = require('../out/backend/agentGraphImport');
  for (const nested of [false, true]) {
    const root = path.join(dir, nested ? 'nested' : 'flat'); fs.mkdirSync(root); const folder = nested ? path.join(root, 'stock') : root; if (nested) fs.mkdirSync(folder);
    fs.writeFileSync(path.join(root, 'stock.goal.json'), JSON.stringify({ company: 'inventory', goal: 'stock', ...document().goal }));
    fs.writeFileSync(path.join(folder, 'work.json'), JSON.stringify({ company: 'inventory', goal: 'stock', key: 'work', ...document().workers.work, sessionId: 'a' }));
    const options = { root, company: 'inventory', goal: 'stock' }, lock = path.join(folder, 'work.json.turn.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid })); assert.throws(() => readAgentImport(options), /lock/); fs.unlinkSync(lock);
    fs.writeFileSync(lock, '{}'); const open = fs.openSync;
    fs.openSync = function(file, ...args) { if (file === lock) throw Object.assign(Error('unreadable'), { code: 'EACCES' }); return open.call(this, file, ...args); };
    try { assert.throws(() => readAgentImport(options), /lock/); } finally { fs.openSync = open; fs.unlinkSync(lock); }
    fs.writeFileSync(lock, '{}'); assert.throws(() => readAgentImport(options), /lock/); fs.unlinkSync(lock);
    const candidate = readAgentImport(options);
    assert.throws(() => commitAgentImport(graph, candidate, () => { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid })); return false; }), /lock|changed/);
    assert.equal(graph.snapshot().scopes.length, 0);
    fs.unlinkSync(lock); const content = JSON.stringify({ pid: 734343 }); fs.writeFileSync(lock, content); const kill = process.kill;
    process.kill = function(pid, signal) { if (pid === 734343 && signal === 0) throw Object.assign(Error('gone'), { code: 'ESRCH' }); return kill.call(this, pid, signal); };
    try { readAgentImport(options); assert.equal(fs.readFileSync(lock, 'utf8'), content); } finally { process.kill = kill; }
  }
});
test('S2-I2 legitimate reserved-word worker keys are preserved rather than silently excluded', t => {
  const { dir } = fixture(t); const { readAgentImport } = require('../out/backend/agentGraphImport'); const root = path.join(dir, 'source'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'stock.goal.json'), JSON.stringify({ company: 'inventory', goal: 'stock', ...document().goal }));
  const keys = ['auth-work', 'response-review', 'daemon-work'];
  for (const key of keys) fs.writeFileSync(path.join(root, key + '.json'), JSON.stringify({ company: 'inventory', goal: 'stock', key, ...document().workers.work }));
  assert.deepEqual(Object.keys(readAgentImport({ root, company: 'inventory', goal: 'stock' }).data.workers).sort(), keys.sort());
});
test('S2-I2 ambiguous incomplete worker source cannot gain ownership', t => {
  const { graph, dir } = fixture(t); const { readAgentImport, commitAgentImport } = require('../out/backend/agentGraphImport'); const root = path.join(dir, 'source'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'stock.goal.json'), JSON.stringify({ company: 'inventory', goal: 'stock', ...document().goal }));
  fs.writeFileSync(path.join(root, 'auth-work.json'), '{}');
  assert.throws(() => commitAgentImport(graph, readAgentImport({ root, company: 'inventory', goal: 'stock' }), () => false), /mapping|ambiguous/);
  assert.equal(graph.snapshot().scopes.length, 0);
});
test('graph persists canonical peers, multiple parents, union DAG and transactional rollback', t => {
  const { graph, file, AgentGraph } = fixture(t); graph.putNodes(['a', 'b', 'c'].map(id => node(id)));
  const peer = graph.link('b', 'a', 'peer'); assert.equal(graph.link('a', 'b', 'peer').id, peer.id);
  graph.link('a', 'c', 'delegates'); graph.link('b', 'c', 'reviews');
  const before = graph.snapshot(); assert.throws(() => graph.link('c', 'a', 'reviews'), /cycle/);
  assert.deepEqual(graph.snapshot(), before); assert.throws(() => graph.link('a', 'a', 'peer'), /self/);
  graph.unlink('a', 'c', 'reviews'); assert.equal(graph.snapshot().edges.length, 3);
  graph.unlink('a', 'c', 'delegates'); assert.equal(graph.snapshot().edges.length, 2);
  assert.deepEqual(new AgentGraph(file).snapshot(), graph.snapshot());
  assert.throws(() => graph.putNodes([node('d'), { ...node('a'), role: 'review' }]), /conflict/);
  assert.equal(graph.snapshot().nodes.some(n => n.id === 'd'), false);
});
for (const stopped of [true, false]) {
  test(`worker registration preserves the parent's stored userStopped=${stopped}`, t => {
    const { graph } = fixture(t);
    const parent = { ...node('supervisor', 'coordinator'), goal: 'previous-stock' };
    const child = node('inventory-worker');
    graph.putNodes([parent]);
    graph.setUserStopped(parent.id, true);
    graph.setUserStopped(parent.id, stopped);

    const scope = graph.updateScope(child.company, child.goal, document(), 0);
    const storedParent = graph.snapshot().nodes.find(entry => entry.id === parent.id);
    assert.equal(storedParent.userStopped, stopped);
    assert.throws(() => graph.putNodes([storedParent]), /invalid_graph_field/);
    assert.throws(() => graph.bindWorker(child.company, child.goal, 'work',
      { ...storedParent, goal: child.goal }, child, scope.revision), /graph_node_conflict/);

    const bound = graph.bindWorker(child.company, child.goal, 'work', storedParent, child, scope.revision);
    assert.equal(bound.revision, scope.revision + 1);
    assert.equal(bound.data.workers.work.sessionId, child.id);
    const saved = graph.snapshot();
    assert.deepEqual(saved.nodes.find(entry => entry.id === parent.id), storedParent);
    assert.deepEqual(saved.edges.map(({ from, to, kind }) => ({ from, to, kind })),
      [{ from: parent.id, to: child.id, kind: 'delegates' }]);
  });
}
test('scope metadata roundtrip, CAS, profile/review/worker invariants and durable deletion authority', t => {
  const { graph, file, AgentGraph } = fixture(t), data = document();
  const saved = graph.updateScope('inventory', 'stock', data, 0); assert.equal(saved.revision, 1);
  assert.deepEqual(new AgentGraph(file).readScope('inventory', 'stock').data, data);
  assert.throws(() => graph.updateScope('inventory', 'stock', data, 0), /revision/);
  assert.throws(() => graph.updateScope('inventory', 'stock', { ...data, reviewCycles: [{ deliverable: 'report', count: 4 }] }, 1), /invalid/);
  assert.throws(() => graph.updateScope('inventory', 'stock', { ...data, goal: { ...data.goal, profile: 'important' } }, 1), /profile/);
  const gone = graph.updateScope('inventory', 'stock', null, 1); assert.equal(gone.owned, true); assert.equal(gone.data, null);
  assert.equal(new AgentGraph(file).readScope('inventory', 'stock').owned, true);
});
test('snapshot importer is explicit, validated, transactional and receipt-idempotent after deletion', t => {
  const { graph, dir } = fixture(t); const { readAgentImport, commitAgentImport } = require('../out/backend/agentGraphImport');
  const root = path.join(dir, 'source'); fs.mkdirSync(root);
  const data = document(); fs.writeFileSync(path.join(root, 'stock.goal.json'), JSON.stringify({ company: 'inventory', goal: 'stock', ...data.goal, reviewCycles: data.reviewCycles }));
  fs.mkdirSync(path.join(root, 'stock')); fs.writeFileSync(path.join(root, 'stock/work.json'), JSON.stringify({ company: 'inventory', goal: 'stock', key: 'work', ...data.workers.work, sessionId: 'a' }));
  const options = { root, company: 'inventory', goal: 'stock' }, candidate = readAgentImport(options);
  assert.throws(() => commitAgentImport(graph, candidate, () => true), /active/); assert.equal(graph.snapshot().nodes.length, 0);
  assert.equal(commitAgentImport(graph, candidate, () => false).alreadyImported, false);
  const saved = graph.readScope('inventory', 'stock'); graph.updateScope('inventory', 'stock', null, saved.revision);
  assert.equal(commitAgentImport(graph, candidate, () => false).alreadyImported, true);
  assert.equal(graph.readScope('inventory', 'stock').data, null);
  fs.appendFileSync(path.join(root, 'stock.goal.json'), ' ');
  assert.throws(() => commitAgentImport(graph, readAgentImport(options), () => false), /owned/);
});
test('import rejects locks, conflicting duplicates, changed snapshots and escapes without source mutation', t => {
  const { graph, dir } = fixture(t); const { readAgentImport, commitAgentImport } = require('../out/backend/agentGraphImport');
  const root = path.join(dir, 'source'); fs.mkdirSync(root); const file = path.join(root, 'stock.goal.json');
  fs.writeFileSync(file, JSON.stringify({ company: 'inventory', goal: 'stock', ...document().goal }));
  const options = { root, company: 'inventory', goal: 'stock' }, old = readAgentImport(options);
  fs.writeFileSync(file, JSON.stringify({ company: 'inventory', goal: 'stock', ...document().goal, title: 'Changed' }));
  assert.throws(() => commitAgentImport(graph, old, () => false), /changed/); assert.equal(graph.snapshot().scopes.length, 0);
  fs.mkdirSync(path.join(root, 'stock')); fs.writeFileSync(path.join(root, 'stock/stock.goal.json'), JSON.stringify({ company: 'inventory', goal: 'stock', ...document().goal }));
  assert.throws(() => readAgentImport(options), /conflict/); fs.unlinkSync(path.join(root, 'stock/stock.goal.json'));
  fs.writeFileSync(path.join(root, 'stock/work.turn.lock'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => readAgentImport(options), /lock/); assert.equal(fs.existsSync(file), true);
});
test('an import candidate cannot substitute metadata after its source fingerprint was checked', t => {
  const { graph, dir } = fixture(t); const { readAgentImport, commitAgentImport } = require('../out/backend/agentGraphImport');
  const root = path.join(dir, 'source'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'stock.goal.json'), JSON.stringify({ company: 'inventory', goal: 'stock', ...document().goal }));
  const candidate = readAgentImport({ root, company: 'inventory', goal: 'stock' }); candidate.data.goal.title = 'Substituted';
  commitAgentImport(graph, candidate, () => false);
  assert.equal(graph.readScope('inventory', 'stock').data.goal.title, 'Inventory');
});
test('three-node mixed cycles and referenced-node deletion are transactional', t => {
  const { graph } = fixture(t); graph.putNodes(['a', 'b', 'c'].map(id => node(id)));
  graph.link('a', 'b', 'delegates'); graph.link('b', 'c', 'reviews'); const before = graph.snapshot();
  assert.throws(() => graph.link('c', 'a', 'delegates'), /cycle/); assert.deepEqual(graph.snapshot(), before);
  const data = document(); data.workers.work.sessionId = 'c'; graph.updateScope('inventory', 'stock', data, 0);
  assert.throws(() => graph.removeNode('c'), /referenced/); graph.removeNode('b');
  assert.equal(graph.snapshot().edges.length, 0); assert.equal(graph.snapshot().nodes.length, 2);
});
test('configuration metadata and immutable worker keys survive reopen and concurrent CAS', t => {
  const { graph, file, AgentGraph } = fixture(t); graph.putNodes([node('a')]); const data = document(); data.workers.work.sessionId = 'a';
  data.coordinatorConfiguration = { operationId: 'selection', sourceTurnId: 'source', activeTurnId: 'active', sessionId: 'supervisor', status: 'queued',
    selection: { providerId: 'claude', model: '', effort: 'high', thinking: true }, profileRevision: 1, verifiedAt: 3 };
  graph.updateScope('inventory', 'stock', data, 0); const concurrent = new AgentGraph(file);
  assert.deepEqual(concurrent.readScope('inventory', 'stock').data, data);
  const next = JSON.parse(JSON.stringify(data)); next.goal.profile = 'important'; next.goal.profileRevision = 2;
  graph.updateScope('inventory', 'stock', next, 1); assert.throws(() => concurrent.updateScope('inventory', 'stock', next, 1), /revision/);
  const changed = JSON.parse(JSON.stringify(next)); changed.workers.work.role = 'review'; assert.throws(() => graph.updateScope('inventory', 'stock', changed, 2), /worker_conflict/);
  const duplicate = JSON.parse(JSON.stringify(next)); duplicate.workers.second = duplicate.workers.work; assert.throws(() => graph.updateScope('inventory', 'stock', duplicate, 2), /duplicate_session/);
  const membership = JSON.parse(JSON.stringify(data)); graph.updateScope('inventory', 'other', membership, 0);
  assert.equal(graph.snapshot().scopes.filter(s => s.data.workers.work).length, 2, 'same key across goals remains explicit and ambiguous to an unscoped consumer');
});
test('import allowlists exclude auxiliary files, source symlinks/oversize and unverifiable locks reject', t => {
  const { graph, dir } = fixture(t); const { readAgentImport, commitAgentImport } = require('../out/backend/agentGraphImport');
  const root = path.join(dir, 'source'); fs.mkdirSync(root); const file = path.join(root, 'stock.goal.json');
  const goal = { company: 'inventory', goal: 'stock', ...document().goal, coordinatorConfiguration: { operationId: 'selection', status: 'queued', continuation: '' } };
  fs.writeFileSync(file, JSON.stringify(goal)); fs.writeFileSync(path.join(root, 'work.log'), ''); fs.writeFileSync(path.join(root, 'work.prompt.txt'), '');
  fs.mkdirSync(path.join(root, 'stock')); const lock = path.join(root, 'stock/work.turn.lock'); fs.writeFileSync(lock, '{}');
  const options = { root, company: 'inventory', goal: 'stock' }; assert.throws(() => readAgentImport(options), /lock/); fs.unlinkSync(lock);
  const candidate = readAgentImport(options); assert.equal('continuation' in candidate.data.coordinatorConfiguration, false);
  commitAgentImport(graph, candidate, () => false); assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(goal));
  fs.writeFileSync(path.join(root, 'large.json'), ' '.repeat(65537)); assert.throws(() => readAgentImport(options), /limit/);
  fs.unlinkSync(path.join(root, 'large.json')); fs.rmdirSync(path.join(root, 'stock'));
  const outside = path.join(dir, 'outside'); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(root, 'stock'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readAgentImport(options), /containment/);
});
test('final import recheck follows target activity validation', t => {
  const { graph, dir } = fixture(t); const { readAgentImport, commitAgentImport } = require('../out/backend/agentGraphImport');
  const root = path.join(dir, 'source'); fs.mkdirSync(root); const file = path.join(root, 'stock.goal.json');
  fs.writeFileSync(file, JSON.stringify({ company: 'inventory', goal: 'stock', ...document().goal }));
  fs.writeFileSync(path.join(root, 'work.json'), JSON.stringify({ company: 'inventory', goal: 'stock', key: 'work', ...document().workers.work, sessionId: 'a' }));
  const candidate = readAgentImport({ root, company: 'inventory', goal: 'stock' });
  assert.throws(() => commitAgentImport(graph, candidate, () => { fs.appendFileSync(file, ' '); return false; }), /changed/);
  assert.equal(graph.snapshot().scopes.length, 0);
});
test('Windows workspace spelling does not turn an idempotent node into a conflicting identity', t => {
  const { graph } = fixture(t); graph.putNodes([node('a')]);
  graph.putNodes([{ ...node('a'), workspace: 'd:\\INVENTORY' }]); assert.equal(graph.snapshot().nodes.length, 1);
});
test('ambiguous exact auxiliary JSON is not read or silently used to claim ownership', t => {
  const { dir } = fixture(t); const { readAgentImport } = require('../out/backend/agentGraphImport'); const root = path.join(dir, 'source'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'stock.goal.json'), JSON.stringify({ company: 'inventory', goal: 'stock', ...document().goal }));
  fs.writeFileSync(path.join(root, 'auth.json'), ''); fs.writeFileSync(path.join(root, 'token.json'), '');
  const open = fs.openSync; fs.openSync = function(file, ...args) { if (['auth.json', 'token.json'].includes(path.basename(file))) assert.fail('auxiliary contents read'); return open.call(this, file, ...args); };
  try { assert.throws(() => readAgentImport({ root, company: 'inventory', goal: 'stock' }), /ambiguous/); } finally { fs.openSync = open; }
});
test('a definitely dead lock is tolerated without deletion or modification', t => {
  const { graph, dir } = fixture(t); const { readAgentImport, commitAgentImport } = require('../out/backend/agentGraphImport'); const root = path.join(dir, 'source'); fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'stock'));
  fs.writeFileSync(path.join(root, 'stock.goal.json'), JSON.stringify({ company: 'inventory', goal: 'stock', ...document().goal }));
  const file = path.join(root, 'stock/work.turn.lock'), bytes = JSON.stringify({ pid: 734343 }); fs.writeFileSync(file, bytes);
  const kill = process.kill; process.kill = function(pid, signal) { if (pid === 734343 && signal === 0) throw Object.assign(Error('gone'), { code: 'ESRCH' }); return kill.call(this, pid, signal); };
  try { commitAgentImport(graph, readAgentImport({ root, company: 'inventory', goal: 'stock' }), () => false); assert.equal(fs.readFileSync(file, 'utf8'), bytes); }
  finally { process.kill = kill; }
});
