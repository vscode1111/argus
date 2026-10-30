const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel');
const { attachClientHandlers } = require('../out/backend/session');
const { provider } = require('../out/backend/providers/registry');

test('session list uses the panel route after an in-flight request', async () => {
  const dir = `D:/sessions/${randomUUID()}`;
  const previousId = randomUUID();
  const currentId = randomUUID();
  const frames = [];
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = data => frames.push(JSON.parse(data));
  const channel = getOrCreateChannel(dir);
  const codex = provider('codex');
  const originalList = codex.list;
  let releaseList;
  let listStarted;
  const started = new Promise(resolve => { listStarted = resolve; });
  const waiting = new Promise(resolve => { releaseList = resolve; });
  codex.list = async () => {
    listStarted();
    await waiting;
    return [{ id: previousId, title: 'Previous review', updatedAt: 1 },
      { id: currentId, title: 'Current review', updatedAt: 2 }];
  };
  try {
    attachClientHandlers(socket, channel, 'default', { panelId: 'review-panel' });
    channel.getClientState(socket).sessionId = previousId;
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'listSessions' })));
    await started;
    channel.moveToNewSession(socket).sessionId = currentId;
    releaseList();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(channel.getClientState(socket).sessionId, currentId);
    assert.equal(frames.find(frame => frame.type === 'sessionList')?.currentId, currentId);
  } finally {
    releaseList();
    codex.list = originalList;
    socket.emit('close');
    destroyChannel(dir);
  }
});
