// Does the CLI emit task_started ONCE per background task, or again on every
// later turn for tasks that are still running?
//
// This decides whether Argus's `totalBgTasks++` (cliHandler.ts, on every
// task_started) can inflate: pendingBgTasks is a Set so a re-emit is idempotent
// there, but the total is a bare counter with no dedupe.
//
// One CLI process, two user turns on stdin, exactly as session.ts drives it.
// Turn 1 starts a long background sleep. Turn 2 starts nothing. If turn 2
// carries a task_started for the same task_id, the total inflates once per turn.
//
//   node probe-task-started.js

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-bgprobe-'));
const args = [
  '--print', '--verbose',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--allowedTools', 'Bash',
  '--permission-mode', 'bypassPermissions',
];

console.log(`cwd: ${cwd}`);
console.log(`spawn: claude ${args.join(' ')}\n`);

const proc = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true });

const t0 = Date.now();
let buf = '';
let turn = 1;
const taskStarts = [];   // {turn, task_id}
let results = 0;
let done = false;

function send(text) {
  proc.stdin.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n');
}

function el() { return String(Date.now() - t0).padStart(6); }

proc.stdout.on('data', chunk => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'stream_event') continue;

    if (ev.type === 'system' && String(ev.subtype).startsWith('task_')) {
      console.log(`[+${el()}ms][turn ${turn}] ${ev.subtype}  task_id=${ev.task_id}  tool_use_id=${String(ev.tool_use_id ?? '').slice(-8)}`);
      if (ev.subtype === 'task_started') taskStarts.push({ turn, task_id: ev.task_id });
    } else if (ev.type === 'system') {
      console.log(`[+${el()}ms][turn ${turn}] system/${ev.subtype}`);
    } else if (ev.type === 'result') {
      results++;
      console.log(`[+${el()}ms][turn ${turn}] RESULT  num_turns=${ev.num_turns}  origin=${ev.origin?.kind ?? '-'}  "${String(ev.result ?? '').slice(0, 50).replace(/\s+/g, ' ')}"`);
      if (turn === 1) {
        turn = 2;
        console.log(`\n--- turn 2: no new background task ---`);
        setTimeout(() => send('Just reply with the single word DONE2. Do not use any tools.'), 500);
      } else if (!done) {
        done = true;
        setTimeout(finish, 1500);
      }
    }
  }
});

proc.stderr.on('data', d => process.stderr.write(`[stderr] ${d}`));
proc.on('error', e => { console.error('spawn error', e.message); process.exit(1); });

function finish() {
  console.log('\n===== summary =====');
  console.log(`task_started events: ${taskStarts.length}`);
  for (const t of taskStarts) console.log(`  turn ${t.turn}  task_id=${t.task_id}`);
  const unique = new Set(taskStarts.map(t => t.task_id));
  console.log(`unique task_ids: ${unique.size}`);
  console.log(taskStarts.length > unique.size
    ? '\nVERDICT: the CLI RE-EMITS task_started for an already-running task.\n         totalBgTasks++ therefore inflates once per turn per live task.'
    : '\nVERDICT: task_started is emitted once per task. The inflated total comes from somewhere else.');
  try { proc.kill(); } catch {}
  setTimeout(() => process.exit(0), 300);
}

send('Use the Bash tool with run_in_background set to true to run exactly: sleep 300. Then reply with the single word DONE1.');
setTimeout(() => { console.log('\n[timeout 180s]'); finish(); }, 180000);
