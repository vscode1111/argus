#!/usr/bin/env node
// Does the *live stream* carry `origin: {kind:'task-notification'}` on the user event, or is
// that only a transcript field? The whole live half of the marker rests on it, and the spec
// that covers it took its payload shape from a transcript record rather than from stdout, so
// until this probe runs it is an assumption wearing a test's clothes.
//
// Spawns the CLI exactly as session.ts does (stream-json in and out, so the process stays
// alive between turns), asks for one background task, then holds stdin open long enough for
// the task to finish and the CLI to wake itself.
//
// Output: every `user` event and every `task_notification` system event, with the fields that
// decide the behaviour. Writes the raw stdout next to this script for re-reading.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, 'probe-notification.out.jsonl');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-probe-'));

const args = [
  '--print', '--verbose',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--tools', 'Bash',
  '--allowedTools', 'Bash',
];

const bin = process.env.CLAUDE_BIN || 'claude';
const proc = spawn(bin, args, { cwd: WORK, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });

const prompt = 'Run exactly this one command with run_in_background set to true: sleep 20 && echo scub-probe-done . Then reply with the single word launched and nothing else. Do not run anything else and do not wait for it.';
proc.stdin.write(JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: prompt }] },
}) + '\n');

const raw = [];
let buf = '';
proc.stdout.on('data', chunk => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    raw.push(line);
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const t = new Date().toISOString().slice(11, 19);
    if (ev.type === 'user') {
      const c = ev.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b.text || `[${b.type}]`).join(' ') : '';
      console.log(`${t} USER   origin=${JSON.stringify(ev.origin)} isSynthetic=${ev.isSynthetic} isMeta=${ev.isMeta} :: ${text.replace(/\s+/g, ' ').slice(0, 140)}`);
    } else if (ev.type === 'system' && String(ev.subtype).startsWith('task')) {
      console.log(`${t} SYSTEM ${ev.subtype} task=${ev.task_id} summary=${JSON.stringify(ev.summary ?? null)}`);
    } else if (ev.type === 'result') {
      console.log(`${t} RESULT origin=${JSON.stringify(ev.origin)} num_turns=${ev.num_turns} :: ${String(ev.result ?? '').slice(0, 60)}`);
    }
  }
});
proc.stderr.on('data', d => process.stderr.write(d));

// Long enough for the 20s task to finish and the CLI to run its notification turn.
const HOLD_MS = 75_000;
setTimeout(() => {
  fs.writeFileSync(OUT, raw.join('\n'));
  console.log(`\nraw stdout -> ${OUT} (${raw.length} lines)`);
  try { proc.kill(); } catch {}
  setTimeout(() => process.exit(0), 500);
}, HOLD_MS);
