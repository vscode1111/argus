const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel');
const { handleResumeSession } = require('../out/backend/session');

const socket = () => ({ readyState: 1, send() {} });

test('switching idle sessions does not replay the previous session after refresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-replay-'));
  const secondId = randomUUID();
  const projectDir = path.join(os.homedir(), '.claude', 'projects', path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-'));
  const transcript = path.join(projectDir, `${secondId}.jsonl`);
  const frames = [];
  const ws = { readyState: 1, send(data) { frames.push(JSON.parse(data)); } };
  const channel = getOrCreateChannel(dir);
  try {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(transcript, [
      { type: 'system', subtype: 'init', cwd: dir, session_id: secondId },
      { type: 'user', cwd: dir, message: { role: 'user', content: 'Inspect the second account' } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    channel.addClient(ws, false, undefined, 'panel-one');
    const first = channel.getClientState(ws);
    first.sessionId = randomUUID();
    first.sendLog = () => {};
    first.broadcast(JSON.stringify({ type: 'message', message: { id: 'first-turn', role: 'user', content: 'Inspect the first account' } }));
    await handleResumeSession(first, ws, channel, secondId);
    frames.length = 0;
    channel.replayHistory(ws, [{ id: 'second-turn', role: 'user', content: 'Inspect the second account' }]);
    const replay = frames.find(frame => frame.type === 'sessionLoaded');
    assert.deepEqual(replay?.messages.map(message => message.content), ['Inspect the second account']);
    assert.equal(replay.id, secondId);
  } finally {
    channel.removeClient(ws);
    destroyChannel(dir);
    if (fs.existsSync(transcript)) fs.unlinkSync(transcript);
    if (fs.existsSync(projectDir)) fs.rmdirSync(projectDir);
    fs.rmdirSync(dir);
  }
});

test('reconnecting while viewing another session keeps the viewed session', () => {
  const dir = path.join('D:/sessions', randomUUID());
  const channel = getOrCreateChannel(dir);
  const first = socket();
  const reconnected = socket();
  const viewedId = randomUUID();
  try {
    channel.addClient(first, false, undefined, 'panel-one');
    const state = channel.getClientState(first);
    state.sessionId = randomUUID();
    state.currentProc = {};
    state.cliDone = false;
    channel.setBrowsing(first, true, viewedId);
    channel.removeClient(first);
    channel.addClient(reconnected, false, undefined, 'panel-one');
    assert.equal(channel.getClientState(reconnected).sessionId, viewedId);
    state.currentProc = undefined;
  } finally {
    channel.removeClient(reconnected);
    destroyChannel(dir);
  }
});

test('a guest panel cannot change the owner panel reconnect target', () => {
  const dir = path.join('D:/sessions', randomUUID());
  const channel = getOrCreateChannel(dir);
  const owner = socket();
  const guest = socket();
  const ownerReconnected = socket();
  const guestReconnected = socket();
  const liveId = randomUUID();
  const viewedId = randomUUID();
  try {
    channel.addClient(owner, false, undefined, 'panel-owner');
    const live = channel.getClientState(owner);
    live.sessionId = liveId;
    live.currentProc = {};
    live.cliDone = false;
    channel.addClient(guest, true, undefined, 'panel-guest');
    channel.getClientState(guest).sessionId = randomUUID();
    channel.attachToLiveSession(guest, liveId);
    channel.setBrowsing(guest, true, viewedId);
    channel.removeClient(guest);
    channel.removeClient(owner);
    channel.addClient(ownerReconnected, false, undefined, 'panel-owner');
    channel.addClient(guestReconnected, false, undefined, 'panel-guest');
    assert.equal(channel.getClientState(ownerReconnected).sessionId, liveId);
    assert.equal(channel.getClientState(guestReconnected).sessionId, viewedId);
    live.currentProc = undefined;
  } finally {
    channel.removeClient(ownerReconnected);
    channel.removeClient(guestReconnected);
    destroyChannel(dir);
  }
});
