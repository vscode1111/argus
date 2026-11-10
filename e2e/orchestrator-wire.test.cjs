const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

test('Argus serves goals and configures a worker without changing defaults', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-orchestrator-wire-'));
  const runs = path.join(dir, 'runs');
  process.env.ARGUS_CONFIG = path.join(dir, 'settings.json');
  process.env.ARGUS_ORCHESTRATOR_RUNS = runs;
  process.env.ARGUS_USAGE_POLL = '0';
  process.env.ARGUS_MODEL_REFRESH = '0';
  const { startServer } = require('../out/backend/index');
  const { readConfig } = require('../out/backend/config');
  const { providers } = require('../out/backend/providers/registry');
  fs.mkdirSync(path.join(runs, 'scub-company'), { recursive: true });
  fs.writeFileSync(path.join(runs, 'scub-company', 'scub-goal.goal.json'), JSON.stringify({ company: 'scub-company', goal: 'scub-goal', title: 'scub-goal-title', status: 'active', updatedAt: Date.now() }));
  const server = await startServer({ port: 0 });
  const url = new URL(`ws://127.0.0.1:${server.port}/agent`);
  url.searchParams.set('nonce', server.nonce);
  url.searchParams.set('dir', dir);
  url.searchParams.set('panel', 'scub-panel');
  const ws = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const request = (message, type, socket = ws) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('scub-reply-timeout')); }, 5000);
      const receive = raw => {
        const value = JSON.parse(raw.toString());
        if (value.type !== type) return;
        clearTimeout(timer); socket.off('message', receive); resolve(value);
      };
      socket.on('message', receive);
      socket.send(JSON.stringify(message));
    });
    const goals = await request({ type: 'getOrchestratorGoals' }, 'orchestratorGoals');
    assert.equal(goals.goals[0].title, 'scub-goal-title');
    const defaults = readConfig();
    const selected = await request({ type: 'configureSession', providerId: providers()[0].descriptor.id, model: 'scub-model', requestId: 'scub-choice' }, 'sessionConfigured');
    assert.equal(selected.selection.model, 'scub-model');
    assert.equal(selected.requestId, 'scub-choice');
    assert.deepEqual(readConfig(), defaults);

    const { CodexSession } = require('../out/backend/providers/codex');
    const { randomUUID } = require('node:crypto');
    const nativeProvider = providers().find(p => p.descriptor.id === 'codex');
    const previousCreate = nativeProvider.createSession;
    const previousValidate = nativeProvider.validate;
    const turns = [];
    const threadId = randomUUID();
    let activeRuntime;
    let queueSocket;
    const rpc = {
      start: async () => {}, dispose: () => {},
      request: async (method, input) => {
        if (method === 'thread/start') return { thread: { id: threadId } };
        if (method === 'turn/start') {
          turns.push(input);
          return { turn: { id: `catalog-turn-${turns.length}` } };
        }
        throw new Error(`Unexpected native request: ${method}`);
      },
    };
    nativeProvider.validate = async () => {};
    nativeProvider.createSession = state => (activeRuntime = new CodexSession(state, rpc, nativeProvider.validate));
    const waitFor = async predicate => {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, 'Expected conversation transition');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    try {
      await request({ type: 'configureSession', providerId: nativeProvider.descriptor.id, model: 'catalog-engine', effort: 'low' }, 'sessionConfigured');
      ws.send(JSON.stringify({ type: 'send', text: 'Inspect the catalog.', mode: 'plan' }));
      await waitFor(() => activeRuntime?.activeTurnId === 'catalog-turn-1');
      const current = await request({ type: 'getSessionControl', requestId: 'catalog-control' }, 'sessionControl');
      assert.equal(current.requestId, 'catalog-control');
      assert.equal(current.capabilities.configureAfterTurn, true);
      assert.equal(current.activeSelection.model, 'catalog-engine');
      const controllerUrl = new URL(url);
      controllerUrl.searchParams.set('session', current.sessionId);
      controllerUrl.searchParams.delete('panel');
      queueSocket = new WebSocket(controllerUrl);
      await new Promise((resolve, reject) => { queueSocket.once('open', resolve); queueSocket.once('error', reject); });
      const queuedRequest = { type: 'queueSessionConfiguration', operationId: 'catalog-switch', expectedTurnId: current.activeTurnId,
        model: 'catalog-review-engine', effort: 'high', continuation: 'Continue the catalog audit.', mode: 'full-access' };
      const queued = await request(queuedRequest, 'sessionConfigurationQueued', queueSocket);
      assert.equal(queued.configuration.status, 'queued');
      const duplicate = await request(queuedRequest, 'sessionConfigurationQueued', queueSocket);
      assert.deepEqual(duplicate.configuration, queued.configuration);
      assert.equal(turns.length, 1);
      await new Promise(resolve => { queueSocket.once('close', resolve); queueSocket.close(); });
      activeRuntime.receive('turn/completed', { threadId, turn: { id: current.activeTurnId, status: 'completed' } });
      await waitFor(() => activeRuntime.activeTurnId === 'catalog-turn-2');
      const resumed = await request({ type: 'getSessionControl' }, 'sessionControl');
      assert.equal(resumed.sessionId, current.sessionId);
      assert.equal(resumed.configuration.status, 'started');
      assert.equal(resumed.activeSelection.model, queuedRequest.model);
      assert.equal(resumed.activeSelection.effort, queuedRequest.effort);
      assert.equal(turns.length, 2);
      assert.equal(turns[1].threadId, turns[0].threadId);
      assert.deepEqual(turns[1].input, [{ type: 'text', text: `🤖 ${queuedRequest.continuation}` }]);
      assert.equal(turns[1].approvalPolicy, turns[0].approvalPolicy);
      assert.deepEqual(turns[1].sandboxPolicy, { type: 'readOnly' });
      assert.deepEqual(readConfig(), defaults);
      activeRuntime.receive('turn/completed', { threadId, turn: { id: resumed.activeTurnId, status: 'completed' } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(turns.length, 2);
    } finally {
      queueSocket?.terminate();
      activeRuntime?.dispose();
      nativeProvider.createSession = previousCreate;
      nativeProvider.validate = previousValidate;
    }
  } finally {
    ws.close();
    await new Promise(resolve => { ws.once('close', resolve); setTimeout(resolve, 1000); });
    server.close();
    require('../out/backend/sessionStats').closeStatsDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
