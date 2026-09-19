// Times the OLD (readFileSync(utf8)+split, current sessions.ts) and NEW (buffer
// byte-scan) implementations against the synthetic 60MB fixture, to pick a
// regression-test time threshold grounded in real numbers rather than a guess.
const path = require('path');
const fs = require('fs');

const FIXTURE = path.join(__dirname, 'fixture-large-transcript.jsonl');
const TOOL_USE_ID = 'toolu_01scubTargetImage000001';

function imageFromBlock(part) {
  if (part && part.type === 'image' && part.source && part.source.type === 'base64') {
    return { data: part.source.data, mediaType: part.source.media_type };
  }
  return null;
}

function readOld(file, toolUseId) {
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    if (!line || !line.includes(toolUseId)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const blocks = o.message && o.message.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b.type !== 'tool_result' || b.tool_use_id !== toolUseId) continue;
      const inner = Array.isArray(b.content) ? b.content : [b.content];
      for (const part of inner) { const img = imageFromBlock(part); if (img) return img; }
    }
  }
  return null;
}

function readNew(file, toolUseId) {
  const buf = fs.readFileSync(file);
  const needle = Buffer.from(toolUseId, 'utf8');
  let from = 0;
  for (;;) {
    const at = buf.indexOf(needle, from);
    if (at === -1) return null;
    let start = buf.lastIndexOf(0x0a, at);
    start = start === -1 ? 0 : start + 1;
    let end = buf.indexOf(0x0a, at);
    if (end === -1) end = buf.length;
    from = end + 1;
    const line = buf.toString('utf8', start, end);
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const blocks = o.message && o.message.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b.type !== 'tool_result' || b.tool_use_id !== toolUseId) continue;
      const inner = Array.isArray(b.content) ? b.content : [b.content];
      for (const part of inner) { const img = imageFromBlock(part); if (img) return img; }
    }
  }
}

console.log('fixture:', (fs.statSync(FIXTURE).size / (1024 * 1024)).toFixed(1), 'MB\n');
for (let i = 1; i <= 5; i++) {
  let t = process.hrtime.bigint();
  const o = readOld(FIXTURE, TOOL_USE_ID);
  const oldMs = Number(process.hrtime.bigint() - t) / 1e6;
  t = process.hrtime.bigint();
  const n = readNew(FIXTURE, TOOL_USE_ID);
  const newMs = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`run ${i}: OLD ${oldMs.toFixed(0)}ms (found=${!!o})  NEW ${newMs.toFixed(0)}ms (found=${!!n})`);
}
