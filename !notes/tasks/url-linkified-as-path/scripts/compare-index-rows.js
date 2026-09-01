// Compare the Summary cell of a common/ doc's row between !notes/common/INDEX.md and the
// root !notes/INDEX.md Quick lookup, which must stay in sync.
// The File cell and any inner links legitimately differ in depth ("markdown-file-paths.md"
// vs "common/markdown-file-paths.md"), so normalise that prefix before comparing.
// Run: node "!notes/tasks/url-linkified-as-path/scripts/compare-index-rows.js" <doc.md> [...]

const fs = require('fs');

const pickRow = (file, doc) =>
  fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find(l => l.trimStart().startsWith('|') && l.includes(doc));

const cells = line => line.split('|').slice(1, -1).map(s => s.trim());
const normalise = s => s.split('(common/').join('(').split('[common/').join('[');

let bad = 0;
for (const doc of process.argv.slice(2)) {
  const a = pickRow('!notes/common/INDEX.md', doc);
  const b = pickRow('!notes/INDEX.md', doc);
  if (!a || !b) {
    console.log(`MISSING ROW  ${doc}  common=${!!a} root=${!!b}`);
    bad++;
    continue;
  }
  const sa = normalise(cells(a)[2]);
  const sb = normalise(cells(b)[2]);
  console.log(`${sa === sb ? 'in sync ' : 'DRIFTED '} ${doc}  (${sa.length} vs ${sb.length} chars)`);
  if (sa !== sb) {
    bad++;
    const i = [...sa].findIndex((c, n) => c !== sb[n]);
    console.log('  first difference at', i);
    console.log('  common:', JSON.stringify(sa.slice(Math.max(0, i - 40), i + 40)));
    console.log('  root:  ', JSON.stringify(sb.slice(Math.max(0, i - 40), i + 40)));
  }
}
process.exit(bad ? 1 : 0);
