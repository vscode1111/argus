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
const live = [];
after(() => { for (const runtime of live) runtime.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
function session(validate = async () => {}) {
  const state = createSessionState(dir); state.selection = defaultSelection('codex');
  const events = []; state.broadcast = text => events.push(JSON.parse(text));
  const rpc = new AppServerRpc(process.execPath, [path.join(__dirname, 'fixtures/scub-provider-server.cjs')]);
  const runtime = new CodexSession(state, rpc, validate); state.runtime = runtime; live.push(runtime);
  return { state, events, runtime };
}
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) assert.fail('scub condition timed out'); await new Promise(r => setTimeout(r, 10)); }
}

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

test('streamed text is not duplicated by the completed item; binding survives recreation', async () => {
  const { state, events, runtime } = session();
  await runtime.send({ text: 'scub-first' }); await until(() => !runtime.active);
  assert.equal(events.filter(e => e.type === 'text_chunk').map(e => e.text).join(''), 'scub-ok');
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(selectionFor(state.sessionId, dir).providerId, 'codex');
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
  writeConfig({ ...DEFAULT_CONFIG, model: 'scub-model', effort: 'high' });
  const first = createSessionState(dir); const second = createSessionState(dir);
  first.selection.model = 'scub-other'; assert.equal(second.selection.model, 'scub-model');
  assert.deepEqual(rateLimits({ rateLimits: { primary: null } }), []);
  assert.equal(rateLimits({ rateLimits: { primary: { usedPercent: 23, windowDurationMins: 300 } } })[0].utilization, 0.23);
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
