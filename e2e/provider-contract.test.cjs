const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-providers-'));
process.env.ARGUS_CONFIG = path.join(dir, 'settings.json');
const { AppServerRpc } = require('../out/backend/providers/rpc');
const { readHistoryItems } = require('../out/backend/providers/codexHistory');
const { resolveCodexBinary } = require('../out/backend/providers/executable');
const { CodexSession, replayThread, linksSubagent, subagentsInThread, rateLimits } = require('../out/backend/providers/codex');
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

let controlledConversation = 0;
function configurationSession(validate = async () => {}) {
  const state = createSessionState(dir);
  state.selection = { providerId: 'codex', model: 'source-model', effort: 'medium', thinking: true };
  const events = [], calls = [], continuations = [];
  const threadId = `configuration-conversation-${++controlledConversation}`;
  let turn = 0;
  const rpc = {
    pid: 12345, disposed: false,
    async start() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: threadId } };
      if (method === 'turn/start') return { turn: { id: `migration-turn-${++turn}` } };
      if (method === 'turn/interrupt') rpc.onMessage('turn/completed', { threadId, turn: { id: runtime.activeTurnId, status: 'interrupted' } });
      return {};
    },
    dispose() { this.disposed = true; },
    respond() {}, reject() {},
  };
  const runtime = new CodexSession(state, rpc, validate);
  state.runtime = runtime; live.push(runtime);
  state.broadcast = text => events.push(JSON.parse(text));
  state.emitSyntheticSend = text => { continuations.push(runtime.send(JSON.parse(text))); };
  const complete = (status = 'completed', error) => rpc.onMessage('turn/completed', {
    threadId, turn: { id: runtime.activeTurnId, status, ...(error ? { error: { message: error } } : {}) },
  });
  const request = (operationId = 'migration-profile') => ({ operationId, expectedTurnId: runtime.activeTurnId,
    selection: { providerId: 'codex', model: 'target-model', effort: 'high', thinking: true }, continuation: 'Continue the migration' });
  return { state, runtime, rpc, events, calls, continuations, complete, request, threadId };
}

test('deferred configuration continues once in the same conversation with the original permissions', async () => {
  const defaults = defaultSelection();
  for (const mode of ['edit', 'plan', 'full-access']) {
    const { state, runtime, rpc, events, calls, continuations, complete, request } = configurationSession();
    await runtime.send({ text: 'Prepare the migration', mode });
    const sessionId = state.sessionId;
    const sourceSelection = { ...state.selection };
    let callerConnected = true;
    const operation = request();
    const queued = await runtime.queueConfiguration(operation, () => callerConnected);
    assert.equal(queued.status, 'queued');
    assert.deepEqual(runtime.getSessionControl().activeSelection, sourceSelection);
    queued.selection.model = 'unrelated-model';
    assert.deepEqual(runtime.getSessionControl().configuration.selection, operation.selection);
    callerConnected = false;
    complete();
    assert.deepEqual(state.selection, sourceSelection);
    assert.equal(runtime.getSessionControl().activeSelection, undefined);
    await until(() => runtime.getSessionControl().configuration.status === 'started');
    await Promise.all(continuations);
    assert.equal(continuations.length, 1);
    assert.equal(state.runtime, runtime);
    assert.equal(state.sessionId, sessionId);
    assert.equal(rpc.disposed, false);
    assert.equal(runtime.pid, rpc.pid);
    assert.deepEqual(state.selection, operation.selection);
    assert.deepEqual(selectionFor(sessionId, dir), operation.selection);
    assert.deepEqual(runtime.getSessionControl().activeSelection, operation.selection);
    assert.equal(calls.filter(call => call.method.startsWith('thread/')).length, 1);
    const turns = calls.filter(call => call.method === 'turn/start');
    assert.equal(turns.length, 2);
    assert.equal(turns[1].params.model, operation.selection.model);
    assert.equal(turns[1].params.effort, operation.selection.effort);
    assert.deepEqual(turns[1].params.sandboxPolicy, turns[0].params.sandboxPolicy);
    assert.equal(turns[1].params.approvalPolicy, turns[0].params.approvalPolicy);
    assert.equal(state.lastMessage.mode, mode);
    assert.deepEqual(events.filter(event => event.type === 'sessionConfiguration').map(event => event.configuration.status), ['queued', 'applied', 'started']);
    assert.equal((await runtime.queueConfiguration(operation, () => false)).status, 'started');
    assert.equal(continuations.length, 1);
    await assert.rejects(runtime.queueConfiguration({ ...operation, continuation: 'A different request' }, () => true), /different configuration/);
    runtime.dispose();
  }
  assert.deepEqual(defaultSelection(), defaults);
});

test('deferred configuration cancels when the source conversation changes', async () => {
  for (const change of ['steer', 'stop', 'dispose', 'runtime', 'session', 'selection', 'approval', 'question', 'input-after-completion']) {
    const context = configurationSession();
    const { state, runtime, rpc, calls, continuations, complete, request, threadId } = context;
    await runtime.send({ text: 'Prepare the migration' });
    await runtime.queueConfiguration(request(), () => true);
    if (change === 'steer') await runtime.send({ text: 'Use the revised migration plan' });
    if (change === 'stop') await runtime.stop();
    if (change === 'dispose') runtime.dispose();
    if (change === 'runtime') state.runtime = {};
    if (change === 'session') state.sessionId = 'codex:another-conversation';
    if (change === 'selection') state.selection = { ...state.selection, effort: 'low' };
    if (change === 'approval') rpc.onMessage('item/commandExecution/requestApproval', { threadId, turnId: runtime.activeTurnId, command: 'inspect migration' }, 100);
    if (change === 'question') rpc.onMessage('item/completed', { threadId, turnId: runtime.activeTurnId,
      item: { id: 'migration-question', type: 'agentMessage', text: 'Continue?', delivery: 'async', questions: [{ title: 'Migration approval', options: ['Continue', 'Stop'] }] } });
    if (change !== 'stop' && change !== 'dispose') complete();
    if (change === 'input-after-completion') await runtime.send({ text: 'Inspect the rollback first' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.getSessionControl().configuration.status, 'cancelled', change);
    assert.notEqual(state.selection.model, 'target-model', change);
    assert.equal(continuations.length, 0, change);
    assert.equal(calls.filter(call => call.method === 'turn/start').length, change === 'input-after-completion' ? 2 : 1, change);
    runtime.dispose();
  }
});

test('deferred configuration rechecks ownership and input after asynchronous validation', async () => {
  for (const change of ['steer', 'stop', 'complete', 'runtime', 'session', 'selection', 'caller', 'approval']) {
    let release;
    const validation = new Promise(resolve => { release = resolve; });
    const { state, runtime, rpc, continuations, complete, request, threadId } = configurationSession(async selection => {
      if (selection.model === 'target-model') await validation;
    });
    await runtime.send({ text: 'Prepare the migration' });
    let callerCurrent = true;
    const operation = request();
    const pending = runtime.queueConfiguration(operation, () => callerCurrent);
    const duplicate = runtime.queueConfiguration(operation, () => callerCurrent);
    if (change === 'steer') await runtime.send({ text: 'Use a different migration plan' });
    if (change === 'stop') await runtime.stop();
    if (change === 'complete') complete();
    if (change === 'runtime') state.runtime = {};
    if (change === 'session') state.sessionId = 'codex:another-conversation';
    if (change === 'selection') state.selection = { ...state.selection, effort: 'low' };
    if (change === 'caller') callerCurrent = false;
    if (change === 'approval') rpc.onMessage('item/commandExecution/requestApproval', { threadId, turnId: runtime.activeTurnId }, 101);
    release();
    assert.equal((await pending).status, 'cancelled', change);
    assert.equal((await duplicate).status, 'cancelled', change);
    await new Promise(resolve => setImmediate(resolve));
    assert.notEqual(state.selection.model, operation.selection.model, change);
    assert.equal(continuations.length, 0, change);
    runtime.dispose();
  }
});

test('deferred configuration rejects invalid or unavailable source turns and retains validation failure', async () => {
  const { runtime, rpc, request, threadId } = configurationSession(async selection => {
    if (selection.model === 'target-model') throw new Error('Requested model is unavailable');
  });
  await assert.rejects(runtime.queueConfiguration(request(), () => true), /source turn/);
  await runtime.send({ text: 'Prepare the migration' });
  const operation = request();
  await assert.rejects(runtime.queueConfiguration({ ...operation, selection: { ...operation.selection, providerId: 'other-provider' } }, () => true), /Invalid deferred/);
  await assert.rejects(runtime.queueConfiguration({ ...operation, expectedTurnId: 'previous-turn' }, () => true), /source turn/);
  await assert.rejects(runtime.queueConfiguration(operation, () => true), /unavailable/);
  assert.equal(runtime.getSessionControl().configuration.status, 'failed');
  assert.equal((await runtime.queueConfiguration(operation, () => true)).status, 'failed');
  rpc.onMessage('item/commandExecution/requestApproval', { threadId, turnId: runtime.activeTurnId }, 102);
  await assert.rejects(runtime.queueConfiguration(request('second-profile'), () => true), /source turn/);
  runtime.dispose();
});

test('only a successful completed source turn can start a configured continuation', async () => {
  for (const [status, error] of [['interrupted'], ['failed'], ['completed', 'The source request failed'], ['unknown']]) {
    const { runtime, continuations, complete, request } = configurationSession();
    await runtime.send({ text: 'Prepare the migration' });
    await runtime.queueConfiguration(request(), () => true);
    complete(status, error);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(continuations.length, 0);
    assert.equal(runtime.getSessionControl().configuration.status, 'cancelled');
    runtime.dispose();
  }
});

test('deferred configuration exposes provider and continuation dispatch failures', async () => {
  for (const failure of ['provider', 'dispatch', 'continuation-start']) {
    let targetValidations = 0;
    const { state, runtime, rpc, continuations, complete, request } = configurationSession(async selection => {
      if (selection.model === 'target-model' && ++targetValidations > 1 && failure === 'continuation-start') throw new Error('Continuation model is unavailable');
    });
    await runtime.send({ text: 'Prepare the migration' });
    await runtime.queueConfiguration(request(), () => true);
    if (failure === 'provider') rpc.onFailure(new Error('Provider connection was lost'));
    else {
      if (failure === 'dispatch') state.emitSyntheticSend = () => { throw new Error('Continuation delivery failed'); };
      complete();
    }
    await until(() => runtime.getSessionControl().configuration.status === 'failed');
    await Promise.all(continuations);
    assert.match(runtime.getSessionControl().configuration.reason, /lost|failed|unavailable/);
    runtime.dispose();
  }
});

test('new input during continuation validation cancels its native start', async () => {
  let release, targetValidations = 0;
  const validation = new Promise(resolve => { release = resolve; });
  const { runtime, calls, events, continuations, complete, request } = configurationSession(async selection => {
    if (selection.model === 'target-model' && ++targetValidations === 2) await validation;
  });
  await runtime.send({ text: 'Prepare the migration' });
  await runtime.queueConfiguration(request(), () => true);
  complete();
  await until(() => targetValidations === 2);
  const manualSend = runtime.send({ text: 'Inspect the rollback first' });
  release();
  await manualSend;
  await Promise.all(continuations);
  const turns = calls.filter(call => call.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.equal(turns[1].params.input[0].text, 'Inspect the rollback first');
  assert.equal(runtime.getSessionControl().configuration.status, 'cancelled');
  assert.equal(events.filter(event => event.type === 'error').length, 0);
  runtime.dispose();
});

test('input arriving after continuation submission steers the started native turn', async () => {
  const { runtime, rpc, calls, continuations, complete, request } = configurationSession();
  await runtime.send({ text: 'Prepare the migration' });
  let release;
  const acknowledgement = new Promise(resolve => { release = resolve; });
  const originalRequest = rpc.request;
  rpc.request = async (method, params) => {
    const result = await originalRequest(method, params);
    if (method === 'turn/start') await acknowledgement;
    return result;
  };
  await runtime.queueConfiguration(request(), () => true);
  complete();
  await until(() => calls.filter(call => call.method === 'turn/start').length === 2);
  const manualSend = runtime.send({ text: 'Include the rollback plan' });
  release();
  await manualSend;
  await Promise.all(continuations);
  assert.equal(runtime.getSessionControl().configuration.status, 'started');
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 2);
  assert.equal(calls.find(call => call.method === 'turn/steer').params.input[0].text, 'Include the rollback plan');
  runtime.dispose();
});

test('a continuation completing before its start reply cannot replay its operation', async () => {
  const { state, runtime, rpc, calls, continuations, complete, request, threadId } = configurationSession();
  await runtime.send({ text: 'Prepare the migration' });
  const sourceTurnId = runtime.activeTurnId;
  const originalRequest = rpc.request;
  rpc.request = async (method, params) => {
    const result = await originalRequest(method, params);
    if (method === 'turn/start') {
      rpc.onMessage('turn/started', { threadId, turn: { id: sourceTurnId } });
      rpc.onMessage('turn/completed', { threadId, turn: { id: sourceTurnId, status: 'completed' } });
      rpc.onMessage('turn/completed', { threadId, turn: { id: result.turn.id, status: 'completed' } });
    }
    return result;
  };
  await runtime.queueConfiguration({ ...request(), selection: { ...state.selection } }, () => true);
  complete();
  await until(() => runtime.getSessionControl().configuration.status === 'started');
  await Promise.all(continuations);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(continuations.length, 1);
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 2);
  assert.equal(runtime.active, false);
  runtime.dispose();
});

test('deferred configuration bounds operation history without replaying a retired source turn', async () => {
  const { runtime, continuations, complete, request } = configurationSession();
  await runtime.send({ text: 'Prepare the migration' });
  const first = request('profile-0');
  for (let index = 0; index < 64; index++) {
    await runtime.queueConfiguration(request(`profile-${index}`), () => true);
    runtime.cancelConfiguration('Profile no longer needed');
  }
  await assert.rejects(runtime.queueConfiguration(request('profile-overflow'), () => true), /Too many/);
  assert.equal((await runtime.queueConfiguration(first, () => true)).status, 'cancelled');
  complete();
  await runtime.send({ text: 'Prepare another migration' });
  await runtime.queueConfiguration(request('profile-next-turn'), () => true);
  runtime.cancelConfiguration('Profile no longer needed');
  await assert.rejects(runtime.queueConfiguration(first, () => true), /source turn/);
  assert.equal(continuations.length, 0);
  runtime.dispose();
});

test('new conversations default to Codex and GPT-6-Luna without a saved selection', () => {
  assert.deepEqual(defaultSelection(), { providerId: 'codex', model: 'gpt-6-luna', effort: '', thinking: true });
  assert.deepEqual(selectionFor(undefined, dir), defaultSelection());
  // A provider with no first-run model of its own defers to that provider's default
  // instead of inheriting another provider's model id.
  assert.deepEqual(defaultSelection('scub-provider'), { providerId: 'scub-provider', model: '', effort: '', thinking: true });
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

test('background notices and stale turns do not extend the active turn watchdog', () => {
  const state = createSessionState(dir); state.broadcast = () => {};
  const runtime = new CodexSession(state, { dispose() {} });
  runtime.threadId = 'current-thread'; runtime.turnId = 'current-turn'; runtime.busy = true;
  try {
    runtime.armIdleTimer();
    const firstTimer = runtime.idleTimer;
    runtime.receive('account/rateLimits/updated', { threadId: 'current-thread' });
    assert.equal(runtime.idleTimer, firstTimer);
    runtime.receive('item/started', { threadId: 'current-thread', turnId: 'old-turn', item: { id: 'old-item', type: 'commandExecution' } });
    assert.equal(runtime.idleTimer, firstTimer);
    runtime.receive('turn/started', { threadId: 'current-thread', turn: { id: 'old-turn' } });
    assert.equal(runtime.idleTimer, firstTimer);
    assert.equal(runtime.turnId, 'current-turn');
    runtime.receive('item/agentMessage/delta', { threadId: 'current-thread', turnId: 'current-turn', itemId: 'reply', delta: 'Working' });
    assert.notEqual(runtime.idleTimer, firstTimer);
  } finally { runtime.dispose(); }
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

test('output tokens accumulate across model calls in one turn', async () => {
  const { state, events, runtime } = session();
  await runtime.send({ text: 'scub-multi-usage' }); await until(() => !runtime.active);
  assert.equal(state.liveInputTokens, 120);
  assert.equal(state.completedOutputTokens, 13);
  assert.equal(events.filter(event => event.type === 'token_update').at(-1).outputTokens, 13);
  assert.equal(events.filter(event => event.type === 'contextUsage').at(-1).outputTokens, 5);
  await runtime.send({ text: 'scub-multi-usage' }); await until(() => !runtime.active);
  assert.equal(state.completedOutputTokens, 13);
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

test('a steered image remains in the inline request event', async () => {
  const { state, events, runtime } = session();
  await runtime.send({ text: 'pause-for-image' });
  await until(() => !!state.interaction?.async);
  const image = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XioAAAAASUVORK5CYII=', mediaType: 'image/png' };
  await runtime.send({ text: 'Inspect this diagram', images: [image] });
  assert.deepEqual(events.find(event => event.type === 'user_inject'), { type: 'user_inject', text: 'Inspect this diagram', images: [image] });
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

test('history keeps subagent identities and activity transitions', () => {
  const replay = replayThread({ turns: [{ id: 'scub-turn', items: [
    { type: 'userMessage', id: 'scub-user', content: [{ type: 'text', text: 'scub-request' }] },
    { type: 'subAgentActivity', id: 'scub-start', kind: 'started', agentThreadId: 'scub-child', agentPath: '/root/scub_child' },
    { type: 'subAgentActivity', id: 'scub-done', kind: 'completed', agentThreadId: 'scub-child', agentPath: '/root/scub_child' },
  ] }] });
  const calls = replay[1].blocks.map(block => block.call);
  assert.deepEqual(calls.map(call => call.kind), ['subAgentActivity', 'subAgentActivity']);
  assert.deepEqual(calls.map(call => call.input.activity), ['started', 'completed']);
  assert.equal(calls[0].input.agentThreadId, 'scub-child');
});

test('only a started child of the viewed parent can be opened', () => {
  const thread = { turns: [{ items: [
    { type: 'subAgentActivity', kind: 'started', agentThreadId: 'scub-child' },
    { type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'scub-parent' },
  ] }] };
  assert.equal(linksSubagent(thread, 'scub-child'), true);
  assert.equal(linksSubagent(thread, 'scub-parent'), false);
  assert.equal(linksSubagent(thread, 'scub-stranger'), false);
});

test('a fresh thread read replaces stale active subagent status', () => {
  const thread = { turns: [{ items: [
    { type: 'subAgentActivity', kind: 'started', agentThreadId: 'scub-child', agentPath: '/root/scub_child' },
    { type: 'subAgentActivity', kind: 'completed', agentThreadId: 'scub-child', agentPath: '/root/scub_child' },
  ] }] };
  assert.deepEqual(subagentsInThread(thread), [{ id: 'scub-child', path: '/root/scub_child', active: false }]);
});

test('live subagent events retain their identities', async () => {
  const { events, runtime } = session();
  await runtime.send({ text: 'scub-subagent' }); await until(() => !runtime.active);
  const calls = events.filter(event => event.type === 'tool_start' && event.call.kind === 'subAgentActivity').map(event => event.call);
  assert.deepEqual(calls.map(call => call.input.activity), ['started', 'completed']);
  assert.equal(calls[0].input.agentThreadId, 'scub-child');
});

test('replay identifies an interrupted turn with an unfinished tool', () => {
  const messages = replayThread({ turns: [{ id: 'turn-one', status: 'interrupted', items: [
    { id: 'request-one', type: 'userMessage', content: [{ type: 'text', text: 'Check the status' }] },
    { id: 'reply-one', type: 'agentMessage', text: 'Checking now.' },
    { id: 'tool-one', type: 'commandExecution', command: 'status', status: 'inProgress' },
  ] }] });
  assert.equal(messages.at(-1).outcome, 'stopped');
  const completed = replayThread({ turns: [{ id: 'turn-two', status: 'completed', items: [
    { id: 'request-two', type: 'userMessage', content: [{ type: 'text', text: 'Check the status' }] },
    { id: 'reply-two', type: 'agentMessage', text: 'All clear.' },
  ] }] });
  assert.equal(completed.at(-1).outcome, undefined);
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

test('large conversation history survives the provider transport', async () => {
  const chars = 34 * 1024 * 1024;
  const server = String.raw`require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const message = JSON.parse(line);
    if (message.id) process.stdout.write(JSON.stringify({id:message.id,result:message.method === 'initialize' ? {} : {history:'x'.repeat(${chars})}}) + '\n');
  })`;
  const rpc = new AppServerRpc(process.execPath, ['-e', server]);
  const failures = [];
  rpc.onFailure = error => failures.push(error.message);
  try {
    await rpc.start();
    const result = await rpc.request('thread/read', { threadId: 'large-history', includeTurns: true });
    assert.equal(result.history.length, chars);
    assert.deepEqual(failures, []);
    assert.deepEqual(await rpc.request('initialize'), {});
  } finally { rpc.dispose(); }
});

test('history fetches newest items and carries turn status across reverse pages', async () => {
  const requests = [];
  const responses = [
    { data: [{ id: 'recent-turn', status: 'interrupted' }], nextCursor: 'older-turns' },
    { data: [{ item: { id: 'last-item', type: 'agentMessage', text: 'Latest' } }, { item: { id: 'middle-item', type: 'agentMessage', text: 'Middle' } }], nextCursor: 'earlier-items' },
    { data: [{ item: { id: 'first-item', type: 'userMessage', content: [] } }], nextCursor: null },
    { data: [{ id: 'older-turn', status: 'completed' }], nextCursor: null },
    { data: [], nextCursor: null },
  ];
  const rpc = { request: async (method, params) => { requests.push({ method, params }); return responses.shift(); } };
  const recent = await readHistoryItems(rpc, 'history-thread');
  assert.deepEqual(recent.turn.items.map(item => item.id), ['middle-item', 'last-item']);
  assert.equal(recent.turn.status, 'interrupted');
  const earlier = await readHistoryItems(rpc, 'history-thread', recent.cursor);
  assert.deepEqual(earlier.turn.items.map(item => item.id), ['first-item']);
  assert.equal(earlier.turn.status, undefined, 'the stopped marker belongs only to the newest slice of a turn');
  const oldest = await readHistoryItems(rpc, 'history-thread', earlier.cursor);
  assert.equal(oldest.cursor, undefined);
  assert.deepEqual(requests.map(request => request.method), ['thread/turns/list', 'thread/items/list', 'thread/items/list', 'thread/turns/list', 'thread/items/list']);
  assert.equal(requests[0].params.itemsView, 'notLoaded');
  assert.equal(requests[1].params.sortDirection, 'desc');
  assert.equal(requests[1].params.limit, 30);
  assert.equal(requests[2].params.cursor, 'earlier-items');
  assert.equal(requests[3].params.cursor, 'older-turns');
});
