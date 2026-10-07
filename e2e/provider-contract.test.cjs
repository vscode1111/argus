const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-providers-'));
process.env.ARGUS_CONFIG = path.join(dir, 'settings.json');
const { AppServerRpc } = require('../out/backend/providers/rpc');
const { resolveCodexBinary } = require('../out/backend/providers/executable');
const { CodexSession, replayThread, rateLimits } = require('../out/backend/providers/codex');
const { createSessionState } = require('../out/backend/sessionState');
const { defaultSelection, selectionFor } = require('../out/backend/providers/store');
const { writeConfig, DEFAULT_CONFIG } = require('../out/backend/config');
const { createErrorRetry, parseErrorRetryPatterns } = require('../out/backend/errorRetry');
const { handleCliEvent } = require('../out/backend/cliHandler');
const { getCliLaunchCount, resetCliLaunchCount } = require('../out/backend/providers/claudeExecution');
const live = [];
after(() => { for (const runtime of live) runtime.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
function session(validate = async () => {}) {
  const state = createSessionState(dir); state.selection = defaultSelection('codex');
  const events = [];
  const rpc = new AppServerRpc(process.execPath, [path.join(__dirname, 'fixtures/scub-provider-server.cjs')]);
  const runtime = new CodexSession(state, rpc, validate); state.runtime = runtime; live.push(runtime);
  const controller = createErrorRetry({ broadcast: text => events.push(JSON.parse(text)), getLastMessage: () => state.lastMessage,
    retry: input => { void runtime.send(input); }, log: () => {} });
  state.broadcast = controller.broadcast;
  return { state, events, runtime, controller };
}
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) assert.fail('scub condition timed out'); await new Promise(r => setTimeout(r, 10)); }
}

test('new conversations default to Codex and GPT-6-Luna without a saved selection', () => {
  assert.deepEqual(defaultSelection(), { providerId: 'codex', model: 'gpt-6-luna', effort: '', thinking: true });
  assert.deepEqual(selectionFor(undefined, dir), defaultSelection());
});

test('ordinary Windows PATH can find the installed desktop executable', () => {
  const local = path.join(dir, 'scub-local');
  const installed = path.join(local, 'OpenAI', 'Codex', 'bin', 'scub-version', 'codex.exe');
  fs.mkdirSync(path.dirname(installed), { recursive: true }); fs.writeFileSync(installed, '');
  const env = { PATH: path.join(dir, 'scub-empty'), LOCALAPPDATA: local };
  assert.equal(resolveCodexBinary(env, 'win32'), installed);
  const preferred = path.join(dir, 'scub-path'); fs.mkdirSync(preferred);
  fs.writeFileSync(path.join(preferred, 'codex.exe'), '');
  assert.equal(resolveCodexBinary({ ...env, PATH: preferred }, 'win32'), path.join(preferred, 'codex.exe'));
  assert.equal(resolveCodexBinary({ ...env, ARGUS_CODEX_BIN: 'scub-explicit' }, 'win32'), 'scub-explicit');
});

test('missing installations and non-Windows hosts keep ordinary command lookup', () => {
  assert.equal(resolveCodexBinary({ PATH: '', LOCALAPPDATA: path.join(dir, 'scub-missing') }, 'win32'), 'codex');
  assert.equal(resolveCodexBinary({}, 'linux'), 'codex');
});

test('Codex child finds Git Bash before the WSL launcher', { skip: process.platform !== 'win32' || !fs.existsSync(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')) }, async () => {
  const server = "require('node:readline').createInterface({input:process.stdin}).on('line', line => { const message = JSON.parse(line); if (message.id) { const bash = require('node:child_process').spawnSync('bash', ['-lc', 'echo $MSYSTEM'], {encoding:'utf8'}); process.stdout.write(JSON.stringify({id:message.id,result:{path:process.env.Path || process.env.PATH, system:bash.stdout.trim(), error:bash.stderr}}) + '\\n'); } })";
  const rpc = new AppServerRpc(process.execPath, ['-e', server]);
  try {
    await rpc.start();
    const result = await rpc.request('scub/path');
    const first = String(result.path).split(path.delimiter)[0];
    assert.equal(path.win32.normalize(first), path.win32.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin'));
    assert.equal(result.system, 'MINGW64', result.error);
  } finally { rpc.dispose(); }
});

test('streamed text is not duplicated by the completed item; binding survives recreation', async () => {
  const { state, events, runtime } = session();
  await runtime.send({ text: 'scub-first' }); await until(() => !runtime.active);
  assert.equal(events.filter(e => e.type === 'text_chunk').map(e => e.text).join(''), 'scub-ok');
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(selectionFor(state.sessionId, dir).providerId, 'codex');
});

test('capacity failures retry the same request and finish after recovery', async () => {
  writeConfig({ ...DEFAULT_CONFIG, errorRetryMaxRetries: 3, errorRetryDelay: 1 });
  const { events, runtime } = session();
  await runtime.send({ text: 'scub-capacity-twice' });
  await until(() => events.filter(e => e.type === 'retry_status').length === 2);
  await until(() => events.some(e => e.type === 'done'));
  assert.deepEqual(events.filter(e => e.type === 'retry_status').map(e => e.attempt), [1, 2]);
  assert.equal(events.filter(e => e.type === 'tool_end').length, 1);
  assert.equal(events.filter(e => e.type === 'message').length, 1);
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(events.filter(e => e.type === 'error').length, 0);
  assert.equal(events.filter(e => e.type === 'text_chunk').map(e => e.text).join(''), 'scub-ok');
});

test('capacity retry limit leaves the final error for manual retry', async () => {
  writeConfig({ ...DEFAULT_CONFIG, errorRetryMaxRetries: 1, errorRetryDelay: 1 });
  const { events, runtime } = session();
  await runtime.send({ text: 'scub-capacity-always' }); await until(() => events.some(e => e.type === 'done'));
  assert.deepEqual(events.filter(e => e.type === 'retry_status').map(e => e.attempt), [1]);
  assert.match(events.find(e => e.type === 'error').text, /at capacity/i);
  assert.equal(events.filter(e => e.type === 'done').length, 1);
});

test('zero configured capacity retries reports the first error', async () => {
  writeConfig({ ...DEFAULT_CONFIG, errorRetryMaxRetries: 0 });
  const { events, runtime } = session();
  await runtime.send({ text: 'scub-capacity-always' }); await until(() => !runtime.active);
  assert.equal(events.filter(e => e.type === 'retry_status').length, 0);
  assert.match(events.find(e => e.type === 'error').text, /at capacity/i);
});

test('stop cancels a scheduled capacity retry and unrelated errors never retry', async () => {
  writeConfig({ ...DEFAULT_CONFIG, errorRetryMaxRetries: 2, errorRetryDelay: 1 });
  const stopped = session();
  await stopped.runtime.send({ text: 'scub-capacity-always' });
  await until(() => stopped.events.some(e => e.type === 'retry_status'));
  stopped.controller.cancel(true);
  assert.equal(stopped.runtime.active, false);
  assert.equal(stopped.events.filter(e => e.type === 'done').length, 1);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(stopped.events.filter(e => e.type === 'retry_status').length, 1);
  const unrelated = session();
  await unrelated.runtime.send({ text: 'scub-other-error' }); await until(() => !unrelated.runtime.active);
  assert.equal(unrelated.events.filter(e => e.type === 'retry_status').length, 0);
  assert.match(unrelated.events.find(e => e.type === 'error').text, /unrelated/);
  writeConfig(DEFAULT_CONFIG);
});

test('pattern list accepts multiple case-insensitive expressions and rejects invalid input', () => {
  const valid = parseErrorRetryPatterns('scub-overload\\d+\nSCUB-BUSY');
  assert.equal(valid.error, undefined);
  assert.equal(valid.patterns.some(pattern => pattern.test('scub-overload42')), true);
  assert.equal(valid.patterns.some(pattern => pattern.test('scub-busy')), true);
  assert.match(parseErrorRetryPatterns('scub-[').error, /valid regular expression/);
  assert.deepEqual(parseErrorRetryPatterns('').patterns, []);
});

test('an empty pattern list disables error retries and a duplicate terminal error stays closed', () => {
  writeConfig({ ...DEFAULT_CONFIG, errorRetryPatterns: '' });
  const events = [];
  const controller = createErrorRetry({ broadcast: text => events.push(JSON.parse(text)), getLastMessage: () => ({ text: 'scub-request' }),
    retry: () => assert.fail('scub-unexpected retry'), log: () => {} });
  controller.broadcast(JSON.stringify({ type: 'error', text: 'Selected model is at capacity' }));
  controller.broadcast(JSON.stringify({ type: 'done' }));
  controller.broadcast(JSON.stringify({ type: 'error', text: 'Selected model is at capacity' }));
  controller.broadcast(JSON.stringify({ type: 'done' }));
  assert.deepEqual(events.map(event => event.type), ['error', 'done']);
  writeConfig(DEFAULT_CONFIG);
});

test('a Claude terminal error uses the same retry rules', async () => {
  writeConfig({ ...DEFAULT_CONFIG, errorRetryMaxRetries: 1, errorRetryDelay: 1, errorRetryPatterns: 'scub-transient\\s+overload' });
  const state = createSessionState(dir);
  state.selection = defaultSelection('claude');
  state.lastMessage = { text: 'scub-request' };
  state.sendLog = () => {};
  state.resetStaleTimer = () => {};
  state.watchdog = { state: { lastEventTime: 0, active: true, autoRetryCount: 0, retrying: false }, interval: null };
  const events = []; const retried = [];
  const controller = createErrorRetry({ broadcast: text => events.push(JSON.parse(text)), getLastMessage: () => state.lastMessage,
    retry: input => retried.push(input), log: () => {} });
  state.broadcast = controller.broadcast;
  handleCliEvent(state, { type: 'result', is_error: true, error: 'Scub-transient overload' });
  assert.equal(events.filter(e => e.type === 'error' || e.type === 'done').length, 0);
  assert.equal(events.find(e => e.type === 'retry_status').attempt, 1);
  await until(() => retried.length === 1);
  assert.equal(retried[0].text, 'scub-request');
  assert.equal(retried[0]._silent, true);
  controller.broadcast(JSON.stringify({ type: 'error', text: 'scub-transient overload' }));
  controller.broadcast(JSON.stringify({ type: 'done' }));
  assert.equal(events.filter(e => e.type === 'error').length, 1);
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  writeConfig(DEFAULT_CONFIG);
});

test('permission modes reach thread and turn requests', async () => {
  for (const mode of ['edit', 'plan', 'full-access']) {
    const { events, runtime } = session();
    await runtime.send({ text: `scub-permission-${mode}`, mode });
    await until(() => !runtime.active);
    assert.equal(events.filter(e => e.type === 'error').length, 0, mode);
  }
});

test('a starting turn keeps its selection while later changes apply to the next turn', async () => {
  let observed;
  const { state, runtime } = session(async selection => { observed = selection.model; });
  state.selection.model = 'scub-first';
  const sent = runtime.send({ text: 'scub-message' });
  state.selection.model = 'scub-next';
  await sent; await until(() => !runtime.active);
  assert.equal(observed, 'scub-first');
  assert.equal(selectionFor(state.sessionId, dir).model, 'scub-next');
});

test('usage snapshot survives reattachment and resets for the next turn', async () => {
  const { state, runtime } = session();
  await runtime.send({ text: 'scub-usage' }); await until(() => !runtime.active);
  assert.equal(state.liveInputTokens, 120);
  assert.equal(state.completedOutputTokens, 8);
  await runtime.send({ text: 'scub-wait' });
  assert.equal(state.liveInputTokens, 0);
  assert.equal(state.completedOutputTokens, 0);
  await runtime.stop();
});

test('stop settles before next turn and late old deltas cannot enter it', async () => {
  const { events, runtime } = session();
  await runtime.send({ text: 'scub-wait' });
  const stopped = runtime.stop();
  const sent = runtime.send({ text: 'scub-second' });
  await Promise.all([stopped, sent]); await until(() => !runtime.active);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(events.filter(e => e.type === 'text_chunk').map(e => e.text).join(''), 'scub-ok');
  assert.deepEqual(events.filter(e => e.type === 'done').map(e => !!e.interrupted), [true, false]);
});

test('stop retries the startup registration race instead of leaving generation active', async () => {
  const { events, runtime } = session();
  await runtime.send({ text: 'scub-interrupt-race' });
  await runtime.stop();
  assert.equal(runtime.active, false);
  assert.equal(events.filter(e => e.type === 'done' && e.interrupted).length, 1);
});

test('a response goes to its pending RPC exactly once', async () => {
  const { events, runtime } = session(); await runtime.send({ text: 'scub-question' });
  await until(() => events.some(e => e.type === 'interaction' && e.request));
  const request = events.find(e => e.type === 'interaction' && e.request).request;
  runtime.respond(request.id, { answers: { 'scub-choice': 'scub-blue' } });
  assert.throws(() => runtime.respond(request.id, {}), /no longer pending/);
  await until(() => !runtime.active);
});

test('async choice items become a persistent question after the turn completes', async () => {
  const { state, events, runtime } = session();
  await runtime.send({ text: 'scub-async-question' }); await until(() => !runtime.active);
  const request = events.find(e => e.type === 'interaction' && e.request?.async)?.request;
  assert.equal(request?.kind, 'question');
  assert.deepEqual(request?.questions, [{ id: '0', question: 'scub-choice', options: ['scub-blue', 'scub-green'] }]);
  assert.deepEqual(state.interaction, request);
  const replay = replayThread({ turns: [{ id: 'scub-turn', items: [
    { type: 'userMessage', id: 'scub-user', content: [{ type: 'text', text: 'scub-request' }] },
    { type: 'agentMessage', id: 'scub-ask', text: 'scub-choice', delivery: 'async',
      questions: [{ title: 'scub-choice', options: ['scub-blue', 'scub-green'] }] },
  ] }] });
  assert.deepEqual(replay[1].interaction, request);
  await runtime.send({ text: 'scub-green' }); await until(() => !runtime.active);
  assert.equal(state.interaction, null);
});

test('an async choice can be answered while the turn continues', async () => {
  const { state, events, runtime } = session();
  await runtime.send({ text: 'scub-async-question-live' });
  await until(() => !!state.interaction?.async);
  assert.equal(runtime.active, true);
  await runtime.send({ text: 'scub-green' });
  await until(() => !runtime.active);
  assert.equal(state.interaction, null);
  assert.equal(events.some(event => event.type === 'user_inject' && event.text === 'scub-green'), true);
});

test('unknown permission requests are rejected, not silently approved', async () => {
  const { events, runtime } = session(); await runtime.send({ text: 'scub-unknown-request' });
  await until(() => !runtime.active);
  assert.equal(events.filter(e => e.type === 'error').length, 0);
});

test('unsupported attachments do not create a turn or lose user input', async () => {
  const { events, runtime } = session();
  await assert.rejects(runtime.send({ text: 'scub-file', images: [{ data: 'c2N1Yg==', mediaType: 'application/pdf' }] }), /accepts text and images/);
  assert.equal(events.length, 0); assert.equal(runtime.active, false);
});

test('slash skills use the provider-discovered path and native skill input', async () => {
  const { events, runtime } = session();
  await runtime.send({ text: '/scub-skill scub-input' }); await until(() => !runtime.active);
  assert.equal(events.filter(e => e.type === 'error').length, 0);
  assert.equal(events.filter(e => e.type === 'text_chunk').map(e => e.text).join(''), 'scub-ok');
});

test('independent selections and unknown usage remain independent', () => {
  writeConfig({ ...DEFAULT_CONFIG, providerDefaults: { codex: { providerId: 'codex', model: 'scub-model', effort: 'high', thinking: true } } });
  const first = createSessionState(dir); const second = createSessionState(dir);
  first.selection.model = 'scub-other'; assert.equal(second.selection.model, 'scub-model');
  assert.deepEqual(rateLimits({ rateLimits: { primary: null } }), []);
  assert.equal(rateLimits({ rateLimits: { primary: { usedPercent: 23, windowDurationMins: 300 } } })[0].utilization, 0.23);
});

test('usage window labels express whole days and remaining hours', () => {
  const label = windowDurationMins => rateLimits({ rateLimits: { limitId: 'scub-limit', limitName: 'scub',
    primary: { usedPercent: 31, windowDurationMins } } })[0].label;
  assert.equal(label(10_080), 'scub 7d');
  assert.equal(label(1_500), 'scub 1d 1h');
  assert.equal(label(300), 'scub 5h');
});

test('history preserves user text, ordered tools and assistant text', () => {
  const replay = replayThread({ turns: [{ id: 'scub-turn', items: [
    { type: 'userMessage', id: 'scub-user', content: [{ type: 'text', text: 'scub-request' }] },
    { type: 'commandExecution', id: 'scub-command', command: 'echo scub', aggregatedOutput: 'scub' },
    { type: 'agentMessage', id: 'scub-answer', text: 'scub-done' },
  ] }] });
  assert.equal(replay[0].content, 'scub-request');
  assert.equal(replay[1].blocks[0].call.kind, 'command');
  assert.equal(replay[1].content, 'scub-done');
});

test('history keeps file patches available for later diff previews', () => {
  const changes = [{ path: 'D:/scub/one.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-scub-old\n+scub-new\n' }];
  const replay = replayThread({ turns: [{ id: 'scub-turn', items: [
    { type: 'userMessage', id: 'scub-user', content: [{ type: 'text', text: 'scub-request' }] },
    { type: 'fileChange', id: 'scub-change', changes, status: 'completed' },
  ] }] });
  assert.deepEqual(replay[1].blocks[0].call.input.changes, changes);
});

test('a provider process launch increments the shared count once across reused turns', async () => {
  const before = getCliLaunchCount();
  const { runtime } = session();
  await runtime.send({ text: 'scub-count-first' }); await until(() => !runtime.active);
  assert.equal(getCliLaunchCount(), before + 1);
  await runtime.send({ text: 'scub-count-second' }); await until(() => !runtime.active);
  assert.equal(getCliLaunchCount(), before + 1);
  resetCliLaunchCount();
  assert.equal(getCliLaunchCount(), 0);
});
