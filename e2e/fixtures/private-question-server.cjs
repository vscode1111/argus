const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { WebSocket } = require('ws');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function privateQuestionServer(options = {}) {
  const root = path.resolve(__dirname, '../..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-wire-'));
  const discovery = path.join(dir, 'daemon.json'), config = path.join(dir, 'settings.json');
  fs.writeFileSync(config, JSON.stringify({ defaultProvider: 'claude', watchdogEnabled: false, errorRetryEnabled: false }));
  const env = { ...process.env, ARGUS_CONFIG: config, ARGUS_AUTH_FILE: path.join(dir, 'auth.json'),
    ARGUS_STATS_FILE: path.join(dir, 'stats.jsonl'), ARGUS_STATS_DB: path.join(dir, 'stats.sqlite'), ARGUS_GRAPH_DB: path.join(dir, 'graph.sqlite'),
    ARGUS_DAEMON_FILE: discovery, ARGUS_ORCHESTRATOR_RUNS: path.join(dir, 'runs'), ARGUS_ENTRY_GRACE_MS: '100' };
  if (options.controllerScript) env.ARGUS_TEST_CONTROLLER = options.controllerScript;
  for (const key of Object.keys(env)) if (/^(CODEX_|CLAUDE|ANTHROPIC_|VSCODE_|ARGUS_AGENT_TOKEN$|ARGUS_DAEMON_PORT$)/.test(key)) delete env[key];
  const preload = process.env.ARGUS_TEST_SERVER_PRELOAD;
  const server = spawn(process.execPath, [...(preload ? ['--require', preload] : []), '--require', options.providerPreload || path.join(__dirname, 'question-spawn.cjs'),
    path.join(__dirname, 'identity-server.cjs'), discovery], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const spawns = [], sockets = []; server.on('message', message => spawns.push(message));
  const alive = () => { try { process.kill(server.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  async function close() {
    for (const socket of sockets) socket.terminate();
    if (server.exitCode === null && server.signalCode === null && alive()) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(server.pid)], { windowsHide: true, stdio: 'ignore' });
        else server.kill();
      } catch (error) { if (alive()) throw error; }
    }
    const end = Date.now() + 3000;
    while (alive() && Date.now() < end) await sleep(10);
    assert.equal(alive(), false, 'owned private server exited');
    await sleep(100); fs.rmSync(dir, { recursive: true, force: true });
  }
  try {
    const until = Date.now() + 5000;
    while (!fs.existsSync(discovery)) { assert.ok(Date.now() < until && server.exitCode === null, 'private server started'); await sleep(10); }
    const info = JSON.parse(fs.readFileSync(discovery, 'utf8'));
    const health = await (await fetch(`http://127.0.0.1:${info.port}/health`)).json();
    assert.equal(health.pid, server.pid); assert.equal(health.configPath.toLowerCase(), config.toLowerCase());
    assert.ok(info.port > 0); assert.equal(info.pid, server.pid);
    async function connect(workspace = dir, sessionId, panel) {
      assert.ok(path.resolve(workspace) === dir || path.resolve(workspace).startsWith(dir + path.sep));
      fs.mkdirSync(workspace, { recursive: true });
      const query = new URLSearchParams({ dir: workspace, nonce: info.nonce, client: 'browser' });
      if (sessionId) query.set('session', sessionId);
      if (panel) query.set('panel', panel);
      const ws = new WebSocket(`ws://127.0.0.1:${info.port}/agent?${query}`, { headers: { Origin: `http://127.0.0.1:${info.port}` } });
      sockets.push(ws); const frames = []; ws.on('message', value => frames.push(JSON.parse(String(value))));
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const wait = async (predicate, timeout = 3000) => {
        const end = Date.now() + timeout;
        while (!frames.some(predicate)) { assert.ok(Date.now() < end, 'expected private wire frame'); await sleep(5); }
        return frames.find(predicate);
      };
      return { ws, frames, wait, send: value => ws.send(JSON.stringify(value)) };
    }
    function verifySpawn() {
      const execution = spawns.find(s => s.hasIdentity); assert.ok(execution, 'real fake child spawned');
      assert.equal(execution.serverModule, path.join(root, 'out/backend/index.js')); assert.equal(execution.moduleLoaded, true);
      assert.equal(execution.serverHash, createHash('sha256').update(fs.readFileSync(execution.serverModule)).digest('hex'));
      assert.equal(execution.daemonPort, String(info.port));
    }
    return { info, dir, config, connect, close, verifySpawn, spawns };
  } catch (error) { await close(); throw error; }
}
module.exports = { privateQuestionServer };
