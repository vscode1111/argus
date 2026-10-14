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
    const request = (message, type) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.off('message', receive); reject(new Error('scub-reply-timeout')); }, 5000);
      const receive = raw => {
        const value = JSON.parse(raw.toString());
        if (value.type !== type) return;
        clearTimeout(timer); ws.off('message', receive); resolve(value);
      };
      ws.on('message', receive);
      ws.send(JSON.stringify(message));
    });
    const goals = await request({ type: 'getOrchestratorGoals' }, 'orchestratorGoals');
    assert.equal(goals.goals[0].title, 'scub-goal-title');
    const defaults = readConfig();
    const selected = await request({ type: 'configureSession', providerId: providers()[0].descriptor.id, model: 'scub-model', requestId: 'scub-choice' }, 'sessionConfigured');
    assert.equal(selected.selection.model, 'scub-model');
    assert.equal(selected.requestId, 'scub-choice');
    assert.deepEqual(readConfig(), defaults);
  } finally {
    ws.close();
    await new Promise(resolve => { ws.once('close', resolve); setTimeout(resolve, 1000); });
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
