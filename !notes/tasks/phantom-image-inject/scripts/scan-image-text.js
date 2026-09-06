// Scan a CLI transcript for the "[Image: original ...]" text the user saw as a bubble.
// Prints the SHAPE of each carrying record (no base64), so we can tell whether the text
// is a sibling block of the user message or nested inside a tool_result.
const fs = require('fs');
const readline = require('readline');

const file = process.argv[2];
const needle = process.argv[3] || 'Image: original';

const shape = (c) => {
  if (typeof c === 'string') return `string(${c.length})`;
  if (!Array.isArray(c)) return typeof c;
  return c.map((b) => {
    if (b?.type === 'text') return `text:${JSON.stringify(String(b.text).slice(0, 60))}`;
    if (b?.type === 'image') return `image(${b?.source?.media_type},${String(b?.source?.data || '').length}b64)`;
    if (b?.type === 'tool_result') return `tool_result[${b.tool_use_id}]{${shape(b.content)}}`;
    if (b?.type === 'tool_use') return `tool_use[${b.id}]:${b.name}`;
    return String(b?.type);
  }).join(' | ');
};

let n = 0;
const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
rl.on('line', (line) => {
  n++;
  if (!line.includes(needle)) return;
  let rec;
  try { rec = JSON.parse(line); } catch { console.log(`line ${n}: unparseable`); return; }
  console.log(`--- line ${n} type=${rec.type} role=${rec.message?.role} sidechain=${rec.isSidechain} toolUseResult=${rec.toolUseResult ? typeof rec.toolUseResult : '-'}`);
  console.log(`    content: ${shape(rec.message?.content ?? rec.content)}`);
});
rl.on('close', () => console.log(`\nscanned ${n} lines`));
