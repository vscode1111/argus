// Find every assistant turn whose whole text is a given phrase, and show the user message before it.
const fs = require('fs');
const file = process.argv[2];
const phrase = process.argv[3] || 'No response requested';
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

const short = (s, n = 300) => { s = String(s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + `…(${s.length})` : s; };
const textOf = (o) => {
  const c = o.message && o.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return '';
};

for (let i = 0; i < lines.length; i++) {
  if (!lines[i].includes(phrase)) continue;
  let o; try { o = JSON.parse(lines[i]); } catch { continue; }
  if (o.type !== 'assistant') { console.log(`line ${i + 1}: type=${o.type} (not assistant)`); continue; }
  const u = o.message.usage || {};
  console.log(`=== line ${i + 1}  ${o.timestamp}  out=${u.output_tokens} cr=${u.cache_read_input_tokens} cc=${u.cache_creation_input_tokens} stop=${o.message.stop_reason}`);
  console.log(`    assistant: ${short(textOf(o))}`);
  // walk back for the preceding user / assistant entries
  for (let j = i - 1, shown = 0; j >= 0 && shown < 4; j--) {
    let p; try { p = JSON.parse(lines[j]); } catch { continue; }
    if (p.type === 'queue-operation') { console.log(`    <- line ${j + 1} queue-operation ${p.operation} ${p.timestamp}`); continue; }
    if (p.type !== 'user' && p.type !== 'assistant') { console.log(`    <- line ${j + 1} ${p.type}`); continue; }
    const c = p.message && p.message.content;
    let desc = '';
    if (Array.isArray(c)) desc = c.map(b => b.type === 'text' ? 'text[' + short(b.text, 200) + ']' : b.type === 'tool_result' ? 'tool_result' : b.type).join(' | ');
    else desc = 'text[' + short(c, 200) + ']';
    console.log(`    <- line ${j + 1} ${p.type} ${p.timestamp} ${desc}`);
    shown++;
  }
  console.log('');
}
