// Asks the LIVE daemon for the CLI process list over a real WebSocket, with no Argus UI in
// the path. The panel shows a permanent "Loading...", and the backend function answers in
// 382ms when called directly - so the question is whether the request reaches the handler.
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require(path.join(__dirname, '../../../../node_modules/ws'));

const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'argus-daemon.json'), 'utf8'));
// A throwaway dir so this probe cannot join the channel of a live conversation.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-probe-'));
const url = `ws://localhost:${info.port}/agent?nonce=${info.nonce}&dir=${encodeURIComponent(dir)}&client=browser`;
console.log('daemon pid', info.pid, 'port', info.port, 'version', info.version);

const ws = new WebSocket(url, { origin: 'http://localhost' });
const seen = [];
let sentAt = 0;

ws.on('open', () => {
  console.log('connected');
  sentAt = Date.now();
  ws.send(JSON.stringify({ type: 'listCliProcesses' }));
});
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  seen.push(m.type);
  if (m.type !== 'cliProcessList') return;
  console.log(`cliProcessList after ${Date.now() - sentAt}ms`);
  console.log('  error:', m.error ?? '(none)');
  console.log('  cores:', m.cores);
  console.log('  processes:', Array.isArray(m.processes) ? m.processes.length : typeof m.processes);
  for (const p of m.processes ?? []) {
    console.log(`   pid=${p.pid} ours=${p.ours} current=${p.current} owner=${p.owner ? p.owner.pid : '-'} session=${(p.sessionId || '-').slice(0, 8)}`);
  }
  ws.close(); process.exit(0);
});
ws.on('error', (e) => { console.log('WS ERROR:', e.message); process.exit(1); });
ws.on('close', (c) => { console.log('closed', c); process.exit(1); });
setTimeout(() => {
  console.log(`NO cliProcessList within 15s. Frames the daemon did send: ${seen.join(', ') || '(none)'}`);
  process.exit(2);
}, 15000);
