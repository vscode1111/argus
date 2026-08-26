// Prints a compact timeline of a CLI transcript around a given local-time window,
// so a suspicious turn boundary can be read without opening a multi-MB jsonl.
// Usage: node scan-transcript.js <file.jsonl> [fromLocalHHMM] [toLocalHHMM]
const fs = require('fs');

const [file, from = '00:00', to = '23:59'] = process.argv.slice(2);
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const lo = toMin(from), hi = toMin(to);

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
for (const line of lines) {
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  if (!r.timestamp) continue;
  const d = new Date(r.timestamp);
  const hhmm = d.getHours() * 60 + d.getMinutes();
  if (hhmm < lo || hhmm > hi) continue;
  const clock = d.toTimeString().slice(0, 8);

  let what = r.type;
  const c = r.message?.content;
  if (typeof c === 'string') what += ` text: ${c.slice(0, 70).replace(/\s+/g, ' ')}`;
  else if (Array.isArray(c)) {
    what += ' ' + c.map(b =>
      b.type === 'text' ? `text:${JSON.stringify(String(b.text).slice(0, 60))}`
      : b.type === 'tool_use' ? `tool_use:${b.name}`
      : b.type === 'tool_result' ? `tool_result`
      : b.type === 'thinking' ? `thinking(${String(b.thinking).length})`
      : b.type
    ).join(' ');
  } else if (r.type === 'summary' || r.type === 'ai-title' || r.type === 'custom-title') {
    what += ` ${r.summary ?? r.title ?? r.customTitle ?? ''}`;
  }
  const flags = [
    r.isSidechain ? 'sidechain' : '',
    r.isMeta ? 'meta' : '',
    r.userType && r.userType !== 'external' ? r.userType : '',
    r.requestId ? `req=${String(r.requestId).slice(-6)}` : '',
    r.uuid ? `u=${String(r.uuid).slice(0, 8)}` : '',
    r.parentUuid ? `p=${String(r.parentUuid).slice(0, 8)}` : 'p=ROOT',
  ].filter(Boolean).join(' ');
  console.log(`${clock}  ${what}  [${flags}]`);
}
