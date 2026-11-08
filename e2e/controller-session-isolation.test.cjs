const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel');
const { attachClientHandlers } = require('../out/backend/session');

function socket() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = () => {};
  return ws;
}

for (const active of [true, false]) {
  test(`cold controller connection preserves a ${active ? 'running' : 'finished'} conversation`, () => {
    const dir = `D:/sessions/${randomUUID()}`;
    const channel = getOrCreateChannel(dir);
    const panel = socket(), controller = socket(), reconnect = socket();
    let disposals = 0;
    try {
      attachClientHandlers(panel, channel, 'default', { panelId: 'coordinator-panel' });
      const state = channel.getClientState(panel);
      const currentId = `codex:${randomUUID()}`;
      const requestedId = `codex:${randomUUID()}`;
      state.sessionId = currentId;
      state.cliDone = !active;
      state.runtime = { active, dispose() { disposals++; } };
      attachClientHandlers(controller, channel, 'default', { sessionId: requestedId });
      assert.equal(disposals, 0, 'connecting must not dispose another conversation');
      assert.equal(state.sessionId, currentId);
      const target = channel.getClientState(controller);
      assert.notEqual(target, state);
      assert.equal(target.sessionId, requestedId);
      attachClientHandlers(reconnect, channel, 'default', { sessionId: requestedId });
      assert.equal(channel.getClientState(reconnect), target, 'existing target must be reused');
      assert.equal(disposals, 0);
    } finally {
      panel.emit('close'); controller.emit('close'); reconnect.emit('close'); destroyChannel(dir);
    }
  });
}

for (const active of [true, false]) {
  test(`history selection reuses a ${active ? 'running' : 'finished'} conversation runtime`, async () => {
    const dir = `D:/sessions/${randomUUID()}`;
    const channel = getOrCreateChannel(dir);
    const owner = socket(), viewer = socket();
    let sends = 0;
    try {
      attachClientHandlers(owner, channel, 'default', { panelId: 'owner-panel' });
      const original = channel.getClientState(owner);
      const id = `codex:${randomUUID()}`;
      original.sessionId = id;
      original.cliDone = !active;
      original.runtime = { active, async send() { sends++; }, dispose() {} };
      attachClientHandlers(viewer, channel, 'default', { panelId: 'viewer-panel' });
      assert.equal(channel.attachToLiveSession(viewer, id, true), original);
      viewer.emit('message', Buffer.from(JSON.stringify({ type: 'send', text: 'Check the inventory totals.' })));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(sends, 1, 'follow-up must use the existing provider runtime');
      assert.equal(channel.getClientState(viewer), original);
    } finally {
      owner.emit('close'); viewer.emit('close'); destroyChannel(dir);
    }
  });
}

test('a browsed send rejoins the finished target without replacing either runtime', async () => {
  const dir = `D:/sessions/${randomUUID()}`;
  const channel = getOrCreateChannel(dir);
  const owner = socket(), viewer = socket();
  let sends = 0;
  let disposals = 0;
  try {
    attachClientHandlers(owner, channel, 'default', { panelId: 'target-panel' });
    const target = channel.getClientState(owner);
    const targetId = `codex:${randomUUID()}`;
    target.sessionId = targetId;
    target.cliDone = true;
    target.runtime = { active: false, async send() { sends++; }, dispose() { disposals++; } };
    attachClientHandlers(viewer, channel, 'default', { panelId: 'source-panel' });
    const source = channel.getClientState(viewer);
    const sourceId = `codex:${randomUUID()}`;
    source.sessionId = sourceId;
    source.runtime = { active: true, dispose() { disposals++; } };
    channel.setBrowsing(viewer, true, targetId);
    viewer.emit('message', Buffer.from(JSON.stringify({ type: 'send', text: 'Review the warehouse balance.' })));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(channel.getClientState(viewer), target, 'browsed target already owns its native writer');
    assert.equal(sends, 1);
    assert.equal(source.sessionId, sourceId);
    assert.equal(source.runtime.active, true);
    assert.equal(disposals, 0);
    assert.equal(channel.getViewingSessionId(viewer), undefined);
  } finally {
    owner.emit('close'); viewer.emit('close'); destroyChannel(dir);
  }
});
