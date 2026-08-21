// Probe: does a send issued right after a manual stop get answered?
//
// Sequence: start a long turn -> wait for real streaming -> `stop` -> immediately
// `send` a short prompt -> print every frame with a timestamp. A healthy run spawns
// a new CLI and answers; the bug reuses/injects into the dying process and the turn
// ends with a bare `done` and no text.
//
// Runs against its own daemon on a private port + throwaway discovery file/config, so
// it never touches :3001, the user's daemon, or ~/.claude/argus.json.
//
// Usage: node "!notes/tasks/stop-then-send-race/scripts/probe.js" [gapMs]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require(path.resolve(__dirname, '../../../../node_modules/ws'));

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PORT = 3931;
const GAP_MS = Number(process.argv[2] ?? 0); // delay between stop and the next send
const file = path.join(os.tmpdir(), `argus-daemon-probe-${Date.now()}.json`);
const cfg = path.join(os.tmpdir(), `argus-cfg-probe-${Date.now()}.json`);
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-probe-'));

const t0 = Date.now();
const stamp = () => String(Date.now() - t0).padStart(6, ' ') + 'ms';
const log = (...a) => console.log(stamp(), ...a);

(async () => {
  fs.writeFileSync(cfg, JSON.stringify({ daemonPort: PORT, daemonIdleMs: 600000, watchdogEnabled: false }));
  const daemon = spawn(process.execPath, [path.join(ROOT, 'out', 'backend', 'daemon.js')], {
    cwd: ROOT,
    env: { ...process.env, ARGUS_DAEMON_PORT: String(PORT), ARGUS_DAEMON_FILE: file, ARGUS_CONFIG: cfg, ARGUS_MODEL_REFRESH: '0' },
    stdio: 'ignore',
  });

  try {
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise(r => setTimeout(r, 100));
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ws = new WebSocket(`ws://localhost:${PORT}/agent?nonce=${info.nonce}&dir=${encodeURIComponent(workdir)}`);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    log('connected');

    // `done` only counts once the turn it belongs to has started: the stop broadcasts
    // its own `done` immediately, and counting that one as the next turn's ending is
    // how this probe first "reproduced" a bug that was already fixed.
    const phase = { name: 'first', textChunks: 0, started: true, done: false, logs: [] };
    ws.on('message', (m) => {
      const e = JSON.parse(m.toString());
      if (e.type === 'text_chunk') { phase.textChunks++; return; }
      if (e.type === 'log') { phase.logs.push(e.text); log(`[log] ${e.text.slice(0, 110)}`); return; }
      if (['thinking_chunk', 'token_update', 'contextUsage', 'clientCount', 'sessionId'].includes(e.type)) return;
      log(`<- ${e.type}${e.type === 'error' ? ' ' + String(e.text).slice(0, 120) : ''}`);
      if (e.type === 'thinking_start') phase.started = true;
      if (e.type === 'done' && phase.started) phase.done = true;
    });

    // 1. A turn long enough to still be streaming when we stop it.
    ws.send(JSON.stringify({ type: 'send', text: 'Count from 1 to 400, one number per line, no commentary.' }));
    log('-> send #1 (long)');
    for (let i = 0; i < 300 && phase.textChunks < 3; i++) await new Promise(r => setTimeout(r, 100));
    log(`first turn is streaming (${phase.textChunks} text chunks)`);

    // 2. Stop, then send again after `gapMs` - the race window.
    ws.send(JSON.stringify({ type: 'stop' }));
    log('-> stop');
    if (GAP_MS) await new Promise(r => setTimeout(r, GAP_MS));

    phase.name = 'second'; phase.textChunks = 0; phase.done = false; phase.started = false; phase.logs = [];
    const t = Date.now();
    ws.send(JSON.stringify({ type: 'send', text: 'Reply with exactly: PROBE-OK' }));
    log(`-> send #2 (gap ${GAP_MS}ms)`);

    for (let i = 0; i < 200 && !phase.done; i++) await new Promise(r => setTimeout(r, 100));
    const ms = Date.now() - t;
    log(`second turn: done=${phase.done} after ${ms}ms, textChunks=${phase.textChunks}`);
    const reused = phase.logs.some(l => l.includes('Reusing claude process'));
    const spawned = phase.logs.some(l => l.includes('Spawning claude'));
    console.log('\nRESULT:', phase.textChunks > 0 ? 'ANSWERED (healthy)' : 'NO OUTPUT (bug reproduced)',
      `| reused=${reused} spawned=${spawned} doneAfter=${ms}ms`);
    ws.close();
  } finally {
    try { process.kill(daemon.pid); } catch {}
    for (const f of [file, cfg]) { try { fs.unlinkSync(f); } catch {} }
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
  }
})();
