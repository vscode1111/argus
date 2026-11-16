const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-contract-'));
process.env.ARGUS_CONFIG = path.join(dir, 'settings.json');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const { createSessionState } = require('../out/backend/sessionState');
const { handleCliEvent } = require('../out/backend/cliHandler');
const { handleToolAnswer, handleSend, handleStop } = require('../out/backend/providers/claudeExecution');
const { claudeProvider } = require('../out/backend/providers/claude');
function setup() {
  const state = createSessionState(dir), events = [], written = [];
  state.sendLog = state.resetStaleTimer = state.startStaleTimer = () => {};
  state.watchdog = { state: { lastEventTime: 0, active: true }, interval: null };
  state.currentProc = { stdin: { writable: true, write: line => { written.push(JSON.parse(line)); return true; } } };
  state.askViaStdio = true; state.cliDone = false;
  state.broadcast = line => events.push(JSON.parse(line));
  return { state, events, written };
}
const input = { questions: [{ question: 'Choose features', header: 'Features', multiSelect: true,
  options: [{ label: 'Search', description: 'Search inventory' }, { label: 'Sort' }] }] };
const assistant = (id, json = false) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion',
  input: json ? { questions: JSON.stringify(input.questions) } : input }] } });
const control = id => ({ type: 'control_request', request_id: `request-${id}`, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: id, input } });
test('I5 teardown finalizes each tool surface once before its interaction resolution', () => {
  const { state, events } = setup(); handleCliEvent(state, assistant('choice'));
  const { clearClaudeQuestions } = require('../out/backend/providers/claudeQuestions');
  clearClaudeQuestions(state, 'provider-resolved'); clearClaudeQuestions(state, 'superseded');
  const ends = events.filter(e => e.type === 'tool_end' && e.call.id === 'choice');
  assert.equal(ends.length, 1); assert.equal(JSON.parse(ends[0].call.result).cancelled, true);
  assert.ok(events.indexOf(ends[0]) < events.findIndex(e => e.type === 'interaction_resolved'));
});
test('I4 async replacement supersedes a different question once, never same-ID repeats', async () => {
  const { CodexSession } = require('../out/backend/providers/codex'); const state = createSessionState(dir), events = [];
  state.selection = { providerId: 'codex', model: '', effort: '', thinking: true }; state.broadcast = line => events.push(JSON.parse(line));
  const rpc = { async start() {}, async request(method) { return method === 'thread/start' ? { thread: { id: 'inventory-thread' } } : { turn: { id: 'inventory-turn' } }; }, respond() {}, dispose() {} };
  const runtime = new CodexSession(state, rpc, async () => {});
  try {
    await runtime.send({ text: 'Check inventory.' });
    const question = id => rpc.onMessage('item/completed', { threadId: 'inventory-thread', turnId: 'inventory-turn', item: { id, type: 'agentMessage', text: 'Choose section', delivery: 'async', questions: [{ title: 'Section', options: ['Stock'] }] } });
    question('first'); const first = state.interaction.id; question('second'); const second = state.interaction.id; question('second');
    assert.equal(events.filter(e => e.type === 'interaction_resolved' && e.id === first && e.reason === 'superseded').length, 1);
    assert.equal(events.filter(e => e.type === 'interaction_resolved' && e.id === second).length, 0);
    assert.equal(state.interaction.id, second);
  } finally { runtime.dispose(); }
});

test('steer acknowledgement cannot supersede a newly arriving async question', async () => {
  const { CodexSession } = require('../out/backend/providers/codex');
  for (const duringAck of [false, true]) {
    const state = createSessionState(dir), events = [];
    state.selection = { providerId: 'codex', model: '', effort: '', thinking: true };
    state.broadcast = line => events.push(JSON.parse(line));
    const question = id => rpc.onMessage('item/completed', { threadId: 'inventory-thread', turnId: 'inventory-turn',
      item: { id, type: 'agentMessage', text: 'Choose section', delivery: 'async', questions: [{ title: 'Section', options: ['Stock'] }] } });
    const rpc = { async start() {}, async request(method) {
      if (method === 'turn/steer' && duringAck) {
        question('new-choice');
        rpc.onMessage('turn/completed', { threadId: 'inventory-thread', turn: { id: 'inventory-turn', status: 'completed' } });
      }
      return method === 'thread/start' ? { thread: { id: 'inventory-thread' } } : { turn: { id: 'inventory-turn' } };
    }, respond() {}, dispose() {} };
    const runtime = new CodexSession(state, rpc, async () => {});
    try {
      await runtime.send({ text: 'Check inventory.' }); question('old-choice');
      const oldId = state.interaction.id;
      await runtime.send({ text: 'Choose inventory.' });
      assert.equal(events.filter(e => e.type === 'interaction_resolved' && e.id === oldId && e.reason === 'superseded').length, 1);
      if (duringAck) {
        assert.ok(state.interaction, 'new question survives the steer acknowledgement');
        assert.notEqual(state.interaction.id, oldId);
        assert.equal(events.filter(e => e.type === 'interaction_resolved' && e.id === state.interaction.id).length, 0);
      } else assert.equal(state.interaction, null, 'ordinary input still supersedes the old async question');
    } finally { runtime.dispose(); }
  }
});

test('one normalized pending interaction for either native ordering, with descriptions and multi-select', () => {
  for (const first of ['assistant', 'control']) {
    const { state, events, written } = setup();
    for (const event of first === 'assistant' ? [assistant('choice', true), control('choice')] : [control('choice'), assistant('choice')]) handleCliEvent(state, event);
    assert.equal(events.filter(e => e.type === 'tool_start').length, 1);
    assert.equal(events.filter(e => e.type === 'interaction' && e.request).length, 1);
    assert.equal(state.interaction.sourceToolId, 'choice');
    const q = state.interaction.questions[0];
    assert.equal(q.multiSelect, true); assert.deepEqual(q.options, ['Search', 'Sort']);
    assert.equal(q.optionDescriptions[0], 'Search inventory');
    claudeProvider.createSession(state).respond('choice', { answers: { [q.id]: ['Search', 'Sort'] } });
    assert.deepEqual(written[0].response.response.updatedInput.answers, { 'Choose features': 'Search, Sort' });
    assert.deepEqual(events.find(e => e.type === 'interaction_resolved'), { type: 'interaction_resolved', id: 'choice', reason: 'answered' });
    assert.equal(state.interaction, null);
    const before = written.length;
    assert.throws(() => claudeProvider.createSession(state).respond('choice', { answers: { [q.id]: 'Search' } }), /pending/);
    assert.equal(written.length, before);
  }
});
test('early legacy answer remains compatible, queues once and exposes the next pending question', () => {
  const { state, written, events } = setup();
  handleCliEvent(state, assistant('first')); handleCliEvent(state, assistant('second'));
  assert.equal(state.interaction?.id, 'first');
  handleToolAnswer(state, { type: 'toolAnswer', id: 'first', answers: { 'Choose features': 'Search' } });
  assert.equal(state.interaction?.id, 'second');
  handleCliEvent(state, control('first')); handleCliEvent(state, control('first'));
  assert.equal(written.filter(e => e.response?.response?.behavior === 'allow').length, 1);
  assert.equal(events.filter(e => e.type === 'interaction_resolved' && e.id === 'first').length, 1);
});
test('a legacy flat answer whose question is literally answers does not collide with the normalized envelope', () => {
  const { state, written } = setup();
  const event = assistant('choice'); event.message.content[0].input = { questions: [{ question: 'answers', options: [{ label: 'Search' }] }] };
  handleCliEvent(state, event); handleCliEvent(state, control('choice'));
  handleToolAnswer(state, { id: 'choice', answers: { answers: 'Search' } });
  assert.deepEqual(written[0].response.response.updatedInput.answers, { answers: 'Search' });
});
test('malformed or contradictory answers are refused before native dispatch and legacy Stop clears interaction', () => {
  const { state, written } = setup();
  handleCliEvent(state, assistant('choice')); handleCliEvent(state, control('choice'));
  for (const response of ['invalid', [], null, { cancelled: true, answers: { 'choice:0': 'Search' } }, { answers: 'invalid' }]) {
    assert.throws(() => claudeProvider.createSession(state).respond('choice', response), /response|Answer/);
  }
  assert.equal(written.length, 0); assert.equal(state.interaction.id, 'choice');
  state.askViaStdio = false;
  handleStop(state); clearTimeout(state.stopKillTimer);
  assert.equal(state.interaction, null);
});
test('dismiss, typed input, Stop and native resolution have distinct resolution reasons', () => {
  for (const [action, reason] of [['dismiss', 'cancelled'], ['typed', 'superseded'], ['stop', 'cancelled'], ['native', 'provider-resolved']]) {
    const { state, events } = setup();
    handleCliEvent(state, assistant('choice')); handleCliEvent(state, control('choice'));
    if (action === 'dismiss') claudeProvider.createSession(state).respond('choice', { cancelled: true });
    if (action === 'typed') handleSend(state, { text: 'Use search.' });
    if (action === 'stop') { handleStop(state); clearTimeout(state.stopKillTimer); }
    if (action === 'native') handleCliEvent(state, { type: 'tool_result', tool_use_id: 'choice', content: 'Completed' });
    assert.equal(events.find(e => e.type === 'interaction_resolved')?.reason, reason);
    assert.equal(state.interaction, null);
  }
});
test('tool failures preserve native structured exit facts without guessing from output', () => {
  const { state, events } = setup();
  handleCliEvent(state, { type: 'tool_result', tool_use_id: 'inventory-check', content: 'Exit code: 9', is_error: true, exit_code: 7 });
  const result = events.find(e => e.type === 'tool_end').call;
  assert.equal(result.exitCode, 7); assert.equal(result.outcome, 'failure');
  handleCliEvent(state, { type: 'tool_result', tool_use_id: 'inventory-read', content: 'Exit code: 9' });
  assert.equal(events.at(-1).call.exitCode, null); assert.equal(events.at(-1).call.outcome, 'unknown');
});

test('synchronous answers and async normal-send clearing report distinct neutral resolutions and exit facts', async () => {
  const { CodexSession } = require('../out/backend/providers/codex');
  const state = createSessionState(dir), events = [], replies = [];
  state.selection = { providerId: 'codex', model: '', effort: '', thinking: true };
  state.broadcast = text => events.push(JSON.parse(text));
  const rpc = { async start() {}, async request(method) {
    if (method === 'thread/start') return { thread: { id: 'inventory-thread' } };
    if (method === 'turn/start') return { turn: { id: 'inventory-turn' } };
    return {};
  }, respond(id, response) { replies.push({ id, response }); }, reject() {}, dispose() {} };
  const runtime = new CodexSession(state, rpc, async () => {}); state.runtime = runtime;
  try {
    await runtime.send({ text: 'Check inventory.' });
    rpc.onMessage('item/tool/requestUserInput', { threadId: 'inventory-thread', questions: [{ id: 'choice', question: 'Which section?', options: [{ label: 'Stock' }] }] }, 12);
    const id = state.interaction.id;
    runtime.respond(id, { answers: { choice: 'Stock' } });
    assert.equal(events.find(e => e.type === 'interaction_resolved')?.reason, 'answered');
    assert.throws(() => runtime.respond(id, { answers: { choice: 'Stock' } }), /pending/);
    assert.equal(replies.length, 1);
    rpc.onMessage('item/completed', { threadId: 'inventory-thread', turnId: 'inventory-turn', item: { id: 'check', type: 'commandExecution', status: 'completed', exitCode: 7 } });
    const tool = events.find(e => e.type === 'tool_end').call;
    assert.equal(tool.exitCode, 7); assert.equal(tool.outcome, 'failure');
    rpc.onMessage('item/completed', { threadId: 'inventory-thread', turnId: 'inventory-turn', item: { id: 'follow-up', type: 'agentMessage', text: 'Which section?', delivery: 'async', questions: [{ title: 'Section', options: ['Stock'] }] } });
    const asyncId = state.interaction.id;
    rpc.onMessage('turn/completed', { threadId: 'inventory-thread', turn: { id: 'inventory-turn', status: 'completed' } });
    assert.equal(state.interaction?.id, asyncId, 'async question survives done');
    await runtime.send({ text: 'Stock.' });
    assert.equal(events.find(e => e.type === 'interaction_resolved' && e.id === asyncId)?.reason, 'superseded');
    assert.equal(replies.length, 1, 'async answer never invents an RPC response');
  } finally { runtime.dispose(); }
});
