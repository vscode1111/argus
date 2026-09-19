// Confirms the buffer-based candidate produces byte-identical output to the original
// readFileSync(utf8)+split implementation, not just "found something".
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { readToolImage } = require(path.resolve('out/backend/sessions.js'));

const SESSION_ID = '8dbb366b-44d5-4b07-bae1-ba0ae03589d8';
const WORKSPACE_DIR = 'd:\\_Projects\\scub111g\\estate-agent';
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
  const buf = fs.readFileSync(file);
  const needle = Buffer.from(toolUseId, 'utf8');
  let from = 0;
  for (;;) {
    const at = buf.indexOf(needle, from);
    if (at === -1) break;
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
        if (img) return img;
      }
    }
  }
  return null;
}

const original = readToolImage(SESSION_ID, WORKSPACE_DIR, TOOL_USE_ID);
const candidate = readToolImageBuffer(TRANSCRIPT, TOOL_USE_ID);

const origHash = crypto.createHash('sha256').update(original.data).digest('hex');
const candHash = crypto.createHash('sha256').update(candidate.data).digest('hex');

console.log('original : mediaType=' + original.mediaType + ' dataLen=' + original.data.length + ' sha256=' + origHash);
console.log('candidate: mediaType=' + candidate.mediaType + ' dataLen=' + candidate.data.length + ' sha256=' + candHash);
console.log('IDENTICAL:', origHash === candHash && original.mediaType === candidate.mediaType);
