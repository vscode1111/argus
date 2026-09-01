// Ask the LIVE daemon which sessions are mid-turn right now, so a restart is not
// scheduled on top of somebody's running work. Uses the app's own definition of
// "running" (channel.listActiveSessions: sessionId + live proc + !cliDone) rather
// than guessing from process CPU, which cannot tell a CLI waiting on the API from
// an idle one.
//
// Read-only: connects, asks, prints, disconnects.
// Usage: node check-active-sessions.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// ws lives in the repo, not globally.
const repo = path.resolve(__dirname, '..', '..', '..', '..');
Module.globalPaths.push(path.join(repo, 'node_modules'));
const WebSocket = require(path.join(repo, 'node_modules', 'ws'));

const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'argus-daemon.json'), 'utf-8'));
const url = `ws://localhost:${info.port}/agent?nonce=${info.nonce}&dir=${encodeURIComponent(repo)}&client=browser&fresh=1`;

const ws = new WebSocket(url);
const done = (code) => { try { ws.close(); } catch { /* already closed */ } process.exit(code); };
const timer = setTimeout(() => { console.log('no activeSessions reply within 8s'); done(1); }, 8000);

ws.on('open', () => ws.send(JSON.stringify({ type: 'getActiveSessions' })));
ws.on('error', (err) => { console.log(`connect failed: ${err.message}`); done(1); });
ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  if (msg.type !== 'activeSessions') return;
  clearTimeout(timer);
  const list = msg.sessions || [];
  console.log(`daemon pid ${info.pid} v${info.version} port ${info.port}`);
  console.log(`turns running now: ${list.length}`);
  for (const s of list) {
    const age = s.startedAt ? `${Math.round((Date.now() - s.startedAt) / 1000)}s` : '?';
    console.log(`  ${s.id}  ${s.workspacePath}  (started ${age} ago)`);
  }
  done(0);
});
