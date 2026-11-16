const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { privateQuestionServer } = require('./fixtures/private-question-server.cjs');
const document = () => ({ version: 1, goal: { title: 'Inventory', status: 'active', profile: 'normal', profileRevision: 1, createdAt: 1, updatedAt: 1 }, reviewCycles: [], workers: {} });
test('scope commands persist metadata without controller files and retain deletion ownership', async t => {
  const server = await privateQuestionServer(); t.after(() => server.close()); const client = await server.connect();
  client.send({ type: 'updateAgentScope', requestId: 'create', company: 'inventory', goal: 'stock', expectedRevision: 0, data: document() });
  const created = await client.wait(f => f.requestId === 'create'); assert.equal(created.ok, true); assert.equal(created.scope.revision, 1);
  client.send({ type: 'getOrchestratorGoals' });
  assert.ok((await client.wait(f => f.type === 'orchestratorGoals')).goals.some(g => g.company === 'inventory' && g.goal === 'stock'), 'graph scope remains visible in existing goals projection');
  client.send({ type: 'updateAgentScope', requestId: 'delete', company: 'inventory', goal: 'stock', expectedRevision: 1, data: null });
  assert.equal((await client.wait(f => f.requestId === 'delete')).ok, true);
  client.send({ type: 'getAgentScope', requestId: 'read', company: 'inventory', goal: 'stock' });
  const scope = (await client.wait(f => f.requestId === 'read')).scope; assert.equal(scope.owned, true); assert.equal(scope.data, null);
});
test('invalid token cannot trigger existing force-error effects', async t => {
  const server = await privateQuestionServer({ providerPreload: path.join(__dirname, 'fixtures/delivery-spawn.cjs') }); t.after(() => server.close()); const client = await server.connect();
  client.send({ type: 'send', text: 'Hold inventory' }); await client.wait(f => f.type === 'sessionId'); client.frames.length = 0;
  client.send({ type: 'forceError', requestId: 'refuse', agentToken: 'invalid' });
  const reply = await client.wait(f => f.type === 'providerNotice' || f.type === 'error');
  assert.equal(reply.type, 'providerNotice'); assert.equal(reply.code, 'agent_forbidden');
  client.send({ type: 'getSessionControl', requestId: 'control' }); assert.equal((await client.wait(f => f.requestId === 'control')).active, true);
});

test('graph observation inspects an unlinked UI-started session without attaching the observer', async t => {
  const server = await privateQuestionServer({ providerPreload: path.join(__dirname, 'fixtures/delivery-spawn.cjs') }); t.after(() => server.close());
  const ui = await server.connect(), observer = await server.connect();
  ui.send({ type: 'send', text: 'Hold inventory' }); const id = (await ui.wait(f => f.type === 'sessionId')).id;
  observer.send({ type: 'getAgentGraph', requestId: 'inspect', sessionId: id, agentToken: 'not-required-for-observation' });
  const reply = await observer.wait(f => f.requestId === 'inspect');
  assert.equal(reply.observation?.sessionId, id); assert.equal(reply.observation?.status, 'running'); assert.equal(reply.snapshot.nodes.length, 0);
  observer.send({ type: 'getSessionControl', requestId: 'observer' }); assert.equal((await observer.wait(f => f.requestId === 'observer')).sessionId, undefined);
  observer.send({ type: 'getAgentGraph', requestId: 'missing', sessionId: 'missing-inventory' });
  assert.equal((await observer.wait(f => f.requestId === 'missing')).observation.live, false);
});

test('final socket reserves, configures and atomically binds a genuinely new worker', async t => {
  const server = await privateQuestionServer({ providerPreload: path.join(__dirname, 'fixtures/delivery-spawn.cjs') }); t.after(() => server.close());
  const client = await server.connect(); const scope = document();
  client.send({ type: 'updateAgentScope', requestId: 'goal', company: 'inventory', goal: 'stock', expectedRevision: 0, data: scope }); await client.wait(f => f.requestId === 'goal');
  const binding = { role: 'work', providerId: 'claude', workspace: server.dir, title: 'Inventory worker', profile: 'normal', model: '', effort: '', sessionId: null };
  client.send({ type: 'reserveAgentTurn', requestId: 'reserve', company: 'inventory', goal: 'stock', key: 'worker', fresh: true, worker: binding }); assert.equal((await client.wait(f => f.requestId === 'reserve')).ok, true);
  client.send({ type: 'configureSession', requestId: 'configure', providerId: 'claude', model: '', effort: '' }); await client.wait(f => f.requestId === 'configure');
  client.send({ type: 'linkAgents', requestId: 'register', parent: 'parent', parentProviderId: 'claude', child: null, company: 'inventory', goal: 'stock', key: 'worker', expectedRevision: 1, worker: binding });
  assert.equal((await client.wait(f => f.requestId === 'register')).pending, true);
  client.send({ type: 'send', text: 'Prepare inventory' }); const registered = await client.wait(f => f.type === 'agentRegistration'); assert.equal(registered.ok, true);
  client.send({ type: 'getAgentGraph', requestId: 'graph', company: 'inventory', goal: 'stock' }); const graph = await client.wait(f => f.requestId === 'graph');
  assert.ok(JSON.stringify(graph).includes(registered.sessionId)); server.verifySpawn();
  await client.wait(f => f.type === 'done');
  client.send({ type: 'getAgentGraph', requestId: 'settled-exchange', company: 'inventory', goal: 'stock' });
  const settled = (await client.wait(f => f.requestId === 'settled-exchange')).snapshot;
  assert.equal(settled.edges[0].forward.awaitingReply, false, 'terminal response settles admitted parent exchange');
  const next = await server.connect(server.dir, registered.sessionId);
  next.send({ type: 'reserveAgentTurn', requestId: 'settled-reserve', company: 'inventory', goal: 'stock', key: 'worker' });
  assert.equal((await next.wait(f => f.requestId === 'settled-reserve')).ok, true, 'settlement releases reservation while old socket remains open');
});
for (const providerId of ['claude', 'codex']) test('registered ' + providerId + ' headless question survives command socket close', async t => {
  const server = await privateQuestionServer({ providerPreload: path.join(__dirname, 'fixtures/delivery-spawn.cjs') }); t.after(() => server.close());
  const client = await server.connect(), observer = await server.connect();
  const binding = { role: 'work', providerId, workspace: server.dir, title: 'Inventory', profile: 'normal', model: providerId === 'codex' ? 'inventory-model' : '', effort: '', sessionId: null };
  client.send({ type: 'updateAgentScope', requestId: 'goal', company: 'inventory', goal: 'stock', expectedRevision: 0, data: document() }); await client.wait(f => f.requestId === 'goal');
  client.send({ type: 'reserveAgentTurn', requestId: 'reserve', company: 'inventory', goal: 'stock', key: 'work', fresh: true, worker: binding }); await client.wait(f => f.requestId === 'reserve');
  client.send({ type: 'configureSession', requestId: 'configure', providerId, model: binding.model, effort: '' }); await client.wait(f => f.requestId === 'configure');
  client.send({ type: 'linkAgents', requestId: 'register', parent: 'parent', parentProviderId: 'claude', child: null, company: 'inventory', goal: 'stock', key: 'work', expectedRevision: 1, worker: binding }); await client.wait(f => f.requestId === 'register');
  client.send({ type: 'send', text: providerId === 'codex' ? 'Hold inventory' : 'Choose inventory' }); const registered = await client.wait(f => f.type === 'agentRegistration');
  if (providerId === 'codex') client.send({ type: 'steer', text: 'Choose inventory' });
  await client.wait(f => f.type === 'interaction' && f.request);
  if (providerId === 'codex') await client.wait(f => f.type === 'done');
  client.ws.close(); await new Promise(r => setTimeout(r, 350));
  observer.send({ type: 'getAgentGraph', requestId: 'observe', company: 'inventory', goal: 'stock' });
  const graph = (await observer.wait(f => f.requestId === 'observe')).snapshot;
  assert.equal(graph.nodes.find(n => n.id === registered.sessionId).status, 'needs-input');
});
