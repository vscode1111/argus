// Control run for the fix in handleResult: what does the result event look like when
// a background task completes NORMALLY and the CLI runs a real autonomous turn?
//
// If that result also carries origin.kind === 'task-notification', then ignoring every
// such result would leave the UI streaming forever - so the fix has to be narrower
// (num_turns === 0). This script measures it instead of assuming.
//
// Usage: node probe-bgtask-completion.js

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const bin = IS_WIN
  ? execFileSync('where', ['claude.cmd'], { encoding: 'utf8' }).split(/\r?\n/).map(l => l.trim()).find(Boolean)
  : 'claude';
const TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'];

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-bgdone-'));
console.log('workspace:', workspace);

const proc = spawn(IS_WIN && /\s/.test(bin) ? `"${bin}"` : bin, [
  '--print', '--verbose',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--tools', TOOLS.join(','),
  '--allowedTools', TOOLS.join(','),
], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN, windowsHide: true });

const t0 = Date.now();
let buf = '';
let resultCount = 0;

proc.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev.type === 'stream_event') continue;
    const el = String(Date.now() - t0).padStart(6);
    let extra = '';
    if (ev.type === 'assistant') {
      const c = ev.message?.content ?? [];
      extra = ` model=${ev.message?.model} ${JSON.stringify(c.map(b => b.type === 'text' ? b.text.slice(0, 50) : b.type))}`;
    }
    if (ev.type === 'result') {
      resultCount++;
      extra = ` #${resultCount} num_turns=${ev.num_turns} origin=${JSON.stringify(ev.origin)} result=${JSON.stringify(String(ev.result ?? '').slice(0, 50))}`;
    }
    console.log(`[+${el}ms] ${ev.type}${ev.subtype ? '/' + ev.subtype : ''}${extra}`);
  }
});
proc.stderr.on('data', c => process.stderr.write('[stderr] ' + c.toString()));

proc.stdin.write(JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text:
    'Use the Bash tool with run_in_background set to true to run exactly: `sleep 12; echo SCUB_TASK_FINISHED`. ' +
    'Do not poll it, do not wait for it. Immediately reply with exactly: STARTED' }] },
}) + '\n');

// Stay attached well past the task's completion so the CLI's own follow-up turn lands.
setTimeout(() => {
  console.log('\n--- 45s elapsed, stopping ---');
  try { execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore' }); } catch {}
  process.exit(0);
}, 45000);
