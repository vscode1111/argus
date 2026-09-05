// After a control interrupt, is the CLI process still usable for the next turn?
//
// This is what decides whether Stop can interrupt-and-keep instead of kill: a reused
// process needs no --resume, so the CLI never rebuilds the conversation from the
// transcript and never splices its "No response requested." repair. Readouts:
//   1. does a message sent after the interrupt get answered on the same stdin
//   2. does the session id stay the same (a reused turn, not a new session)
//   3. how many placeholders exist in the transcript at the end (must stay 0)
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const PHRASE = 'No response requested.';
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-reuse-'));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const bin = IS_WIN
  ? execFileSync('where', ['claude.cmd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).split(/\r?\n/).map(l => l.trim()).find(Boolean)
  : 'claude';

const proc = spawn(IS_WIN && /\s/.test(bin) ? `"${bin}"` : bin, [
  '--print', '--verbose',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--model', 'claude-haiku-4-5',
], { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN, windowsHide: true });

const sessionIds = [];
let streamed = false, interrupted = false, secondAnswer = '', results = 0;
let buf = '';
proc.stdout.on('data', d => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.session_id && !sessionIds.includes(e.session_id)) sessionIds.push(e.session_id);
    if (e.type === 'control_response') { interrupted = true; log('  <- control_response', JSON.stringify(e.response)); }
    if (!interrupted && (e.type === 'assistant' || (e.type === 'stream_event' && e.event?.type === 'content_block_delta'))) streamed = true;
    if (interrupted && e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) if (b.type === 'text') secondAnswer += b.text;
    }
    if (e.type === 'result') { results++; log(`  result #${results}: num_turns=${e.num_turns} is_error=${e.is_error}`); }
  }
});
proc.stderr.on('data', d => log('  stderr:', d.toString().trim().slice(0, 200)));

const send = text => proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');

(async () => {
  log(`workdir ${workdir}`);
  log('turn 1: a long answer we will interrupt');
  send('Count from 1 to 300, one number per line. Do not use any tools.');
  let deadline = Date.now() + 60_000;
  while (!streamed && Date.now() < deadline) await sleep(200);
  log(`  streaming=${streamed}, session=${sessionIds[0]}`);
  await sleep(1500);

  log('interrupting');
  proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'probe-r', request: { subtype: 'interrupt' } }) + '\n');
  deadline = Date.now() + 15_000;
  while (!interrupted && Date.now() < deadline) await sleep(100);

  await sleep(1000);
  log('turn 2: reusing the SAME stdin, no --resume');
  const before = results;
  send('Reply with exactly: REUSED');
  deadline = Date.now() + 60_000;
  while (results === before && Date.now() < deadline) await sleep(200);

  await sleep(1500);
  const alive = proc.exitCode === null;
  try { if (IS_WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true }); else proc.kill(); } catch {}
  await sleep(500);

  const encoded = workdir.replace(/[^a-zA-Z0-9]/g, '-');
  let placeholders = 0, lastKind = '', lines = 0;
  const file = path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionIds[0]}.jsonl`);
  if (fs.existsSync(file)) {
    for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      lines++;
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.type === 'assistant' && o.message?.model === '<synthetic>' && JSON.stringify(o.message.content).includes(PHRASE)) placeholders++;
      if (o.type === 'user' || o.type === 'assistant') {
        const c = o.message?.content;
        lastKind = `${o.type}(${Array.isArray(c) ? c.map(b => b.type).join('+') : 'string'})`;
      }
    }
  }

  console.log('');
  console.log('===== interrupt-then-reuse =====');
  console.log(`  interrupt acknowledged : ${interrupted}`);
  console.log(`  process still alive    : ${alive}`);
  console.log(`  answered after resume  : ${JSON.stringify(secondAnswer.trim().slice(0, 60))}`);
  console.log(`  results seen           : ${results} (1 = interrupted turn produced none)`);
  console.log(`  session ids seen       : ${sessionIds.length} -> ${sessionIds.join(', ')}`);
  console.log(`  transcript lines       : ${lines}, last message = ${lastKind}`);
  console.log(`  placeholders           : ${placeholders}`);
  console.log(`  VERDICT: reuse ${secondAnswer.includes('REUSED') ? 'WORKS' : 'FAILED'}, placeholders ${placeholders === 0 ? 'avoided' : 'still created'}`);
  console.log(`  transcript: ${file}`);
  process.exit(0);
})();
