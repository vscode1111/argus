// Compact one-line-per-entry dump of a transcript line range.
const fs = require('fs');
const file = process.argv[2];
const from = Number(process.argv[3]);
const to = Number(process.argv[4]);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

const short = (s, n = 200) => { s = String(s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + `…(${s.length})` : s; };

for (let i = from - 1; i < to && i < lines.length; i++) {
  let o; try { o = JSON.parse(lines[i]); } catch { console.log(`${i + 1}\t<unparseable>`); continue; }
  const p = [String(i + 1).padStart(5), o.timestamp || '', o.type || ''];
  if (o.operation) p.push(o.operation);
  if (o.isMeta) p.push('META');
  if (o.isSidechain) p.push('SIDE');
  const m = o.message;
  if (m) {
    if (m.model) p.push(m.model);
    const u = m.usage;
    if (u) p.push(`out=${u.output_tokens} cr=${u.cache_read_input_tokens}`);
    if (m.stop_reason) p.push('stop=' + m.stop_reason);
  }
  let body = '';
  if (m) {
    const c = m.content;
    if (typeof c === 'string') body = short(c);
    else if (Array.isArray(c)) body = c.map(b =>
      b.type === 'text' ? 'text[' + short(b.text, 160) + ']'
      : b.type === 'thinking' ? 'thinking'
      : b.type === 'tool_use' ? `tool_use(${b.name})`
      : b.type === 'tool_result' ? 'tool_result'
      : b.type).join(' | ');
  }
  if (o.type === 'summary') body = 'SUMMARY: ' + short(o.summary, 120);
  console.log(p.join(' ') + (body ? '  ' + body : ''));
}
