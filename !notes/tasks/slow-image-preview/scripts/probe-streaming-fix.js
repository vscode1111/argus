// Toggle experiment: the candidate streaming implementation (readline over a read
// stream, early-exit on match) against the exact same real transcript and tool_use_id
// the original synchronous readFileSync+split implementation was measured against in
// probe-read-tool-image.js. Proves the fix before it is written into sessions.ts.
const path = require('path');
const fs = require('fs');
const readline = require('readline');

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

function readToolImageStreaming(file, toolUseId) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let settled = false;
    let linesScanned = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      rl.close();
      stream.destroy();
      resolve({ result, linesScanned });
    };
    rl.on('line', (line) => {
      linesScanned++;
      if (!line || !line.includes(toolUseId)) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }
      const blocks = o.message && o.message.content;
      if (!Array.isArray(blocks)) return;
      for (const b of blocks) {
        if (b.type !== 'tool_result' || b.tool_use_id !== toolUseId) continue;
        const inner = Array.isArray(b.content) ? b.content : [b.content];
        for (const part of inner) {
          const img = imageFromBlock(part);
          if (img) { finish(img); return; }
        }
      }
    });
    rl.on('close', () => finish(null));
    rl.on('error', () => finish(null));
  });
}

async function main() {
  console.log('transcript:', TRANSCRIPT);
  console.log('size:', (fs.statSync(TRANSCRIPT).size / (1024 * 1024)).toFixed(1), 'MB');

  for (let i = 1; i <= 3; i++) {
    const t = process.hrtime.bigint();
    const { result, linesScanned } = await readToolImageStreaming(TRANSCRIPT, TOOL_USE_ID);
    const took = Number(process.hrtime.bigint() - t) / 1e6;
    console.log(`\nrun ${i}: readToolImageStreaming():`, took.toFixed(0), 'ms ->',
      result ? `found, ${result.mediaType}, ${(result.data.length / 1024).toFixed(0)} KB base64` : 'NOT FOUND',
      `(scanned ${linesScanned} lines before stopping)`);
  }
}

main();
