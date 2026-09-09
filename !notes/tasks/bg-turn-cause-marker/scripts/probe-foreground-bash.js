#!/usr/bin/env node
// Does the CLI emit `task_started` / `task_notification` for an ORDINARY foreground Bash call?
// Argus adds every `task_started` to `pendingBgTasks`, which drives the `✻ N` pill, so if it
// does, the pill blinks on every command the agent runs and the count is not a count of
// background tasks at all.
//
// Deliberately no background task in this run: nothing here should produce a task event.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, 'probe-foreground-bash.out.jsonl');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-probe-fg-'));

const proc = spawn(process.env.CLAUDE_BIN || 'claude', [
  '--print', '--verbose',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--tools', 'Bash',
  '--allowedTools', 'Bash',
], { cwd: WORK, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });

const prompt = 'Run exactly this command, in the foreground, WITHOUT run_in_background: echo scub-hello . Then reply with the single word ok and nothing else.';
proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');

const raw = [];
let buf = '';
proc.stdout.on('data', chunk => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    raw.push(line);
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const t = new Date().toISOString().slice(11, 19);
    if (ev.type === 'system' && String(ev.subtype).startsWith('task')) {
      console.log(`${t} SYSTEM ${String(ev.subtype).padEnd(18)} task=${ev.task_id} tool=${String(ev.tool_use_id).slice(-6)} summary=${ev.summary ? JSON.stringify(ev.summary).slice(0, 70) : '-'}`);
    } else if (ev.type === 'assistant') {
      const c = ev.message?.content;
      if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_use') {
        console.log(`${t} TOOL_USE ${b.name} id=${String(b.id).slice(-6)} run_in_background=${JSON.stringify(b.input?.run_in_background)} cmd=${JSON.stringify(String(b.input?.command || '').slice(0, 50))}`);
      }
    }
  }
});
proc.stderr.on('data', d => process.stderr.write(d));

setTimeout(() => {
  fs.writeFileSync(OUT, raw.join('\n'));
  const counts = {};
  for (const l of raw) { let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'system' && String(e.subtype).startsWith('task')) counts[e.subtype] = (counts[e.subtype] || 0) + 1; }
  console.log('\ntask event counts for a foreground-only run:', JSON.stringify(counts));
  console.log(`raw stdout -> ${OUT} (${raw.length} lines)`);
  try { proc.kill(); } catch {}
  setTimeout(() => process.exit(0), 500);
}, 45_000);
