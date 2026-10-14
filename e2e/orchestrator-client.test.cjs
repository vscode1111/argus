const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { WebSocketServer } = require('ws');

const script = path.join(__dirname, '../orchestrator/scripts/control.js');

test('controller registers a goal and runs a named worker with session-only selection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-orchestrator-'));
  const runs = path.join(dir, 'runs');
  const discoveryFile = path.join(dir, 'daemon.json');
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/agent' });
  const frames = [];
  let pendingInteraction;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    fs.writeFileSync(discoveryFile, JSON.stringify({ port, nonce: 'a'.repeat(32), pid: process.pid }));
    const env = { ...process.env, ARGUS_DAEMON_FILE: discoveryFile, ARGUS_ORCHESTRATOR_RUNS: runs };
    const goal = spawnSync(process.execPath, [script, 'goal', '--company', 'scub-company', '--goal', 'scub-goal', '--title', 'scub-overall-work'], { env, encoding: 'utf8' });
    assert.equal(goal.status, 0, goal.stderr);
    wss.on('connection', ws => ws.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame);
      if (frame.type === 'webviewReady' && pendingInteraction) ws.send(JSON.stringify({ type: 'interaction', request: pendingInteraction }));
      if (frame.type === 'configureSession') ws.send(JSON.stringify({ type: 'sessionConfigured', requestId: frame.requestId, selection: { providerId: frame.providerId, model: frame.model, effort: '', thinking: true } }));
      if (frame.type === 'send') {
        ws.send(JSON.stringify({ type: 'sessionId', id: 'scub-session-id' }));
        if (frame.text === '🤖 scub-question') {
          pendingInteraction = { id: 'scub-interaction', kind: 'question', title: 'scub-question' };
          ws.send(JSON.stringify({ type: 'interaction', request: pendingInteraction }));
        }
        else { ws.send(JSON.stringify({ type: 'text_chunk', text: 'scub-result' })); ws.send(JSON.stringify({ type: 'done' })); }
      }
      if (frame.type === 'renameSession') ws.send(JSON.stringify({ type: 'sessionList', requestId: frame.requestId, sessions: [] }));
      if (frame.type === 'listSessions') ws.send(JSON.stringify({ type: 'sessionList', requestId: frame.requestId, sessions: [{ id: 'scub-session-id', title: 'scub-task-title' }] }));
      if (frame.type === 'providerResponse') {
        pendingInteraction = undefined;
        ws.send(JSON.stringify({ type: 'providerResponseAccepted', requestId: frame.requestId }));
        ws.send(JSON.stringify({ type: 'text_chunk', text: 'scub-resumed-result' }));
        ws.send(JSON.stringify({ type: 'done' }));
      }
      if (frame.type === 'getActiveSessions') ws.send(JSON.stringify({ type: 'activeSessions', sessions: [] }));
    }));
    const child = spawn(process.execPath, [script, 'run', '--company', 'scub-company', '--goal', 'scub-goal', '--key', 'scub-task',
      '--title', 'scub-task-title', '--provider', 'scub-provider', '--model', 'scub-model', '--text', 'scub-request'], { env, cwd: dir });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /scub-result/);
    assert.equal(frames.find(frame => frame.type === 'configureSession').model, 'scub-model');
    assert.equal(frames.find(frame => frame.type === 'send').mode, 'full-access');
    assert.equal(frames.find(frame => frame.type === 'send').text, '🤖 scub-request');
    assert.equal(frames.find(frame => frame.type === 'renameSession').title, 'scub-task-title');
    const checkpoint = JSON.parse(fs.readFileSync(path.join(runs, 'scub-company', 'scub-task.json'), 'utf8'));
    assert.equal(checkpoint.status, 'idle');
    assert.equal(checkpoint.goal, 'scub-goal');
    assert.equal(checkpoint.workspace, dir);
    assert.equal(checkpoint.sessionId, 'scub-session-id');
    const status = spawn(process.execPath, [script, 'status', '--company', 'scub-company'], { env });
    let statusOutput = '';
    status.stdout.on('data', chunk => { statusOutput += chunk; });
    const statusCode = await new Promise((resolve, reject) => { status.on('exit', resolve); status.on('error', reject); });
    assert.equal(statusCode, 0);
    assert.equal(JSON.parse(statusOutput).find(record => record.key === 'scub-task').live, false);
    process.env.ARGUS_ORCHESTRATOR_RUNS = runs;
    const { listOrchestratorGoals } = require('../out/backend/orchestratorGoals');
    const listed = listOrchestratorGoals();
    assert.equal(listed[0].workers[0].title, 'scub-task-title');

    const question = spawn(process.execPath, [script, 'send', '--company', 'scub-company', '--key', 'scub-task', '--mode', 'edit', '--text', 'scub-question'], { env });
    let questionOutput = '';
    question.stdout.on('data', chunk => { questionOutput += chunk; });
    const questionCode = await new Promise((resolve, reject) => { question.on('exit', resolve); question.on('error', reject); });
    assert.equal(questionCode, 0);
    assert.match(questionOutput, /needs-input/);
    assert.equal(frames.filter(frame => frame.type === 'send').at(-1).mode, 'edit');
    assert.equal(frames.filter(frame => frame.type === 'send').at(-1).text, '🤖 scub-question');
    const inspection = spawn(process.execPath, [script, 'inspect', '--company', 'scub-company', '--key', 'scub-task'], { env });
    let inspectionOutput = '';
    inspection.stdout.on('data', chunk => { inspectionOutput += chunk; });
    const inspectionCode = await new Promise((resolve, reject) => { inspection.on('exit', resolve); inspection.on('error', reject); });
    assert.equal(inspectionCode, 0);
    assert.equal(JSON.parse(inspectionOutput).pendingInteraction.id, 'scub-interaction');
    const answer = spawn(process.execPath, [script, 'respond', '--company', 'scub-company', '--key', 'scub-task', '--id', 'scub-interaction', '--response', '{"answers":{"scub-question":"scub-answer"}}'], { env });
    let answerOutput = '';
    answer.stdout.on('data', chunk => { answerOutput += chunk; });
    const answerCode = await new Promise((resolve, reject) => { answer.on('exit', resolve); answer.on('error', reject); });
    assert.equal(answerCode, 0);
    assert.match(answerOutput, /scub-resumed-result/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runs, 'scub-company', 'scub-task.json'), 'utf8')).status, 'idle');
    assert.deepEqual(frames.find(frame => frame.type === 'providerResponse').response, { answers: { 'scub-question': 'scub-answer' } });
    const skill = spawn(process.execPath, [script, 'send', '--company', 'scub-company', '--key', 'scub-task', '--text', '/scub-skill scub-request'], { env });
    let skillError = '';
    skill.stderr.on('data', chunk => { skillError += chunk; });
    assert.equal(await new Promise((resolve, reject) => { skill.on('exit', resolve); skill.on('error', reject); }), 0, skillError);
    assert.equal(frames.filter(frame => frame.type === 'send').at(-1).text, '/scub-skill 🤖 scub-request');
    const marked = spawn(process.execPath, [script, 'send', '--company', 'scub-company', '--key', 'scub-task', '--text', '/scub-skill 🤖 scub-request'], { env });
    let markedError = '';
    marked.stderr.on('data', chunk => { markedError += chunk; });
    assert.equal(await new Promise((resolve, reject) => { marked.on('exit', resolve); marked.on('error', reject); }), 0, markedError);
    assert.equal(frames.filter(frame => frame.type === 'send').at(-1).text, '/scub-skill 🤖 scub-request');
  } finally {
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
