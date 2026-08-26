// End-to-end check of the handleResult fix through the real server: raw WS client ->
// startServer -> real `claude` CLI. The unit spec proves the handler ignores the
// notification result; this proves the frames the webview actually receives.
//
//   turn 1: start a background task, then hard-kill the CLI subtree so the task is
//           orphaned exactly as a daemon respawn leaves it
//   turn 2: send a normal message and record every frame
//
// Pass = one thinking_start and one done for turn 2, with the done AFTER the content.
// Before the fix: done arrives ~1s in with nothing in it, then a second thinking_start.
//
// Usage: node verify-fix-e2e.js

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-verify-'));

// config.ts resolves ARGUS_CONFIG at import time, so this must precede the require.
const configPath = path.join(tmp, 'argus.json');
fs.writeFileSync(configPath, JSON.stringify({ model: '', watchdogEnabled: false, appendSystemPrompt: '' }));
process.env.ARGUS_CONFIG = configPath;
process.env.ARGUS_USAGE_POLL = '0';

const { startServer } = require(path.join(ROOT, 'out', 'backend', 'index.js'));
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-verify-ws-'));

// Only ever descendants of this script: the CLI runs as node -> cmd.exe -> claude.exe.
function killOwnCliChildren() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Select-Object -ExpandProperty ProcessId`,
  ], { encoding: 'utf8' });
  const pids = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/T', '/F', '/PID', pid], { stdio: 'ignore' }); } catch {}
  }
  return pids;
}

(async () => {
  const srv = await startServer({ port: 3987, model: '' });
  const ws = new WebSocket(`ws://localhost:${srv.port}/agent?nonce=${srv.nonce}&dir=${encodeURIComponent(workspace)}&client=browser`);
  await new Promise(res => ws.on('open', res));

  let frames = [];
  let t0 = Date.now();
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'log' || m.type === 'clientCount') return;
    frames.push({ at: Date.now() - t0, type: m.type, text: (m.text ?? '').slice(0, 45) });
  });

  const waitFor = (type, ms) => new Promise((res, rej) => {
    const iv = setInterval(() => {
      if (frames.some(f => f.type === type)) { clearInterval(iv); clearTimeout(to); res(); }
    }, 100);
    const to = setTimeout(() => { clearInterval(iv); rej(new Error(`timeout waiting for ${type}`)); }, ms);
  });

  console.log('--- turn 1: start a background task ---');
  ws.send(JSON.stringify({ type: 'send', text:
    'Use the Bash tool with run_in_background set to true to run exactly: `sleep 300`. ' +
    'Do not poll it, do not wait for it. Immediately reply with exactly: STARTED' }));
  await waitFor('done', 120000);
  console.log('turn 1 frames:', frames.map(f => f.type).join(' '));

  console.log('\n--- orphaning the CLI (hard kill, as a daemon respawn would) ---');
  console.log('killed pids:', killOwnCliChildren().join(', ') || '(none)');
  await new Promise(r => setTimeout(r, 1500));

  console.log('\n--- turn 2: an ordinary message ---');
  frames = []; t0 = Date.now();
  ws.send(JSON.stringify({ type: 'send', text: 'Reply with exactly: HELLO' }));
  await waitFor('done', 120000);
  await new Promise(r => setTimeout(r, 2000));

  for (const f of frames) console.log(`  [+${String(f.at).padStart(6)}ms] ${f.type}${f.text ? ' ' + JSON.stringify(f.text) : ''}`);

  const starts = frames.filter(f => f.type === 'thinking_start');
  const dones = frames.filter(f => f.type === 'done');
  const firstContent = frames.find(f => f.type === 'text_chunk' || f.type === 'tool_start');
  const prematureDone = dones.find(d => !firstContent || d.at < firstContent.at);

  console.log('\n--- verdict ---');
  console.log(`thinking_start: ${starts.length} (expected 1)`);
  console.log(`done:           ${dones.length} (expected 1)`);
  console.log(`first content at: ${firstContent ? '+' + firstContent.at + 'ms' : 'NONE'}`);
  console.log(prematureDone
    ? `FAIL: a done landed at +${prematureDone.at}ms before any content - the empty ~1s turn`
    : 'PASS: no turn was ended before the answer arrived');

  killOwnCliChildren();
  await srv.close();
  process.exit(prematureDone || starts.length !== 1 || dones.length !== 1 ? 1 : 0);
})().catch(e => { console.error('ERROR', e); killOwnCliChildren(); process.exit(2); });
