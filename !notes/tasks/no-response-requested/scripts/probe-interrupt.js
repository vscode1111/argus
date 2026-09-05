// Does ending a turn with the stream-json control interrupt avoid the CLI's
// "No response requested." repair on the next resume, where a hard kill does not?
//
//   node probe-interrupt.js interrupt
//   node probe-interrupt.js kill        <- the control run; it MUST produce the placeholder
//
// Run 1 starts a real turn and ends it mid-stream (interrupt or taskkill). Run 2 resumes
// the same session with a trivial prompt, which is what makes the CLI rebuild the
// conversation from the transcript. The readout is whether a `"model":"<synthetic>"`
// assistant record carrying the phrase appears in the transcript afterwards.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODE = process.argv[2];
const MODES = ['interrupt', 'kill', 'interrupt-wait'];
if (!MODES.includes(MODE)) { console.error(`usage: probe-interrupt.js <${MODES.join('|')}>`); process.exit(2); }

const IS_WIN = process.platform === 'win32';
const PHRASE = 'No response requested.';
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-interrupt-'));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

function claudeBin() {
  if (!IS_WIN) return 'claude';
  const out = execFileSync('where', ['claude.cmd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  return out.split(/\r?\n/).map(l => l.trim()).find(Boolean);
}

// Same shape as Argus's handleSend, trimmed to what the probe needs.
const BASE_ARGS = [
  '--print', '--verbose',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--model', 'claude-haiku-4-5',
];

function start(extraArgs) {
  const bin = claudeBin();
  const cmd = IS_WIN && /\s/.test(bin) ? `"${bin}"` : bin;
  const args = [...BASE_ARGS, ...extraArgs];
  return spawn(cmd, args, { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN, windowsHide: true });
}

function send(proc, text) {
  proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
}

// Reads NDJSON off stdout and calls onEvent for each parsed object.
function readEvents(proc, onEvent) {
  let buf = '';
  proc.stdout.on('data', d => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch {}
    }
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run1() {
  log(`run 1: starting a turn, will end it with "${MODE}"`);
  const proc = start([]);
  let sessionId = null, streamed = false, sawControlResponse = false, sawResult = false;
  const events = [];
  readEvents(proc, e => {
    events.push(e.type + (e.subtype ? ':' + e.subtype : ''));
    if (e.type === 'result') { sawResult = true; log(`  result: num_turns=${e.num_turns} is_error=${e.is_error}`); }
    if (e.type === 'system' && e.subtype === 'init' && e.session_id) sessionId = e.session_id;
    if (e.session_id && !sessionId) sessionId = e.session_id;
    if (e.type === 'control_response') { sawControlResponse = true; log('  <- control_response', JSON.stringify(e.response)); }
    if (e.type === 'stream_event' && e.event?.type === 'content_block_delta') streamed = true;
    if (e.type === 'assistant') streamed = true;
  });
  proc.stderr.on('data', d => log('  stderr:', d.toString().trim().slice(0, 200)));

  const exited = new Promise(res => proc.on('close', code => res(code)));
  send(proc, 'Count from 1 to 300, one number per line. Do not use any tools.');

  const deadline = Date.now() + 60_000;
  while (!streamed && Date.now() < deadline) await sleep(200);
  if (!streamed) { log('  !! no streaming started, aborting'); proc.kill(); return null; }
  log(`  streaming started, session=${sessionId}`);
  await sleep(1500); // let it get well into the turn

  if (MODE === 'interrupt' || MODE === 'interrupt-wait') {
    const frame = { type: 'control_request', request_id: 'probe-1', request: { subtype: 'interrupt' } };
    log('  -> ' + JSON.stringify(frame));
    proc.stdin.write(JSON.stringify(frame) + '\n');
    if (MODE === 'interrupt-wait') {
      // What production would do: let the interrupted turn end on its own terms, so the
      // CLI writes whatever assistant record it owes, and only then take the process down.
      const until = Date.now() + 10_000;
      while (!sawResult && Date.now() < until) await sleep(50);
      log(`  waited for the turn to end: result=${sawResult} after ${10_000 - (until - Date.now())}ms`);
      await sleep(1500); // let the transcript write settle
      log('  -> now killing the (idle) process, as closing a panel would');
      try {
        if (IS_WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true });
        else proc.kill();
      } catch { try { proc.kill(); } catch {} }
    }
  } else {
    log('  -> taskkill /T /F (what Argus does today)');
    // killProc() swallows taskkill failures; mirror that so the control run behaves
    // exactly like production rather than dying on a race with the shell wrapper.
    try {
      if (IS_WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true });
      else proc.kill();
    } catch (err) {
      log('  taskkill threw (as killProc would swallow):', String(err.message).split('\n')[0]);
      try { proc.kill(); } catch {}
    }
  }

  const code = await Promise.race([exited, sleep(20_000).then(() => 'TIMEOUT')]);
  log(`  run 1 ended: exit=${code}, controlResponse=${sawControlResponse}`);
  if (code === 'TIMEOUT') { log('  (still alive after the interrupt, killing)'); try { proc.kill(); } catch {} }
  return { sessionId, code, sawControlResponse, events };
}

async function run2(sessionId) {
  log(`run 2: resuming ${sessionId} with a trivial prompt`);
  const proc = start(['--resume', sessionId]);
  let done = false;
  readEvents(proc, e => { if (e.type === 'result') { done = true; log(`  result: num_turns=${e.num_turns} is_error=${e.is_error}`); } });
  proc.stderr.on('data', d => log('  stderr:', d.toString().trim().slice(0, 200)));
  send(proc, 'Say OK and nothing else.');
  const deadline = Date.now() + 60_000;
  while (!done && Date.now() < deadline) await sleep(200);
  try { proc.stdin.end(); } catch {}
  await sleep(1500);
  try { if (IS_WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true }); else proc.kill(); } catch {}
  return done;
}

function transcriptPath(sessionId) {
  const encoded = workdir.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

function inspect(sessionId, label) {
  const file = transcriptPath(sessionId);
  if (!fs.existsSync(file)) return log(`  ${label}: transcript missing at ${file}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let placeholders = 0, lastKind = '';
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.type === 'assistant' && o.message?.model === '<synthetic>' &&
        JSON.stringify(o.message.content).includes(PHRASE)) placeholders++;
    if (o.type === 'user' || o.type === 'assistant') {
      const c = o.message?.content;
      const kinds = Array.isArray(c) ? c.map(b => b.type).join('+') : 'string';
      lastKind = `${o.type}(${kinds})${o.message?.model === '<synthetic>' ? ' SYNTHETIC' : ''}`;
    }
  }
  log(`  ${label}: ${lines.length} lines, last message = ${lastKind}, placeholders = ${placeholders}`);
  return placeholders;
}

(async () => {
  log(`workdir ${workdir}`);
  const r1 = await run1();
  if (!r1?.sessionId) { log('FAILED: no session id'); process.exit(1); }
  const before = inspect(r1.sessionId, 'after run 1');
  const ok = await run2(r1.sessionId);
  const after = inspect(r1.sessionId, 'after run 2');
  console.log('');
  console.log(`===== MODE=${MODE} =====`);
  console.log(`  run 1 exit code       : ${r1.code}`);
  console.log(`  control_response seen : ${r1.sawControlResponse}`);
  console.log(`  run 2 completed       : ${ok}`);
  console.log(`  placeholders after 1  : ${before}`);
  console.log(`  placeholders after 2  : ${after}`);
  console.log(`  VERDICT: resume ${after > before ? 'INSERTED a placeholder' : 'inserted NO placeholder'}`);
  console.log(`  transcript: ${transcriptPath(r1.sessionId)}`);
})();
