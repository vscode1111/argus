const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel');
const { sendCachedEarlierPage } = require('../out/backend/sessionPages');

test('large active replies open at the tail, retain earlier blocks and continue streaming', () => {
  const cwd = `large-replay-${randomUUID()}`;
  const frames = [];
  const socket = { readyState: 1, send: raw => frames.push(JSON.parse(raw)) };
  try {
    const channel = getOrCreateChannel(cwd);
    channel.addClient(socket, true);
    const state = channel.getClientState(socket);
    state.sessionId = randomUUID();
    state.currentProc = {};
    state.cliDone = false;
    state.broadcast(JSON.stringify({ type: 'message', message: { id: 'request', role: 'user', content: 'Inspect records' } }));
    state.broadcast(JSON.stringify({ type: 'thinking_start' }));
    for (let i = 0; i < 800; i++) {
      state.broadcast(JSON.stringify({ type: 'text_chunk', text: `Progress ${i}` }));
      state.broadcast(JSON.stringify({ type: 'tool_start', call: { id: `check-${i}`, name: 'Inspect', input: {} } }));
      state.broadcast(JSON.stringify({ type: 'tool_end', call: { id: `check-${i}`, result: 'Complete' } }));
    }
    frames.length = 0;
    channel.replayHistory(socket);
    assert.equal(frames[0].type, 'replay_start');
    assert.equal(frames.at(-1).type, 'replay_end');
    const chunks = frames.filter(frame => frame.type === 'text_chunk');
    assert(chunks.length <= 75, `Expected recent tail, received ${chunks.length} text chunks`);
    assert.equal(chunks.at(-1).text, 'Progress 799');
    const loaded = frames.find(frame => frame.type === 'sessionLoaded');
    assert.equal(loaded.hasMore, true);
    let before = loaded.before;
    const older = [];
    while (before) {
      assert(sendCachedEarlierPage(socket, state.sessionId, before, 1));
      const page = frames.at(-1);
      older.unshift(...page.messages);
      before = page.before;
    }
    const texts = older.flatMap(message => message.blocks || []).filter(block => block.type === 'text').map(block => block.text);
    assert.deepEqual([...texts, ...chunks.map(frame => frame.text)], Array.from({ length: 800 }, (_, i) => `Progress ${i}`));
    state.broadcast(JSON.stringify({ type: 'text_chunk', text: 'New progress' }));
    assert.equal(frames.at(-1).text, 'New progress');
  } finally { destroyChannel(cwd); }
});
