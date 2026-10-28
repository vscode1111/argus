const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel');

test('a panel reopening another live conversation reconnects to the one it displayed', () => {
  const workspace = 'D:/session-stop-isolation';
  const channel = getOrCreateChannel(workspace);
  const socket = () => ({ readyState: 1, send() {} });
  const first = socket();
  const second = socket();
  const reconnected = socket();
  try {
    channel.addClient(first, false, undefined, 'first-panel');
    channel.addClient(second, false, undefined, 'second-panel');
    const firstState = channel.getClientState(first);
    const secondState = channel.getClientState(second);
    firstState.sessionId = 'first-conversation';
    secondState.sessionId = 'second-conversation';
    firstState.runtime = { active: true };
    secondState.runtime = { active: true };

    assert.equal(channel.attachToLiveSession(first, secondState.sessionId, true), secondState);
    channel.removeClient(first);
    channel.addClient(reconnected, false, undefined, 'first-panel');
    assert.equal(channel.getClientState(reconnected).sessionId, secondState.sessionId);
    assert.equal(firstState.runtime.active, true);
    assert.equal(secondState.runtime.active, true);
    firstState.runtime = undefined;
    secondState.runtime = undefined;
  } finally {
    channel.removeClient(second);
    channel.removeClient(reconnected);
    destroyChannel(workspace);
  }
});
