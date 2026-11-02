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
