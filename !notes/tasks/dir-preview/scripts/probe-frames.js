// Reproduce the shape of usage-indicator-integration:105 directly, many times over:
// two clients on one channel, getAccountUsage from the first, count accountUsage frames
// inside the spec's own 20s budget. Reports any iteration that saw fewer than two.
const { WebSocket } = require('ws');

const N = Number(process.argv[2] || 10);

const open = (nonce) => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://localhost:3001/agent?nonce=${nonce}`, { origin: 'http://localhost:5173' });
  ws.on('open', () => res(ws));
  ws.on('error', rej);
});

(async () => {
  const nonce = (await (await fetch('http://localhost:3001/nonce')).text()).trim();
  let bad = 0;
  for (let i = 1; i <= N; i++) {
    const a = await open(nonce), b = await open(nonce);
    const seen = [];
    const t0 = Date.now();
    a.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'accountUsage') seen.push({ at: Date.now() - t0, pending: !!m.usagePending, n: (m.rateLimits || []).length, err: m.usageError });
    });
    a.send(JSON.stringify({ type: 'getAccountUsage', force: true }));
    await new Promise(r => setTimeout(r, 20_000));
    const settled = seen.filter(f => !f.pending);
    const ok = seen.length >= 2 && settled.length >= 1;
    if (!ok) bad++;
    console.log(`#${String(i).padStart(2)} frames=${seen.length} ` +
      `[${seen.map(f => `${f.pending ? 'pending' : 'settled'}@${f.at}ms${f.err ? ' err=' + f.err : ''}`).join(', ')}]` +
      (ok ? '' : '   <-- REPRODUCED'));
    a.close(); b.close();
  }
  console.log(`\n${bad}/${N} iterations produced fewer than two frames`);
  process.exit(bad ? 1 : 0);
})();
