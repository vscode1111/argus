// Ask a running Argus server for usage over a real WebSocket, exactly as the webview
// does, and print the raw reply. Distinguishes "the server answered with empty windows
// plus a reason" (indicator correctly hides) from "no reply at all" (wiring bug).
//
//   node "!notes/tasks/usage-limits-indicator/scripts/probe-ws-usage.js" [port]

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));

const port = process.argv[2] || 3001;

(async () => {
  const nonce = (await fetch(`http://localhost:${port}/nonce`).then(r => r.text())).trim();
  const ws = new WebSocket(`ws://localhost:${port}/agent?nonce=${nonce}`, { origin: 'http://localhost:5173' });

  ws.on('open', () => {
    const reqAt = Date.now();
    ws.send(JSON.stringify({ type: 'getUsageLimits' }));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'usageLimits') return;
      console.log('reply after ms :', Date.now() - reqAt);
      console.log('error         :', msg.error ?? '(none)');
      console.log('data age ms   :', reqAt - msg.fetchedAt);
      console.log('windows       :', JSON.stringify(msg.windows));
      process.exit(0);
    });
  });
  ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
  setTimeout(() => { console.error('no usageLimits reply within 15s'); process.exit(2); }, 15_000);
})();
