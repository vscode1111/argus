#!/usr/bin/env node
// Does `system`/`task_updated` fire only at completion, or also while a background task is
// producing output? Argus removes the task from `pendingBgTasks` on that event, so if it can
// fire early the `✻ N` pill drops to zero while the task is still running and nothing can put
// it back (`task_started` is emitted once per task and never re-emitted).
//
// The 2026-09-03 probe concluded "at completion only", but it ran `sleep 20 && echo done`,
// which writes nothing until it exits. This one runs a task that writes a line every second,
// which is what the reported session's tasks (a sync script, a LanceDB ingest) do.
//
// Prints every task-related system event with a wall clock and the seconds since launch.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, 'probe-task-updated.out.jsonl');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-probe-upd-'));

const args = [
  '--print', '--verbose',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--tools', 'Bash',
  '--allowedTools', 'Bash',
];

const proc = spawn(process.env.CLAUDE_BIN || 'claude', args, { cwd: WORK, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });

const prompt = 'Run exactly this one command with run_in_background set to true: for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo "scub line $i"; sleep 2; done . Then reply with the single word launched and nothing else. Do not run anything else, do not read its output, do not wait for it.';
proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');

const raw = [];
let buf = '';
let launchedAt = null;
proc.stdout.on('data', chunk => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    raw.push(line);
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'system' || !String(ev.subtype).startsWith('task')) continue;
    if (!launchedAt) launchedAt = Date.now();
    const dt = ((Date.now() - launchedAt) / 1000).toFixed(1).padStart(5);
    console.log(`${new Date().toISOString().slice(11, 19)}  +${dt}s  ${String(ev.subtype).padEnd(18)} task=${ev.task_id} status=${ev.status ?? '-'} summary=${ev.summary ? JSON.stringify(ev.summary).slice(0, 60) : '-'}`);
  }
});
proc.stderr.on('data', d => process.stderr.write(d));

setTimeout(() => {
  fs.writeFileSync(OUT, raw.join('\n'));
  const subtypes = {};
  for (const l of raw) { let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'system' && String(e.subtype).startsWith('task')) subtypes[e.subtype] = (subtypes[e.subtype] || 0) + 1; }
  console.log('\ncounts:', JSON.stringify(subtypes));
  console.log(`raw stdout -> ${OUT} (${raw.length} lines)`);
  try { proc.kill(); } catch {}
  setTimeout(() => process.exit(0), 500);
}, 70_000);
