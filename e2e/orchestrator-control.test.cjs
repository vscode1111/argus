const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-session-control-'));
process.env.ARGUS_CONFIG = path.join(dir, 'settings.json');
const { handleProviderRequest } = require('../out/backend/providers/requests');
const { createSessionState } = require('../out/backend/sessionState');
const { defaultSelection } = require('../out/backend/providers/store');
const { readConfig } = require('../out/backend/config');
const { providers } = require('../out/backend/providers/registry');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture() {
  const frames = [];
  const ws = { readyState: 1, send: frame => frames.push(JSON.parse(frame)) };
  const state = createSessionState(dir);
  state.selection = defaultSelection(providers()[0].descriptor.id);
  state.broadcast = frame => frames.push(JSON.parse(frame));
  const channel = { getClientState: () => state, getViewingSessionId: () => undefined };
  return { frames, ws, state, channel };
}

test('session configuration changes one entry without changing defaults', async () => {
  const { frames, ws, state, channel } = fixture();
  const defaults = readConfig();
  await handleProviderRequest(ws, channel, { type: 'configureSession', model: 'scub-model', requestId: 'scub-request' }, () => {});
  assert.equal(state.selection.model, 'scub-model');
  assert.equal(frames.find(frame => frame.type === 'sessionConfigured').requestId, 'scub-request');
  assert.equal(frames.find(frame => frame.type === 'providerSelection').model, 'scub-model');
  assert.deepEqual(readConfig(), defaults);
  assert.notEqual(fixture().state.selection.model, 'scub-model');
});

test('configuration rejects bad values and active turns without mutation', async () => {
  const { frames, ws, state, channel } = fixture();
  const original = { ...state.selection };
  await handleProviderRequest(ws, channel, { type: 'configureSession', model: { bad: true } }, () => {});
  assert.deepEqual(state.selection, original);
  assert.equal(frames.at(-1).error, true);
  state.runtime = { active: true };
  await handleProviderRequest(ws, channel, { type: 'configureSession', model: 'scub-other' }, () => {});
  assert.deepEqual(state.selection, original);
  assert.match(frames.at(-1).message, /active turn/i);
});

test('interaction response is acknowledged only after the session accepts it', async () => {
  const { frames, ws, state, channel } = fixture();
  const accepted = [];
  state.runtime = { respond: (id, response) => accepted.push({ id, response }) };
  await handleProviderRequest(ws, channel, { type: 'providerResponse', id: 'scub-interaction', response: { decision: 'accept' }, requestId: 'scub-response' }, () => {});
  assert.deepEqual(accepted, [{ id: 'scub-interaction', response: { decision: 'accept' } }]);
  assert.equal(frames.at(-1).type, 'providerResponseAccepted');
  assert.equal(frames.at(-1).requestId, 'scub-response');
});

test('session control distinguishes the running selection from the next selection', async () => {
  const { frames, ws, state, channel } = fixture();
  const activeSelection = { ...state.selection, model: 'catalog-engine', effort: 'high' };
  state.runtime = { active: true, getSessionControl: () => ({ activeTurnId: 'catalog-turn', activeSelection }), queueConfiguration: async () => {} };
  await handleProviderRequest(ws, channel, { type: 'getSessionControl', requestId: 'catalog-control' }, () => {});
  assert.deepEqual(frames.at(-1), { providerId: state.selection.providerId, requestId: 'catalog-control',
    type: 'sessionControl', selection: state.selection, active: true, activeTurnId: 'catalog-turn', activeSelection,
    capabilities: { configureAfterTurn: true } });
  channel.getViewingSessionId = () => 'archive-conversation';
  await handleProviderRequest(ws, channel, { type: 'getSessionControl' }, () => {});
  assert.equal(frames.at(-1).error, true);
});

test('deferred configuration acknowledges a queue without applying it or changing defaults', async () => {
  const { frames, ws, state, channel } = fixture();
  const defaults = readConfig();
  const original = { ...state.selection };
  const requested = { type: 'queueSessionConfiguration', operationId: 'catalog-switch', expectedTurnId: 'catalog-turn',
    model: 'catalog-engine', effort: 'high', continuation: 'Continue the catalog audit.', requestId: 'catalog-request', mode: 'full-access' };
  let received;
  const configuration = { operationId: requested.operationId, sourceTurnId: requested.expectedTurnId,
    status: 'queued', selection: { ...original, model: requested.model, effort: requested.effort } };
  state.runtime = { active: true, queueConfiguration: async (input, isCurrent) => {
    received = input;
    assert.equal(isCurrent(), true);
    channel.getClientState = () => fixture().state;
    assert.equal(isCurrent(), false);
    channel.getClientState = () => state;
    return configuration;
  } };
  await handleProviderRequest(ws, channel, requested, () => {});
  assert.deepEqual(received, { operationId: requested.operationId, expectedTurnId: requested.expectedTurnId,
    selection: configuration.selection, continuation: requested.continuation });
  assert.deepEqual(frames.at(-1), { providerId: original.providerId, requestId: requested.requestId,
    type: 'sessionConfigurationQueued', configuration });
  assert.deepEqual(state.selection, original);
  assert.deepEqual(readConfig(), defaults);
});

test('deferred configuration rejects malformed, unsupported and browsed requests', async () => {
  const { frames, ws, state, channel } = fixture();
  const requested = { type: 'queueSessionConfiguration', operationId: 'catalog-switch', expectedTurnId: 'catalog-turn',
    model: 'catalog-engine', effort: 'high', continuation: 'Continue the catalog audit.' };
  let calls = 0;
  state.runtime = { active: true, queueConfiguration: async () => { calls++; } };
  for (const key of ['operationId', 'expectedTurnId', 'model', 'effort', 'continuation']) {
    for (const value of [undefined, {}, '', ' ']) {
      await handleProviderRequest(ws, channel, { ...requested, [key]: value }, () => {});
      assert.equal(frames.at(-1).error, true, `${key}: ${JSON.stringify(value)}`);
    }
  }
  await handleProviderRequest(ws, channel, { ...requested, continuation: 'x'.repeat(65537) }, () => {});
  assert.equal(frames.at(-1).error, true);
  await handleProviderRequest(ws, channel, { ...requested, providerId: 'unavailable-provider' }, () => {});
  assert.equal(frames.at(-1).error, true);
  channel.getViewingSessionId = () => 'archive-conversation';
  await handleProviderRequest(ws, channel, requested, () => {});
  assert.equal(frames.at(-1).error, true);
  channel.getViewingSessionId = () => undefined;
  state.runtime = { active: true };
  await handleProviderRequest(ws, channel, requested, () => {});
  assert.match(frames.at(-1).message, /does not support/);
  assert.equal(calls, 0);
});

test('idle configuration cannot dispose a turn that starts during validation', async () => {
  const { frames, ws, state, channel } = fixture();
  const selected = providers().find(p => p.descriptor.id === state.selection.providerId);
  const validate = selected.validate;
  const original = { ...state.selection };
  let disposed = false;
  selected.validate = async () => { state.runtime = { active: true, dispose: () => { disposed = true; } }; };
  try {
    await handleProviderRequest(ws, channel, { type: 'configureSession', model: 'catalog-engine' }, () => {});
    assert.match(frames.at(-1).message, /active turn/i);
    assert.deepEqual(state.selection, original);
    assert.equal(disposed, false);
  } finally { selected.validate = validate; }
});

test('a manual selection cancels queued configuration before asynchronous validation', async () => {
  const { ws, state, channel } = fixture();
  const selected = providers().find(p => p.descriptor.id === state.selection.providerId);
  const validate = selected.validate;
  const order = [];
  state.runtime = { active: true, cancelConfiguration: reason => order.push(reason) };
  selected.validate = async () => { order.push('validate'); throw new Error('Unavailable selection'); };
  try {
    await handleProviderRequest(ws, channel, { type: 'switchModel', model: 'catalog-engine' }, () => {});
    assert.deepEqual(order, ['Session selection changed', 'validate']);
  } finally { selected.validate = validate; }
});
