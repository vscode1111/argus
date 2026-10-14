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
