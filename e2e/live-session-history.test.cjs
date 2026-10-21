const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel');
const { handleResumeSession } = require('../out/backend/session');
const { loadSession } = require('../out/backend/sessions');

async function openStoredSession(shouldBeLive, storeCurrent = true) {
  const cwd = path.join(os.tmpdir(), `argus-live-history-${randomUUID()}`);
  const id = randomUUID();
  const projectDir = path.join(os.homedir(), '.claude', 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  const transcript = path.join(projectDir, `${id}.jsonl`);
  const frames = [];
  const streamer = { readyState: 1, send() {} };
  const viewer = { readyState: 1, send(frame) { frames.push(JSON.parse(frame)); } };

  try {
    fs.mkdirSync(cwd);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(transcript, [
      { type: 'system', subtype: 'init', cwd, session_id: id },
      { type: 'user', cwd, message: { role: 'user', content: 'Earlier question' } },
      { type: 'assistant', message: { id: 'earlier-answer', content: [{ type: 'text', text: 'Earlier answer' }] } },
      ...(storeCurrent ? [{ type: 'user', cwd, message: { role: 'user', content: 'Current question' } }] : []),
    ].map(line => JSON.stringify(line)).join('\n') + '\n');

    const channel = getOrCreateChannel(cwd);
    channel.addClient(streamer, true);
    const live = channel.getClientState(streamer);
    live.sessionId = id;
    live.currentProc = shouldBeLive ? {} : undefined;
    live.cliDone = !shouldBeLive;
    live.sendLog = () => {};
    live.broadcast(JSON.stringify({ type: 'message', message: { id: 'current-question', role: 'user', content: 'Current question' } }));
    live.broadcast(JSON.stringify({ type: 'thinking_start' }));
    live.broadcast(JSON.stringify({ type: 'text_chunk', text: 'Working on the current question' }));
    if (!shouldBeLive) live.broadcast(JSON.stringify({ type: 'done' }));

    channel.addClient(viewer, true);
    const viewing = channel.getClientState(viewer);
    viewing.sendLog = () => {};
    await handleResumeSession(viewing, viewer, channel, id);
    return { frames, stored: loadSession(id, cwd) };
  } finally {
    destroyChannel(cwd);
    if (fs.existsSync(transcript)) fs.unlinkSync(transcript);
    if (fs.existsSync(projectDir)) fs.rmdirSync(projectDir);
    if (fs.existsSync(cwd)) fs.rmdirSync(cwd);
  }
}

test('opening a running session includes stored history and live progress', async () => {
  const { frames, stored } = await openStoredSession(true);
  const opened = frames.find(frame => frame.type === 'sessionLoaded');
  assert.equal(stored.length, 3);
  assert.deepEqual(opened.messages.map(message => message.content), stored.map(message => message.content));
  assert.equal(frames.some(frame => frame.type === 'thinking_start'), true);
});

test('opening a finished session includes stored history without live progress', async () => {
  const { frames, stored } = await openStoredSession(false);
  const opened = frames.find(frame => frame.type === 'sessionLoaded');
  assert.deepEqual(opened.messages.map(message => message.content), stored.map(message => message.content));
  assert.equal(frames.some(frame => frame.type === 'thinking_start'), false);
});

test('opening a running session keeps a current request absent from the stored transcript', async () => {
  const { frames } = await openStoredSession(true, false);
  const opened = frames.find(frame => frame.type === 'sessionLoaded');
  assert.deepEqual(opened.messages.map(message => message.content), ['Earlier question', 'Earlier answer', 'Current question']);
  assert.equal(frames.some(frame => frame.type === 'thinking_start'), true);
});
