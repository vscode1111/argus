#!/usr/bin/env node
// Reproduces the reported symptom end to end: the `✻ N` pill appears and then disappears
// while the background task is still running. Everything the UI knows about the count arrives
// as `bgTasks` frames and as `pendingBackgroundTasks` on `done`, so logging those two with
// timestamps says exactly which frame zeroed it.
//
// Spawns a real Argus server on a private port with its own discovery file and config (never
// the user's daemon), drives one real turn over a raw WS client, and prints a frame log.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'ws'));

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PORT = 3199;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-pill-'));
const DAEMON_FILE = path.join(TMP, 'daemon.json');
const CONFIG = path.join(TMP, 'argus.json');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(CONFIG, JSON.stringify({ model: '', watchdogEnabled: false }, null, 2));

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;

const daemon = spawn(process.execPath, [path.join(ROOT, 'out', 'backend', 'daemon.js')], {
  env: { ...process.env, ARGUS_DAEMON_PORT: String(PORT), ARGUS_DAEMON_FILE: DAEMON_FILE, ARGUS_CONFIG: CONFIG, ARGUS_MODEL_REFRESH: '0', ARGUS_USAGE_POLL: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
daemon.stdout.on('data', d => { const s = d.toString().trim(); if (/task|bg|spawn/i.test(s)) console.log(`${stamp()} [daemon] ${s.slice(0, 160)}`); });
daemon.stderr.on('data', d => process.stderr.write(d));

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 60 && !fs.existsSync(DAEMON_FILE); i++) await wait(250);
  if (!fs.existsSync(DAEMON_FILE)) { console.error('daemon never wrote its discovery file'); process.exit(1); }
  const info = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'));
  console.log(`${stamp()} daemon up on ${info.port}, pid ${info.pid}`);

  const ws = new WebSocket(`ws://localhost:${info.port}/agent?nonce=${info.nonce}&dir=${encodeURIComponent(WORK)}&client=browser`);
  const frames = [];
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    frames.push(m);
    if (m.type === 'bgTasks') console.log(`${stamp()} bgTasks  count=${m.count}   <-- the pill shows this`);
    else if (m.type === 'done') console.log(`${stamp()} done     pendingBackgroundTasks=${m.pendingBackgroundTasks ?? '(absent -> pill resets to 0)'} autonomous=${m.autonomous ?? false}`);
    else if (m.type === 'thinking_start') console.log(`${stamp()} thinking_start reused=${m.reused}`);
    else if (m.type === 'log' && /task|Spawning|bg/i.test(m.text || '')) console.log(`${stamp()} log      ${String(m.text).slice(0, 150)}`);
  });
  await new Promise(r => ws.on('open', r));
  console.log(`${stamp()} client connected`);
  ws.send(JSON.stringify({ type: 'webviewReady' }));
  await wait(500);

  // One background task that outlives the turn by a wide margin, then ordinary work so the
  // turn keeps going for a while after the launch - the shape of the reported session.
  ws.send(JSON.stringify({
    type: 'send',
    text: 'Do exactly two things. First, run this command with run_in_background set to true: for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do echo "scub tick $i"; sleep 3; done . Second, without waiting for it and without reading its output, run `echo one`, then `echo two`, then `echo three`, then reply with the single word done.',
  }));

  await wait(150_000);
  console.log('\n--- frame summary ---');
  const counts = {};
  for (const f of frames) counts[f.type] = (counts[f.type] || 0) + 1;
  console.log(JSON.stringify(counts));
  console.log('bgTasks sequence:', frames.filter(f => f.type === 'bgTasks').map(f => f.count).join(' -> ') || '(none)');
  fs.writeFileSync(path.join(__dirname, 'probe-pill-flicker.out.json'), JSON.stringify(frames, null, 1));
  try { ws.close(); } catch {}
  try { process.kill(info.pid); } catch {}
  try { daemon.kill(); } catch {}
  process.exit(0);
})();
