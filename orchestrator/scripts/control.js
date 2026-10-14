#!/usr/bin/env node
'use strict';

// A local Argus client. Discovery supplies the nonce at runtime; checkpoints contain
// only session metadata, never prompts, replies, or credentials.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const action = process.argv[2];
const args = {};
for (let i = 3; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!key.startsWith('--') || i + 1 >= process.argv.length) throw new Error(`Expected --name value, got ${key}`);
  args[key.slice(2)] = process.argv[i + 1];
}
const required = name => {
  if (!args[name]) throw new Error(`Missing --${name}`);
  return args[name];
};
const safe = value => {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(value)) throw new Error('Company and key must contain only letters, numbers, dots, underscores, or hyphens');
  return value;
};
const root = process.env.ARGUS_ORCHESTRATOR_RUNS || path.join(os.homedir(), '.agents', 'runs', 'orchestrate');
const company = action === 'rename-self' ? undefined : safe(required('company'));
const key = ['run', 'send', 'stop', 'inspect', 'respond'].includes(action) ? safe(required('key')) : undefined;
const checkpoint = key && path.join(root, company, `${key}.json`);
const goalKey = args.goal ? safe(args.goal) : undefined;

function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
function saveRecord(value) {
  fs.mkdirSync(path.dirname(checkpoint), { recursive: true, mode: 0o700 });
  const temp = `${checkpoint}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, checkpoint);
}
function discovery() {
  const file = process.env.ARGUS_DAEMON_FILE || path.join(os.homedir(), '.argus', 'daemon.json');
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(info.port) || !/^[a-f0-9]{32}$/.test(info.nonce)) throw new Error('Invalid Argus daemon discovery file');
  return info;
}
async function connect(workspace, sessionId, panelKey) {
  const { port, nonce } = discovery();
  const url = new URL(`ws://127.0.0.1:${port}/agent`);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('dir', workspace);
  if (sessionId) url.searchParams.set('session', sessionId);
  if (panelKey) url.searchParams.set('panel', `orchestrate-${crypto.createHash('sha256').update(panelKey).digest('hex').slice(0, 40)}`);
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Argus connection timed out')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Argus connection failed')); }, { once: true });
    ws.addEventListener('close', event => { clearTimeout(timer); reject(new Error(`Argus closed connection ${event.code}`)); }, { once: true });
  });
  return ws;
}
function send(ws, message) { ws.send(JSON.stringify(message)); }
function waitFor(ws, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Argus reply timed out')), timeoutMs);
    function finish(error, value) {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
      if (error) reject(error); else resolve(value);
    }
    function onClose() { finish(new Error('Argus connection closed')); }
    function onMessage(event) {
      let value;
      try { value = JSON.parse(event.data); } catch { return; }
      if (value.type === 'providerNotice' && value.error) { finish(new Error(value.message)); return; }
      if (predicate(value)) finish(undefined, value);
    }
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
  });
}
async function request(ws, message, type, timeoutMs) {
  const requestId = crypto.randomUUID();
  const pending = waitFor(ws, value => value.requestId === requestId && value.type === type, timeoutMs);
  send(ws, { ...message, requestId });
  return pending;
}
function prompt() {
  if (args['text-file']) return fs.readFileSync(args['text-file'], 'utf8');
  return required('text');
}
function markedPrompt(text) {
  if (/^🤖(?:\s|$)/u.test(text)) return text;
  const command = /^([/$][A-Za-z0-9_-]+)(?=\s|$)/.exec(text);
  if (command && /^\s+🤖(?:\s|$)/u.test(text.slice(command[1].length))) return text;
  return command ? `${command[1]} 🤖${text.slice(command[1].length)}` : `🤖 ${text}`;
}
async function rename(ws, id, title) {
  if (!title || !id) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await request(ws, { type: 'renameSession', id, title }, 'sessionList', 20000); return; }
    catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
async function activeSessions(workspace, sessionId) {
  const ws = await connect(workspace, sessionId, undefined);
  try {
    const pending = waitFor(ws, value => value.type === 'activeSessions');
    send(ws, { type: 'getActiveSessions' });
    return new Set((await pending).sessions.map(item => item.id));
  } finally { ws.close(); }
}
async function runTurn(existing) {
  const workspace = path.resolve(args.workspace || (action === 'send' ? existing?.workspace : undefined) || process.cwd());
  if (!fs.statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory');
  if (existing && existing.workspace !== workspace) throw new Error('Existing worker uses another workspace; use send to continue it or a new key to start here');
  const title = args.title || existing?.title || key;
  if (title.length > 100) throw new Error('Title is too long');
  const record = { company, key, goal: goalKey || existing?.goal, workspace, title, sessionId: existing?.sessionId, providerId: args.provider || existing?.providerId,
    model: args.model || existing?.model, effort: args.effort || existing?.effort, status: 'starting', updatedAt: Date.now() };
  const ws = await connect(workspace, record.sessionId, `${company}:${key}`);
  let completed = false;
  let renamePending;
  try {
    send(ws, { type: 'webviewReady' });
    if (args.provider || args.model || args.effort || args.thinking) {
      const choice = { type: 'configureSession' };
      if (args.provider) choice.providerId = args.provider;
      if (args.model) choice.model = args.model;
      if (args.effort) choice.effort = args.effort;
      if (args.thinking) choice.thinking = args.thinking === 'true';
      const response = await request(ws, choice, 'sessionConfigured', 30000);
      record.providerId = response.selection.providerId;
      record.model = response.selection.model;
      record.effort = response.selection.effort;
    }
    record.status = 'running'; saveRecord(record);
    const turn = new Promise((resolve, reject) => {
      const onMessage = async event => {
        let value;
        try { value = JSON.parse(event.data); } catch { return; }
        if (value.type === 'sessionId') {
          record.sessionId = value.id; saveRecord(record);
          renamePending = rename(ws, value.id, title).catch(error => process.stderr.write(`Rename failed: ${error.message}\n`));
        } else if (value.type === 'text_chunk') process.stdout.write(value.text || '');
        else if (value.type === 'interaction' && value.request) {
          record.status = 'needs-input'; saveRecord(record);
          process.stdout.write(`\n${JSON.stringify({ type: 'interaction', request: value.request })}\n`);
          resolve('needs-input');
        } else if (value.type === 'done' || value.type === 'error') {
          record.status = value.type === 'error' ? 'error' : 'idle'; saveRecord(record);
          if (value.type === 'error') process.stderr.write(`${value.text || 'Turn failed'}\n`);
          resolve(value.type === 'error' ? 'error' : 'done');
        }
      };
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', () => { if (!completed) reject(new Error('Argus connection closed during turn')); }, { once: true });
    });
    send(ws, { type: 'send', text: markedPrompt(prompt()), mode: args.mode || 'full-access' });
    const status = await turn;
    completed = true;
    if (renamePending) await renamePending;
    process.stdout.write(`\n${JSON.stringify({ company, key, sessionId: record.sessionId, status })}\n`);
    if (status === 'error') process.exitCode = 1;
  } catch (error) {
    record.status = 'error'; saveRecord(record);
    throw error;
  } finally { ws.close(); }
}
async function simple() {
  const record = readRecord(checkpoint);
  if (!record?.sessionId) throw new Error('No saved session for this worker');
  const ws = await connect(record.workspace, record.sessionId, `${company}:${key}`);
  try {
    let pendingInteraction = null;
    ws.addEventListener('message', event => {
      let value;
      try { value = JSON.parse(event.data); } catch { return; }
      if (value.type === 'interaction') pendingInteraction = value.request || null;
    });
    send(ws, { type: 'webviewReady' });
    if (action === 'stop') { send(ws, { type: 'stop' }); record.status = 'stopping'; saveRecord(record); process.stdout.write('Stop requested\n'); }
    if (action === 'respond') {
      const response = args['response-file'] ? JSON.parse(fs.readFileSync(args['response-file'], 'utf8')) : JSON.parse(required('response'));
      const answeredId = required('id');
      const turn = new Promise((resolve, reject) => {
        ws.addEventListener('message', event => {
          let value;
          try { value = JSON.parse(event.data); } catch { return; }
          if (value.type === 'text_chunk') process.stdout.write(value.text || '');
          else if (value.type === 'interaction' && value.request && value.request.id !== answeredId) {
            record.status = 'needs-input'; saveRecord(record);
            process.stdout.write(`\n${JSON.stringify({ type: 'interaction', request: value.request })}\n`);
            resolve('needs-input');
          } else if (value.type === 'done' || value.type === 'error') {
            record.status = value.type === 'error' ? 'error' : 'idle'; saveRecord(record);
            if (value.type === 'error') process.stderr.write(`${value.text || 'Turn failed'}\n`);
            resolve(value.type === 'error' ? 'error' : 'done');
          }
        });
        ws.addEventListener('close', () => reject(new Error('Argus connection closed during turn')), { once: true });
      });
      const [, status] = await Promise.all([
        request(ws, { type: 'providerResponse', id: answeredId, response }, 'providerResponseAccepted'), turn,
      ]);
      process.stdout.write(`\n${JSON.stringify({ company, key, sessionId: record.sessionId, status })}\n`);
      if (status === 'error') process.exitCode = 1;
    }
    if (action === 'inspect') {
      const response = await request(ws, { type: 'listSessions' }, 'sessionList');
      const session = response.sessions.find(item => item.id === record.sessionId);
      const pending = waitFor(ws, value => value.type === 'activeSessions');
      send(ws, { type: 'getActiveSessions' });
      const live = (await pending).sessions.some(item => item.id === record.sessionId);
      process.stdout.write(JSON.stringify({ ...record, session, live, pendingInteraction }, null, 2) + '\n');
    }
  } finally { ws.close(); }
}
async function main() {
  if (action === 'goal') {
    const goal = safe(required('goal'));
    const folder = path.join(root, company);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, `${goal}.goal.json`);
    const previous = readRecord(file);
    const title = (args.title || previous?.title || '').trim();
    if (!title || title.length > 150) throw new Error('Goal title must be 1 to 150 characters');
    const status = args.status || previous?.status || 'active';
    if (!['active', 'blocked', 'done'].includes(status)) throw new Error('Invalid goal status');
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ company, goal, title, status, createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now() }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
    process.stdout.write(`Goal ${status}\n`); return;
  }
  if (action === 'status') {
    const folder = path.join(root, company);
    const records = fs.existsSync(folder) ? fs.readdirSync(folder).filter(name => name.endsWith('.json')).map(name => readRecord(path.join(folder, name))) : [];
    const worker = records.find(record => record.sessionId && record.workspace);
    let active;
    if (worker) { try { active = await activeSessions(worker.workspace, worker.sessionId); } catch { /* daemon unavailable */ } }
    process.stdout.write(JSON.stringify(records.map(record => record.sessionId && active ? { ...record, live: active.has(record.sessionId) } : record), null, 2) + '\n'); return;
  }
  if (action === 'rename-self') {
    const id = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
    if (!id) throw new Error('Current conversation ID is unavailable');
    const ws = await connect(process.cwd(), `codex:${id}`, undefined);
    try { await rename(ws, `codex:${id}`, required('title')); process.stdout.write('Conversation named\n'); }
    finally { ws.close(); }
    return;
  }
  if (action === 'run' || action === 'send') {
    const existing = readRecord(checkpoint);
    if (action === 'send' && !existing?.sessionId) throw new Error('No saved session for this worker');
    await runTurn(existing); return;
  }
  if (action === 'stop' || action === 'inspect' || action === 'respond') { await simple(); return; }
  throw new Error('Use goal, run, send, stop, inspect, respond, status, or rename-self');
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
