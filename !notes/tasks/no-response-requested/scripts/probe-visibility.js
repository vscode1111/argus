// Does the CLI send its "<synthetic>" placeholder to the API, or only store/render it?
//
//   node probe-visibility.js <workdir> <sessionId>
//
// Resumes a session that already contains exactly one placeholder and asks the model to
// quote its own prior messages back. The phrase is never put into the prompt, so if it
// comes back it can only have come from the replayed conversation. Prints the answer plus
// the input-token count, which is the second, independent readout (a stripped message
// would not be billed).
const { spawn, execFileSync } = require('child_process');
const path = require('path');

const workdir = process.argv[2];
const sessionId = process.argv[3];
if (!workdir || !sessionId) { console.error('usage: probe-visibility.js <workdir> <sessionId>'); process.exit(2); }

const IS_WIN = process.platform === 'win32';
const bin = IS_WIN
  ? execFileSync('where', ['claude.cmd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).split(/\r?\n/).map(l => l.trim()).find(Boolean)
  : 'claude';

const proc = spawn(IS_WIN && /\s/.test(bin) ? `"${bin}"` : bin, [
  '--print', '--verbose',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--model', 'claude-haiku-4-5',
  '--resume', sessionId,
], { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN, windowsHide: true });

let answer = '';
let usage = null;
let buf = '';
proc.stdout.on('data', d => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) if (b.type === 'text') answer += b.text;
      if (e.message.usage) usage = e.message.usage;
    }
    if (e.type === 'result') finish();
  }
});
proc.stderr.on('data', d => process.stderr.write('stderr: ' + d.toString().slice(0, 300)));

proc.stdin.write(JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text:
    'Without using any tools: list verbatim, in order, every message YOU (the assistant) have sent in this conversation before this one. One per line, exact text, no commentary.' }] },
}) + '\n');

let done = false;
function finish() {
  if (done) return; done = true;
  const PHRASE = 'No response requested.';
  console.log('--- model answer ---');
  console.log(answer.trim());
  console.log('--- readout ---');
  console.log('placeholder phrase present in the answer :', answer.includes(PHRASE));
  if (usage) console.log('input tokens (in+cache_read+cache_create):',
    (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0));
  try { if (IS_WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true }); else proc.kill(); } catch {}
  setTimeout(() => process.exit(0), 500);
}
setTimeout(() => { console.log('TIMEOUT'); finish(); }, 90_000);
