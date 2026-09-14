// Does the real server answer `listClients` with real rows? The mock e2e spec owns the
// rendering; this asks a live server the same question over a real WebSocket.
//
// Spawns an isolated server (private port, throwaway config, no usage polling, no CLI),
// connects three clients that differ in the ways the list claims to distinguish - a VS
// Code webview, a browser tab, and a client that sends nothing identifying - then prints
// the reply one of them gets.
//
//   node "!notes/tasks/connected-clients/scripts/probe-list-clients.js"

const os = require('os');
const path = require('path');
const fs = require('fs');

const cfg = path.join(os.tmpdir(), `argus-probe-clients-${process.pid}.json`);
fs.writeFileSync(cfg, JSON.stringify({ allowNetworkAccess: true }));
process.env.ARGUS_CONFIG = cfg;      // never the user's real ~/.claude/argus.json
process.env.ARGUS_USAGE_POLL = '0';  // no live usage API calls from a probe

const WebSocket = require(path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'ws'));
const { startServer } = require(path.join(__dirname, '..', '..', '..', '..', 'out', 'backend', 'index.js'));

const PORT = 3099;
const DIR = process.cwd();

function connect(query, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent?${query}`, { headers });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

(async () => {
  const server = await startServer({ port: PORT });
  const q = (extra) => `nonce=${server.nonce}&dir=${encodeURIComponent(DIR)}&${extra}`;

  const panel = await connect(q('panel=probe-panel-1'), {
    Origin: 'vscode-webview://abc123',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Code/1.99.0 Electron/34',
  });
  const phone = await connect(q('client=browser'), {
    Origin: `http://127.0.0.1:${PORT}`,
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
  });
  const bare = await connect(q('panel=probe-panel-2'), {});

  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no clientList within 5s')), 5000);
    panel.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type !== 'clientList') return;   // the join replays other frames first
      clearTimeout(timer);
      resolve(msg);
    });
    panel.send(JSON.stringify({ type: 'listClients' }));
  });

  console.log(JSON.stringify(reply, null, 2));
  console.log('\nrows:', reply.clients.length, '(expected 3)');
  for (const c of reply.clients) {
    console.log(`  #${c.id} ${c.kind}/${c.device ?? '-'} ${c.address} local=${c.local} current=${c.current} ws=${c.workspacePath ? path.basename(c.workspacePath) : '-'} session=${c.sessionId ?? '-'} running=${c.running}`);
  }

  // A closed socket must leave the list, or the panel would show ghosts.
  bare.close();
  await new Promise(r => setTimeout(r, 300));
  const after = await new Promise((resolve) => {
    panel.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'clientList') resolve(msg);
    });
    panel.send(JSON.stringify({ type: 'listClients' }));
  });
  console.log('after closing one:', after.clients.length, '(expected 2)');

  panel.close();
  phone.close();
  server.close();
  fs.unlinkSync(cfg);
  setTimeout(() => process.exit(0), 200);
})().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
