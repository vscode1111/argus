// Does the spec's `waitForFrame` lose a frame that arrives in the same TCP read as the one it
// just resolved on? No Argus involved: a local ws server writes both frames back to back,
// which is what session.ts's getAccountUsage does whenever phase 2 needs no work (a usage
// attempt inside the 60s floor answers from the snapshot, so the settled frame follows
// `usagePending` immediately).
//
// Runs the OLD per-call-listener helper and the NEW buffered one over the same two scenarios,
// so the fix is red/green here rather than asserted. The 50ms-gap row is the control: it is a
// cold usage fetch, which is why the failing test passed every time it was re-run alone.
const { WebSocketServer, WebSocket } = require('ws');

const QUEUE = Symbol('frames');

// --- old: attaches its listener inside the promise, so nothing is listening between calls ---
function waitOld(ws, type, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`no ${type} frame within ${timeoutMs}ms`)); }, timeoutMs);
    function onMsg(raw) {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== type) return;
      clearTimeout(timer); ws.off('message', onMsg); resolve(msg);
    }
    ws.on('message', onMsg);
  });
}

// --- new: one listener from construction, waits consume from the buffer ---
function bufferFrames(ws) {
  const q = [];
  ws[QUEUE] = q;
  ws.on('message', raw => { try { q.push(JSON.parse(raw.toString())); } catch { /* non-JSON */ } });
}

async function waitNew(ws, type, timeoutMs = 2000) {
  const q = ws[QUEUE];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const i = q.findIndex(m => m.type === type);
    if (i >= 0) return q.splice(i, 1)[0];
    if (Date.now() >= deadline) throw new Error(`no ${type} frame within ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 25));
  }
}

// The loop shape from the spec: frame 1 is usagePending, frame 2 is the settled answer.
async function run(waitFor, useBuffer, label, gapMs) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise(r => wss.on('listening', r));
  wss.on('connection', async sock => {
    sock.send(JSON.stringify({ type: 'accountUsage', account: {}, usagePending: true }));
    if (gapMs) await new Promise(r => setTimeout(r, gapMs));
    sock.send(JSON.stringify({ type: 'accountUsage', account: {}, rateLimits: [], usagePending: false }));
  });

  const ws = new WebSocket(`ws://localhost:${wss.address().port}`);
  if (useBuffer) bufferFrames(ws);
  await new Promise(r => ws.on('open', r));

  let windows = null;
  let out;
  try {
    for (let i = 0; i < 3; i++) {
      const msg = await waitFor(ws, 'accountUsage');
      if (msg.usagePending) continue;
      windows = msg.rateLimits ?? [];
      break;
    }
    out = `reached the skip check, windows=${JSON.stringify(windows)}`;
  } catch (e) {
    out = `HUNG -> ${e.message}`;
  }
  console.log(`${label}: ${out}`);
  ws.close();
  await new Promise(r => wss.close(r));
}

(async () => {
  console.log('old helper (per-call listener):');
  await run(waitOld, false, '  back-to-back (phase 2 needs no work)', 0);
  await run(waitOld, false, '  50ms gap     (cold usage fetch)     ', 50);
  console.log('new helper (buffered from construction):');
  await run(waitNew, true, '  back-to-back (phase 2 needs no work)', 0);
  await run(waitNew, true, '  50ms gap     (cold usage fetch)     ', 50);
})();
