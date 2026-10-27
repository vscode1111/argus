const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel');

test('a joining client receives the image in a streaming request', () => {
  const workspace = 'D:/workspace/image-replay';
  const frames = [];
  const owner = { readyState: 1, send() {} };
  const viewer = { readyState: 1, send(frame) { frames.push(JSON.parse(frame)); } };
  const image = { mediaType: 'image/png', data: 'cGl4ZWw=' };
  try {
    const channel = getOrCreateChannel(workspace);
    channel.addClient(owner, true);
    const state = channel.getClientState(owner);
    state.runtime = { active: true };
    state.broadcast(JSON.stringify({ type: 'thinking_start' }));
    state.broadcast(JSON.stringify({ type: 'user_inject', text: 'Inspect this diagram', images: [image] }));
    channel.addClient(viewer);
    assert.deepEqual(frames.find(frame => frame.type === 'user_inject'), {
      type: 'user_inject', text: 'Inspect this diagram', images: [image],
    });
  } finally {
    destroyChannel(workspace);
  }
});
