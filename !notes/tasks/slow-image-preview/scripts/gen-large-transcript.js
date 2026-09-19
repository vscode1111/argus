// Builds a synthetic transcript shaped like the real one that triggered the bug:
// many big base64 "screenshot" tool_result lines (with some non-ASCII content mixed
// in, matching the real transcript's Cyrillic/Unicode text), with the target
// tool_use_id's real image nested near the END of the file - the reported worst case.
// Used to calibrate the regression test's time threshold against a size that is fast
// enough to generate/read in a test's beforeAll but still shows the O(file size) bug.
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || path.join(__dirname, 'fixture-large-transcript.jsonl');
const TARGET_MB = Number(process.argv[3] || 60);
const TOOL_USE_ID = process.argv[4] || 'toolu_01scubTargetImage000001';

// ~90KB of base64-ish filler per "screenshot" line, plus some Cyrillic prose mixed
// in elsewhere in the record (mirrors real transcripts having non-ASCII content,
// which is what makes UTF-8 decoding of the whole file costly).
const filler = Buffer.alloc(90_000, 'A').toString('base64').slice(0, 90_000);
const prose = 'Скриншот формы объявления на Авито сохранён и прочитан агентом. ';

function toolUseLine(id) {
  return JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_' + id, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'C:/tmp/shot.png' } }] },
  });
}
function toolResultLine(id, isTarget) {
  const content = isTarget
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: filler } }]
    : [{ type: 'text', text: prose + filler.slice(0, 20_000) }];
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
}

const stream = fs.createWriteStream(OUT);
let bytes = 0;
let n = 0;
const targetBytes = TARGET_MB * 1024 * 1024;
// Reserve the target pair for the very end, matching the real report (97.9% through).
while (bytes < targetBytes) {
  n++;
  const id = 'toolu_01scubFiller' + String(n).padStart(8, '0');
  const l1 = toolUseLine(id) + '\n';
  const l2 = toolResultLine(id, false) + '\n';
  stream.write(l1); stream.write(l2);
  bytes += l1.length + l2.length;
}
stream.write(toolUseLine(TOOL_USE_ID) + '\n');
stream.write(toolResultLine(TOOL_USE_ID, true) + '\n');
stream.end(() => {
  const size = fs.statSync(OUT).size;
  console.log('wrote', OUT, (size / (1024 * 1024)).toFixed(1), 'MB,', n, 'filler pairs, target id:', TOOL_USE_ID);
});
