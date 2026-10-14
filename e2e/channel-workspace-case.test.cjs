const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel');

test('a live session replays its timer and usage across Windows path casing', () => {
  const workspace = path.join(process.cwd(), 'scub-live-workspace');
  const alternateCase = workspace.toLowerCase();
  const sessionId = 'codex:scub-live-session';
  const frames = [];
  const streamer = { readyState: 1, send() {} };
  const viewer = { readyState: 1, send(frame) { frames.push(JSON.parse(frame)); } };
  try {
    const owner = getOrCreateChannel(workspace);
    owner.addClient(streamer, true);
    const state = owner.getClientState(streamer);
    state.sessionId = sessionId;
    state.runtime = { active: true };
    state.broadcast(JSON.stringify({ type: 'thinking_start' }));
    state.broadcast(JSON.stringify({ type: 'contextUsage', percent: 48.8, inputTokens: 488, outputTokens: 10, contextWindow: 1000 }));

    const history = getOrCreateChannel(alternateCase);
    history.addClient(viewer, true);
    assert.ok(history.attachToLiveSession(viewer, sessionId), 'viewer must attach to the running entry');
    assert.equal(frames.filter(frame => frame.type === 'thinking_start').length, 1);
    assert.equal(frames.filter(frame => frame.type === 'contextUsage').length, 1);

    state.sessionId = 'codex:scub-next-session';
    state.broadcast(JSON.stringify({ type: 'thinking_start' }));
    const nextFrames = [];
    const nextViewer = { readyState: 1, send(frame) { nextFrames.push(JSON.parse(frame)); } };
    history.addClient(nextViewer, true);
    assert.ok(history.attachToLiveSession(nextViewer, state.sessionId));
    assert.equal(nextFrames.filter(frame => frame.type === 'thinking_start').length, 1);
    assert.equal(nextFrames.filter(frame => frame.type === 'contextUsage').length, 0, 'usage from the previous session must not replay');
  } finally {
    destroyChannel(workspace);
    destroyChannel(alternateCase);
  }
});
