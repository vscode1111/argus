// The modal re-requests every 3s and gives up after 10s of silence. This drives the live
// daemon at that cadence to see whether any single request ever misses that deadline.
const fs = require('fs'), os = require('os'), path = require('path');
const WebSocket = require(path.join(__dirname, '../../../../node_modules/ws'));
const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'argus-daemon.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-probe-'));
const ws = new WebSocket(`ws://localhost:${info.port}/agent?nonce=${info.nonce}&dir=${encodeURIComponent(dir)}&panel=${require('crypto').randomUUID()}`, { origin: 'http://localhost' });

const ROUNDS = 8, pending = new Map();
let n = 0;
ws.on('open', () => {
  const fire = () => {
    const id = ++n;
    pending.set(id, Date.now());
    ws.send(JSON.stringify({ type: 'listCliProcesses' }));
    if (id >= ROUNDS) clearInterval(t);
  };
  const t = setInterval(fire, 3000);
  fire();
});
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type !== 'cliProcessList') return;
  const id = [...pending.keys()][0];
  const ms = Date.now() - pending.get(id);
  pending.delete(id);
  console.log(`#${id} ${String(ms).padStart(6)}ms  procs=${(m.processes || []).length}  error=${m.error ?? '-'}  ${ms > 10000 ? '<<< OVER THE 10s UI DEADLINE' : ''}`);
  if (id >= ROUNDS) { console.log('all answered'); process.exit(0); }
});
ws.on('error', e => { console.log('WS ERROR', e.message); process.exit(1); });
setTimeout(() => { console.log(`UNANSWERED: ${pending.size} of ${n}`); process.exit(2); }, 45000);
