// Exercises the "@" picker's backing walk against a real workspace, checking the ordering
// the picker renders (each directory emitted before its own contents, alphabetical) and
// that a query keeps a folder's children visible.
import { searchFiles, mentionFor } from '../../../../src/backend/fileSearch';

const WS = process.argv[2] || 'd:/_BiskubFamily/Docs';

const all = searchFiles(WS, '');
console.log(`workspace: ${WS}`);
console.log(`hits: ${all.hits.length}  truncated: ${all.truncated}\n`);
for (const h of all.hits.slice(0, 14)) {
  const kind = h.isDir ? '[D]' : '   ';
  const n = h.childCount != null ? `  n=${h.childCount}` : '';
  console.log(`${kind} ${h.name.slice(0, 50).padEnd(50)} parent=${JSON.stringify(h.parent)}${n}`);
}

const q = searchFiles(WS, 'анталья');
console.log(`\nquery "анталья": ${q.hits.length} hits`);
for (const h of q.hits.slice(0, 6)) console.log(`   ${h.rel}`);

const file = q.hits.find(h => !h.isDir);
const dir = q.hits.find(h => h.isDir);
if (file) console.log(`\ninserts (file) : ${mentionFor(file.rel)}`);
if (dir) console.log(`inserts (dir)  : ${mentionFor(dir.rel)}`);
