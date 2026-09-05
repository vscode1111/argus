// Ground truth for the "2 of 9 background tasks still running" report.
// Walks a CLI transcript and prints every background-task event in order:
// which Bash tools were launched with run_in_background, which ones reported
// back (task_notification / a later tool_result), and what was genuinely
// outstanding at each turn boundary.
//
//   node scan-bg-tasks.js <transcript.jsonl>

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scan-bg-tasks.js <transcript.jsonl>');
  process.exit(1);
}

const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
console.log(`lines: ${lines.length}\n`);

const types = new Map();
const events = [];
const launched = new Map(); // tool_use_id -> {desc, ts}

for (const raw of lines) {
  let o;
  try { o = JSON.parse(raw); } catch { continue; }

  const key = o.type === 'system' ? `system/${o.subtype ?? '?'}` : o.type;
  types.set(key, (types.get(key) ?? 0) + 1);

  const ts = o.timestamp ?? '';
  const content = o.message?.content;
  const blocks = Array.isArray(content) ? content : [];

  for (const b of blocks) {
    if (b.type === 'tool_use' && b.input?.run_in_background === true) {
      launched.set(b.id, { desc: b.input.description ?? '', ts });
      events.push({ ts, kind: 'launch', id: b.id, text: b.input.description ?? b.input.command?.slice(0, 60) ?? '' });
    }
    if (b.type === 'tool_result') {
      const text = typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content) ? b.content.map(c => c.text ?? '').join(' ') : '';
      if (/Command running in background with ID/.test(text)) {
        const m = text.match(/ID:\s*(\S+?)[.\s]/);
        events.push({ ts, kind: 'accepted', id: b.tool_use_id, text: `bg id ${m ? m[1] : '?'}` });
      } else if (launched.has(b.tool_use_id)) {
        events.push({ ts, kind: 'result', id: b.tool_use_id, text: text.slice(0, 70).replace(/\s+/g, ' ') });
      }
    }
  }

  // System task events, if the transcript persists them at all.
  if (o.type === 'system' && /^task_/.test(o.subtype ?? '')) {
    events.push({ ts, kind: o.subtype, id: o.tool_use_id ?? o.task_id ?? '?', text: (o.summary ?? '').slice(0, 70) });
  }
}

console.log('line types:');
for (const [k, v] of [...types].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);

console.log(`\nbackground launches: ${launched.size}`);
console.log('\ntimeline:');
for (const e of events) {
  console.log(`  ${e.ts}  ${e.kind.padEnd(10)}  ${String(e.id).slice(-8)}  ${e.text}`);
}

// Which launches never produced a completion line in the transcript.
const reported = new Set(events.filter(e => e.kind === 'result' || e.kind === 'task_notification').map(e => e.id));
const open = [...launched].filter(([id]) => !reported.has(id));
console.log(`\nlaunched but never reported back in this transcript: ${open.length}`);
for (const [id, v] of open) console.log(`  ${id.slice(-8)}  ${v.ts}  ${v.desc}`);
