// Does phase 1 of getAccountUsage (which spawns `claude auth status`) slow down when the
// box is busy spawning processes? execFile's own timeout only starts once the child
// exists, so spawn queueing is unbounded - the suspected reason this only fails in a
// full suite run and never in isolation.
const { WebSocket } = require('ws');
const { spawn } = require('child_process');

const open = (nonce) => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://localhost:3001/agent?nonce=${nonce}`, { origin: 'http://localhost:5173' });
  ws.on('open', () => res(ws)); ws.on('error', rej);
});

function measure(ws) {
  return new Promise((resolve) => {
    const t0 = Date.now(); const seen = [];
    const onMsg = (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type !== 'accountUsage') return;
      seen.push({ at: Date.now() - t0, pending: !!m.usagePending });
      if (seen.length >= 2) { ws.off('message', onMsg); resolve(seen); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'getAccountUsage', force: true }));
    setTimeout(() => { ws.off('message', onMsg); resolve(seen); }, 25_000);
  });
}

(async () => {
  const nonce = (await (await fetch('http://localhost:3001/nonce')).text()).trim();

  const ws1 = await open(nonce);
  console.log('idle      :', JSON.stringify(await measure(ws1)));
  ws1.close();

  // Load: a churn of short-lived processes, the same pressure a full suite applies.
  let stop = false;
  const churn = async () => {
    while (!stop) {
      await Promise.all(Array.from({ length: 12 }, () => new Promise(r => {
        const p = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120)'], { stdio: 'ignore', windowsHide: true });
        p.on('exit', r); p.on('error', r);
      })));
    }
  };
  const runner = churn();
  await new Promise(r => setTimeout(r, 1500));

  const ws2 = await open(nonce);
  console.log('under load:', JSON.stringify(await measure(ws2)));
  ws2.close();
  stop = true; await runner;
  process.exit(0);
})();
