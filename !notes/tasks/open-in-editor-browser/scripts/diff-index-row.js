const fs = require('fs');
const path = require('path');

const doc = process.argv[2];
if (!doc) { console.error('usage: node diff-index-row.js <doc-filename.md>'); process.exit(1); }

const pick = (f, d) => fs.readFileSync(f, 'utf8').split(/\r?\n/).find(l => l.includes(d) && l.trimStart().startsWith('|'));
const cell = (l) => l.split('|').slice(1, -1).map(s => s.trim());

const commonFile = path.resolve(__dirname, '../../../common/INDEX.md');
const rootFile = path.resolve(__dirname, '../../../INDEX.md');

const a = cell(pick(commonFile, doc));
const b = cell(pick(rootFile, doc));

console.log('common/INDEX.md cells:', a.length, 'root INDEX.md cells:', b.length);
console.log('File col identical:', a[0] === b[0], JSON.stringify(a[0]), 'vs', JSON.stringify(b[0]));
console.log('Topic col identical:', a[1] === b[1], JSON.stringify(a[1]), 'vs', JSON.stringify(b[1]));
console.log('Summary identical:', a[2] === b[2], 'len', a[2].length, 'vs', b[2].length);

if (a[2] !== b[2]) {
  // find first differing char
  let i = 0;
  while (i < a[2].length && i < b[2].length && a[2][i] === b[2][i]) i++;
  console.log('First diff at char', i);
  console.log('common:', JSON.stringify(a[2].slice(Math.max(0,i-40), i+60)));
  console.log('root  :', JSON.stringify(b[2].slice(Math.max(0,i-40), i+60)));
}
