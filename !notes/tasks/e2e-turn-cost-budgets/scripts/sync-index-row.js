// Append this task's finding to the e2e-testing.md Summary cell in BOTH index copies in one
// run, so they cannot drift. Idempotent: detects the marker and skips.
// Run from the repo root: node "!notes/tasks/e2e-turn-cost-budgets/scripts/sync-index-row.js"
const fs = require('fs');

const FILES = ['!notes/common/INDEX.md', '!notes/INDEX.md'];
const DOC = 'e2e-testing.md';
const MARKER = 'a turn here is not "a few seconds"';
const ANCHOR = '(flake by machine load, not by logic)';
const ADDITION = ANCHOR + '; **' + MARKER + '** - a fresh session starts at ~77k input tokens ' +
  '(193KB CLAUDE.md), so 5-20s a turn, and specs budgeted before that fail one at a time, a ' +
  'different one each run and never on their own assertion (read the snapshot: the thing under ' +
  'test has usually already passed); three budgets can bind - test timeout, assertion cap, and a ' +
  'hand-rolled `Date.now() + N` that no config change reaches - and a serial file turns one ' +
  'failure into ten "did not run"';

let changed = 0;
for (const f of FILES) {
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes(MARKER)) { console.log('already applied:', f); continue; }
  if (!src.includes(ANCHOR)) { console.log('ANCHOR NOT FOUND:', f); process.exitCode = 1; continue; }
  fs.writeFileSync(f, src.replace(ANCHOR, ADDITION));
  console.log('updated:', f);
  changed++;
}

// Prove the two copies still match on the parsed Summary cell, not the raw line (the link
// path legitimately differs between the two files).
const pick = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).find(l => l.includes(DOC) && l.trimStart().startsWith('|'));
const cell = (l) => l.split('|').slice(1, -1).map(s => s.trim());
const [a, b] = FILES.map(f => cell(pick(f)));
console.log(`changed=${changed} identical=${a[2] === b[2]} len=${a[2].length}/${b[2].length}`);
if (a[2] !== b[2]) process.exitCode = 1;
