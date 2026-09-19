// Candidate fix #2: read as a raw Buffer (no UTF-8 decode of the whole file), find
// each byte-offset occurrence of the tool_use_id, decode only that one line, and
// stop at the first one that is actually the matching tool_result. Compares against
// the original readFileSync(utf8)+split baseline on the same real transcript.
const path = require('path');
const fs = require('fs');

const SESSION_ID = '8dbb366b-44d5-4b07-bae1-ba0ae03589d8';
const TOOL_USE_ID = 'toolu_018B4rQCgo2PsbhZQZMeATK4';
const TRANSCRIPT = path.join(
  process.env.USERPROFILE || 'C:\\Users\\Admin',
  '.claude', 'projects', 'd---Projects-scub111g-estate-agent', SESSION_ID + '.jsonl',
);

function imageFromBlock(part) {
  if (part && part.type === 'image' && part.source && part.source.type === 'base64') {
    return { data: part.source.data, mediaType: part.source.media_type };
  }
  return null;
}

function readToolImageBuffer(file, toolUseId) {
  const buf = fs.readFileSync(file); // raw bytes, no decode
  const needle = Buffer.from(toolUseId, 'utf8');
  let occurrences = 0;
  let from = 0;
  for (;;) {
    const at = buf.indexOf(needle, from);
    if (at === -1) break;
    occurrences++;
    // Line boundaries around this byte offset: scan for the newline before and after.
    let start = buf.lastIndexOf(0x0a, at);
    start = start === -1 ? 0 : start + 1;
    let end = buf.indexOf(0x0a, at);
    if (end === -1) end = buf.length;
    const line = buf.toString('utf8', start, end);
    from = end + 1;

    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const blocks = o.message && o.message.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b.type !== 'tool_result' || b.tool_use_id !== toolUseId) continue;
      const inner = Array.isArray(b.content) ? b.content : [b.content];
      for (const part of inner) {
        const img = imageFromBlock(part);
        if (img) return { img, occurrences };
      }
    }
  }
  return { img: null, occurrences };
}

console.log('size:', (fs.statSync(TRANSCRIPT).size / (1024 * 1024)).toFixed(1), 'MB\n');

for (let i = 1; i <= 3; i++) {
  const t = process.hrtime.bigint();
  const { img, occurrences } = readToolImageBuffer(TRANSCRIPT, TOOL_USE_ID);
  const took = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`run ${i}: readToolImageBuffer():`, took.toFixed(0), 'ms ->',
    img ? `found, ${img.mediaType}, ${(img.data.length / 1024).toFixed(0)} KB base64` : 'NOT FOUND',
    `(${occurrences} byte-level occurrences of the id checked)`);
}
