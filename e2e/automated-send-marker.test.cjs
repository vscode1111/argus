const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');

// A script that talks to Argus directly (an ad-hoc relay, not the orchestrate skill's
// control.js) used to send automatic requests that rendered as the user's own: nothing
// marked them, because only control.js and queueSessionConfiguration add the marker.
// The server now marks a send from any socket that is not an Argus UI. The UI socket is
// the control: a build that marked every send would fail it.
test('a send from a script carries the automatic marker and a UI send does not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-automated-send-'));
  process.env.ARGUS_CONFIG = path.join(dir, 'settings.json');
  process.env.ARGUS_ORCHESTRATOR_RUNS = path.join(dir, 'runs');
  process.env.ARGUS_USAGE_POLL = '0';
  process.env.ARGUS_MODEL_REFRESH = '0';
  const { startServer } = require('../out/backend/index');
  const { providers } = require('../out/backend/providers/registry');
  const { CodexSession } = require('../out/backend/providers/codex');
  const nativeProvider = providers().find(p => p.descriptor.id === 'codex');
  const previousCreate = nativeProvider.createSession;
  const previousValidate = nativeProvider.validate;
  const turns = [];
  const runtimes = [];
  const rpc = {
    start: async () => {}, dispose: () => {},
    request: async (method, input) => {
      if (method === 'thread/start') return { thread: { id: randomUUID() } };
      if (method === 'turn/start') { turns.push(input); return { turn: { id: `scub-turn-${turns.length}` } }; }
      throw new Error(`Unexpected native request: ${method}`);
    },
  };
  nativeProvider.validate = async () => {};
  nativeProvider.createSession = state => { const r = new CodexSession(state, rpc, nativeProvider.validate); runtimes.push(r); return r; };
  const server = await startServer({ port: 0 });
  const sockets = [];
  const open = async (panel, options) => {
    const url = new URL(`ws://127.0.0.1:${server.port}/agent`);
    url.searchParams.set('nonce', server.nonce);
    url.searchParams.set('dir', dir);
    url.searchParams.set('panel', panel);
    const ws = new WebSocket(url, options);
    ws.seen = [];
    ws.on('message', raw => ws.seen.push(JSON.parse(raw.toString())));
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return ws;
  };
  const until = async (predicate, label) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const turnText = i => turns[i].input.find(b => b.type === 'text')?.text;
  const echoed = ws => ws.seen.filter(m => m.type === 'message' && m.message?.role === 'user').map(m => m.message.content);
  // Each socket gets its own Codex conversation, one turn at a time.
  const sendAndFinish = async (ws, text) => {
    ws.send(JSON.stringify({ type: 'configureSession', providerId: 'codex', model: 'scub-model' }));
    await until(() => ws.seen.some(m => m.type === 'sessionConfigured' || m.type === 'providerError'), 'configureSession');
    const before = turns.length;
    ws.send(JSON.stringify({ type: 'send', text, mode: 'plan' }));
    await until(() => turns.length === before + 1, 'turn/start');
    const runtime = runtimes[runtimes.length - 1];
    runtime.receive('turn/completed', { threadId: turns[before].threadId, turn: { id: `scub-turn-${before + 1}`, status: 'completed' } });
    return turnText(before);
  };
  try {
    // Node's built-in WebSocket, which relays and control.js use, sends no Origin.
    const script = await open('scub-script');
    assert.equal(await sendAndFinish(script, 'scub-script request'), '🤖 scub-script request');
    assert.deepEqual(echoed(script), ['🤖 scub-script request']);

    const skill = await open('scub-skill');
    assert.equal(await sendAndFinish(skill, '$orchestrate -i 47: scub-relay request'), '$orchestrate 🤖 -i 47: scub-relay request');

    const marked = await open('scub-marked');
    assert.equal(await sendAndFinish(marked, '$orchestrate 🤖 scub-already marked'), '$orchestrate 🤖 scub-already marked');

    const ui = await open('scub-ui', { origin: 'http://localhost:5173' });
    assert.equal(await sendAndFinish(ui, 'scub-typed by hand'), 'scub-typed by hand');
    assert.deepEqual(echoed(ui), ['scub-typed by hand']);
  } finally {
    for (const ws of sockets) ws.terminate();
    for (const r of runtimes) r.dispose();
    nativeProvider.createSession = previousCreate;
    nativeProvider.validate = previousValidate;
    server.close();
    require('../out/backend/sessionStats').closeStatsDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
