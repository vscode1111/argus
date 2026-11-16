const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { privateQuestionServer } = require('./fixtures/private-question-server.cjs');
test('private UI-started live/replay questions and autonomous work are observed across workspaces without replay duplication', { timeout: 15000 }, async t => {
  const server = await privateQuestionServer(); t.after(() => server.close());
  const producer = await server.connect(server.dir, undefined, 'inventory-panel'), observer = await server.connect(path.join(server.dir, 'observer'));
  producer.send({ type: 'webviewReady' }); producer.send({ type: 'send', text: 'Check inventory.' });
  const pending = await producer.wait(f => f.type === 'interaction' && f.request);
  const sessionId = (await producer.wait(f => f.type === 'sessionId')).id;
  assert.equal(pending.request.sourceToolId, pending.request.id);
  assert.equal(pending.request.questions[0].multiSelect, true);
  async function watch(extra = {}) {
    const requestId = randomUUID(); observer.send({ type: 'watchSession', requestId, sessionId, ...extra });
    return observer.wait(f => f.type === 'sessionEvents' && f.requestId === requestId);
  }
  const before = await watch(); assert.equal(before.ok, true);
  assert.equal(before.events.filter(e => e.kind === 'interaction').length, 1);
  const replay = await server.connect(server.dir, undefined, 'inventory-panel'); replay.send({ type: 'webviewReady' });
  const rejoined = await replay.wait(f => f.type === 'interaction' && f.request);
  assert.deepEqual(rejoined.request, pending.request);
  assert.equal(replay.frames.filter(f => f.type === 'tool_start' && f.call.id === pending.request.id).length, 1);
  assert.deepEqual((await watch()).events, before.events, 'replay itself is not a producer');
  replay.send({ type: 'providerResponse', requestId: 'answer', id: pending.request.id,
    response: { answers: { [pending.request.questions[0].id]: ['Search', 'Sort'] } } });
  await replay.wait(f => f.type === 'providerResponseAccepted'); await replay.wait(f => f.type === 'done');
  await producer.wait(f => f.type === 'text_chunk' && f.text === 'Background inventory complete.');
  const after = await watch({ full: true });
  assert.equal(after.events.filter(e => e.kind === 'interaction-resolved' && e.data.reason === 'answered').length, 1);
  assert.equal(after.events.filter(e => e.kind === 'start').length, 2, 'autonomous turn has its own start');
  assert.equal(after.events.filter(e => e.kind === 'end').length, 2);
  observer.send({ type: 'getSessionControl', requestId: 'observer' });
  assert.equal((await observer.wait(f => f.type === 'sessionControl' && f.requestId === 'observer')).sessionId, undefined);
  producer.frames.length = 0; producer.send({ type: 'send', text: 'Check inventory again.' });
  const next = await producer.wait(f => f.type === 'interaction' && f.request);
  producer.send({ type: 'toolAnswer', id: next.request.id, answers: { 'Choose features': 'Search' } });
  await producer.wait(f => f.type === 'done'); server.verifySpawn();
  const invalid = await watch({ since: { seq: -1 } }); assert.equal(invalid.error.code, 'invalid_cursor');
  producer.ws.close(); replay.ws.close(); await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await watch()).ok, true, 'retention survives entry cleanup');
});
