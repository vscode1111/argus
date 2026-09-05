// What does system/task_updated mean - "finished", or just "produced output"?
//
// cliHandler.ts deletes the task from pendingBgTasks on task_updated, exactly as
// it does on task_notification. If task_updated fires while the task is still
// running, every still-running-but-chatty task silently drops out of the pending
// count, and the "N background tasks still running" note undercounts.
//
// The background task here prints a marker, sleeps, prints, sleeps, then exits.
// Its own stdout timeline is the control: any task_updated logged before the
// final marker is proof the task was alive when Argus deleted it.
//
//   node probe-task-updated.js

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-bgupd-'));
const args = [
  '--print', '--verbose',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--allowedTools', 'Bash',
  '--permission-mode', 'bypassPermissions',
];

console.log(`cwd: ${cwd}\n`);
const proc = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true });

const t0 = Date.now();
let buf = '';
const events = [];
let finished = false;

function el() { return String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5); }

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
      const outFile = ev.output_file;
      let tail = '';
      if (outFile) { try { tail = fs.readFileSync(outFile, 'utf-8').trim().split('\n').pop() ?? ''; } catch {} }
      console.log(`[${el()}s] ${String(ev.subtype).padEnd(18)} task=${ev.task_id}  last-output="${tail}"  summary="${String(ev.summary ?? '').slice(0, 40)}"`);
      events.push({ at: (Date.now() - t0) / 1000, subtype: ev.subtype, tail });
    } else if (ev.type === 'result') {
      console.log(`[${el()}s] RESULT  origin=${ev.origin?.kind ?? '-'}  "${String(ev.result ?? '').slice(0, 40).replace(/\s+/g, ' ')}"`);
    }
  }
});

proc.stderr.on('data', d => process.stderr.write(`[stderr] ${d}`));
proc.on('error', e => { console.error('spawn error', e.message); process.exit(1); });

proc.stdin.write(JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [{
      type: 'text',
      text: 'Use the Bash tool with run_in_background set to true to run exactly this command: '
          + 'echo MARK-1; sleep 10; echo MARK-2; sleep 10; echo MARK-3-FINAL. '
          + 'Then reply with the single word STARTED and do nothing else.',
    }],
  },
}) + '\n');

setTimeout(() => {
  finished = true;
  console.log('\n===== summary =====');
  const updates = events.filter(e => e.subtype === 'task_updated');
  const early = updates.filter(e => !/MARK-3-FINAL/.test(e.tail));
  console.log(`task_updated events: ${updates.length}, of which fired before the task's final marker: ${early.length}`);
  for (const e of early) console.log(`  [${e.at.toFixed(1)}s] last-output="${e.tail}"  <- task still running here`);
  console.log(early.length > 0
    ? '\nVERDICT: task_updated fires while the task is STILL RUNNING.\n         Deleting from pendingBgTasks on it undercounts the note.'
    : '\nVERDICT: no task_updated arrived before completion in this run.');
  try { proc.kill(); } catch {}
  setTimeout(() => process.exit(0), 300);
}, 45000);
