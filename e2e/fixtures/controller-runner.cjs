// Runs inside the fake native coordinator process subtree, inheriting its actual
// private entry identity. Output is assertions/counts only, never token or input.
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs'), { spawn } = require('node:child_process');
const script = process.env.ARGUS_TEST_CONTROLLER || process.env.ARGUS_CONTROLLER_SCRIPT;
if (!script || !process.env.ARGUS_DAEMON_FILE || !process.env.ARGUS_AGENT_TOKEN) throw Error('Explicit private controller and entry identity required');
const requests = process.env.ARGUS_FINAL_REQUESTS ? JSON.parse(process.env.ARGUS_FINAL_REQUESTS) : { hold: 'Hold inventory', steer: 'Choose inventory', answer: 'Stock' };
const selections = process.env.ARGUS_FINAL_SELECTIONS ? JSON.parse(process.env.ARGUS_FINAL_SELECTIONS) : { codex: { model: 'inventory-model', effort: 'low' }, claude: {} };
if (process.env.ARGUS_FINAL_REQUESTS && !process.env.ARGUS_FINAL_SELECTIONS) throw Error('Real scenario requires explicit provider selections');
const common = ['--company', 'inventory', '--goal', 'combined'];
let commands = 0, phase = 'setup', lastStatus;
function launch(action, args = [], input) {
  commands++;
  const child = spawn(process.execPath, [script, action, ...args], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  child.stdin.end(input);
  const done = new Promise((resolve, reject) => { const timer = setTimeout(() => child.kill(), 20000); child.on('exit', code => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(Error('Controller command failed: ' + action + ': ' + stderr.slice(0, 200))); }); });
  done.catch(() => {}); return { child, done };
}
const call = (action, args, input) => launch(action, args, input).done;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function inspect(key, predicate) {
  for (let i = 0; i < 60; i++) { try { const result = JSON.parse(await call('inspect', [...common, '--key', key])); lastStatus = { status: result.live.status, question: !!result.live.pendingInteraction }; if (predicate(result)) return result; } catch {} await sleep(100); }
  throw Error('Worker did not reach expected state');
}
(async () => {
  await call('goal', [...common, '--title', 'Inventory combined']);
  let questions = 0, watches = 0, steers = 0;
  for (const [provider, role] of [['codex', 'work'], ['claude', 'review']]) {
    phase = provider + ':run';
    const key = role;
    const running = launch('run', [...common, '--key', key, '--role', role, '--provider', provider, '--workspace', process.cwd(),
      ...Object.entries(selections[provider]).flatMap(([name, value]) => ['--' + name, value]), '--text-stdin'], requests.hold);
    const initial = await inspect(key, r => r.live.status === 'running');
    phase = provider + ':watch';
    const watched = await call('watch', ['--session', initial.sessionId, '--wait', '0']); assert.match(watched, /next/); watches++;
    phase = provider + ':steer'; await call('steer', [...common, '--key', key, '--text', requests.steer]); steers++;
    phase = provider + ':question';
    const pending = await inspect(key, r => !!r.live.pendingInteraction);
    phase = provider + ':run-settle'; await running.done; questions++; await sleep(2400);
    const q = pending.live.pendingInteraction;
    const response = q.async ? { text: requests.answer } : { answers: { [q.questions[0].id]: requests.answer } };
    phase = provider + ':respond'; const completed = await call('respond', [...common, '--key', key, '--id', q.id, '--response', JSON.stringify(response)]);
    assert.match(completed, /"status":"done"/);
    phase = provider + ':idle';
    await inspect(key, r => r.live.status === 'idle' || r.live.live === false);
    await sleep(5500); // Wait through the default edge interval before the next worker.
  }
  const stateRoot = process.env.ARGUS_ORCHESTRATOR_RUNS;
  assert.ok(!stateRoot || !fs.existsSync(path.join(stateRoot, 'inventory')), 'no default controller state files');
  process.stdout.write(JSON.stringify({ passed: true, questions, watches, steers, commands, defaultStateFiles: 0 }));
})().catch(error => { process.stdout.write(JSON.stringify({ passed: false, phase, lastStatus, errorKind: error.name })); process.exitCode = 1; });
