// Interleaves real user prompts with background launches, to see which launches
// survive across a user send. Argus resets pendingBgTasks/totalBgTasks on every
// user-initiated send (session.ts handleSend), so any task still running at that
// moment is dropped from the counters while the OS process keeps going.
//
//   node turn-boundaries.js <transcript.jsonl>

const fs = require('fs');

const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);

const rows = [];
for (const raw of lines) {
  let o;
  try { o = JSON.parse(raw); } catch { continue; }
  const ts = o.timestamp ?? '';
  const content = o.message?.content;
  const blocks = Array.isArray(content) ? content : [];

  if (o.type === 'user' && !o.isMeta) {
    // A real prompt: string content, or blocks with no tool_result.
    const isToolResult = blocks.some(b => b.type === 'tool_result');
    if (!isToolResult) {
      const text = typeof content === 'string'
        ? content
        : blocks.filter(b => b.type === 'text').map(b => b.text).join(' ');
      if (text && text.trim()) {
        rows.push({ ts, kind: 'USER SEND', text: text.trim().slice(0, 80).replace(/\s+/g, ' ') });
      }
    }
  }

  for (const b of blocks) {
    if (b.type === 'tool_use' && b.input?.run_in_background === true) {
      rows.push({ ts, kind: 'launch', text: `${b.id.slice(-8)}  ${b.input.description ?? ''}` });
    }
  }
}

rows.sort((a, b) => a.ts.localeCompare(b.ts));

let liveSinceSend = 0;
let totalSinceSend = 0;
for (const r of rows) {
  if (r.kind === 'USER SEND') {
    console.log(`\n${r.ts}  ===== USER SEND =====  (counters reset: ${totalSinceSend} total / ${liveSinceSend} launched since previous send -> 0)`);
    console.log(`      "${r.text}"`);
    liveSinceSend = 0;
    totalSinceSend = 0;
  } else {
    liveSinceSend++;
    totalSinceSend++;
    console.log(`${r.ts}  launch #${totalSinceSend} since send   ${r.text}`);
  }
}
