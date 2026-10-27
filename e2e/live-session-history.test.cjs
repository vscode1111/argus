const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel');
const { handleResumeSession } = require('../out/backend/session');
const { loadSession } = require('../out/backend/sessions');
const { replayThread } = require('../out/backend/providers/codex');

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

test('live history shows one copy of an in-progress turn already in the stored replay', () => {
  const cwd = path.join(os.tmpdir(), `history-overlap-${randomUUID()}`);
  const frames = [];
  const streamer = { readyState: 1, send() {} };
  const viewer = { readyState: 1, send(frame) { frames.push(JSON.parse(frame)); } };
  const currentPrompt = 'Continue the report';
  const currentAnswer = 'I am checking the latest figures.';
  const command = 'find reports -maxdepth 2';

  try {
    const channel = getOrCreateChannel(cwd);
    channel.addClient(streamer, true);
    const live = channel.getClientState(streamer);
    live.sessionId = `codex:${randomUUID()}`;
    live.runtime = { active: true, activeTurnId: 'current-turn' };
    live.broadcast(JSON.stringify({ type: 'message', message: { id: 'live-user', role: 'user', content: currentPrompt } }));
    live.broadcast(JSON.stringify({ type: 'thinking_start' }));
    live.broadcast(JSON.stringify({ type: 'text_chunk', text: currentAnswer }));
    live.broadcast(JSON.stringify({ type: 'tool_start', call: { id: 'live-command', name: 'commandExecution', input: { command } } }));

    const stored = replayThread({ turns: [
      { id: 'earlier-turn', items: [
        { id: 'earlier-user', type: 'userMessage', content: [{ type: 'text', text: 'First request' }] },
        { id: 'earlier-answer', type: 'agentMessage', text: 'First result' },
      ] },
      { id: 'current-turn', items: [
        { id: 'stored-user', type: 'userMessage', content: [{ type: 'text', text: currentPrompt }] },
        { id: 'stored-answer', type: 'agentMessage', text: currentAnswer },
        { id: 'stored-command', type: 'commandExecution', command, status: 'inProgress' },
      ] },
    ] });
    channel.addClient(viewer);
    frames.length = 0;
    channel.replayHistory(viewer, stored);

    const loaded = frames.find(frame => frame.type === 'sessionLoaded');
    assert.equal(loaded.messages.filter(message => message.content === 'First result').length, 1);
    assert.equal(loaded.messages.filter(message => message.role === 'user' && message.content === currentPrompt).length, 1);
    assert.equal(loaded.messages.filter(message => message.role === 'assistant' && message.content === currentAnswer).length
      + frames.filter(frame => frame.type === 'text_chunk' && frame.text === currentAnswer).length, 1);
    assert.equal(loaded.messages.flatMap(message => message.blocks || []).filter(block => block.type === 'tool').length
      + frames.filter(frame => frame.type === 'tool_start').length, 1);
  } finally {
    destroyChannel(cwd);
  }
});

test('live history keeps an earlier turn when the new prompt and answer repeat', () => {
  const cwd = path.join(os.tmpdir(), `history-repeat-${randomUUID()}`);
  const frames = [];
  const streamer = { readyState: 1, send() {} };
  const viewer = { readyState: 1, send(frame) { frames.push(JSON.parse(frame)); } };
  try {
    const channel = getOrCreateChannel(cwd);
    channel.addClient(streamer, true);
    const live = channel.getClientState(streamer);
    live.sessionId = `codex:${randomUUID()}`;
    live.runtime = { active: true, activeTurnId: 'new-turn' };
    live.broadcast(JSON.stringify({ type: 'message', message: { id: 'new-user', role: 'user', content: 'Review the report' } }));
    live.broadcast(JSON.stringify({ type: 'thinking_start' }));
    live.broadcast(JSON.stringify({ type: 'text_chunk', text: 'New result' }));
    const stored = replayThread({ turns: [{ id: 'earlier-turn', items: [
      { id: 'earlier-user', type: 'userMessage', content: [{ type: 'text', text: 'Review the report' }] },
      { id: 'earlier-answer', type: 'agentMessage', text: 'New result' },
    ] }] });
    channel.addClient(viewer);
    frames.length = 0;
    channel.replayHistory(viewer, stored);
    const loaded = frames.find(frame => frame.type === 'sessionLoaded');
    assert.equal(loaded.messages.filter(message => message.role === 'assistant' && message.content === 'New result').length, 1);
    assert.equal(frames.filter(frame => frame.type === 'text_chunk' && frame.text === 'New result').length, 1);
  } finally {
    destroyChannel(cwd);
  }
});

test('opening an idle entry does not replay an abandoned streaming snapshot', () => {
  const cwd = path.join(os.tmpdir(), `history-idle-snapshot-${randomUUID()}`);
  const frames = [];
  const streamer = { readyState: 1, send() {} };
  const viewer = { readyState: 1, send(frame) { frames.push(JSON.parse(frame)); } };
  const prompt = 'Check the report status';
  const answer = 'The report is still being checked.';
  try {
    const channel = getOrCreateChannel(cwd);
    channel.addClient(streamer, true);
    const idle = channel.getClientState(streamer);
    idle.sessionId = `codex:${randomUUID()}`;
    idle.cliDone = true;
    idle.broadcast(JSON.stringify({ type: 'message', message: { id: 'status-request', role: 'user', content: prompt } }));
    idle.broadcast(JSON.stringify({ type: 'thinking_start' }));
    idle.broadcast(JSON.stringify({ type: 'text_chunk', text: answer }));
    const stored = replayThread({ turns: [{ id: 'status-turn', items: [
      { id: 'stored-request', type: 'userMessage', content: [{ type: 'text', text: prompt }] },
      { id: 'stored-reply', type: 'agentMessage', text: answer },
    ] }] });
    channel.addClient(viewer);
    frames.length = 0;
    channel.replayHistory(viewer, stored);
    const loaded = frames.find(frame => frame.type === 'sessionLoaded');
    assert.equal(loaded.messages.flatMap(message => message.blocks || [])
      .filter(block => block.type === 'text' && block.text === answer).length, 1);
    assert.equal(frames.filter(frame => frame.type === 'text_chunk' && frame.text === answer).length, 0);
    assert.equal(frames.filter(frame => frame.type === 'thinking_start').length, 0);
  } finally {
    destroyChannel(cwd);
  }
});
