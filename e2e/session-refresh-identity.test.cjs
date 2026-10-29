const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel');
const { attachClientHandlers } = require('../out/backend/session');

test('refresh cannot select a different conversation', async () => {
  const dir = `D:/sessions/${randomUUID()}`;
  const currentId = randomUUID();
  const otherId = randomUUID();
  const frames = [];
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = data => frames.push(JSON.parse(data));
  const channel = getOrCreateChannel(dir);
  try {
    attachClientHandlers(socket, channel, 'default', { panelId: 'current-panel' });
    channel.getClientState(socket).sessionId = currentId;
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'refreshSession', id: otherId })));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(channel.getClientState(socket).sessionId, currentId);
    assert.deepEqual(frames.find(frame => frame.type === 'sessionRefreshRejected'), {
      type: 'sessionRefreshRejected', requestedId: otherId, currentId,
    });
    assert.equal(frames.some(frame => frame.type === 'sessionLoaded' && frame.id === otherId), false);
  } finally {
    socket.emit('close');
    destroyChannel(dir);
  }
});
