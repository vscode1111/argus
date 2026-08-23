// Appends a clause to a common/ doc's Summary row in BOTH indexes, identically.
// The root !notes/INDEX.md mirrors common/INDEX.md byte-for-byte in the Summary cell
// (only the link path differs), so the clause must be applied by one script to both
// rather than hand-edited twice, which is how the two copies drift.
//
// Usage: node "!notes/tasks/model-refresh-retry-backoff/scripts/sync-common-index-rows.js"
// Idempotent: re-running detects each marker and does nothing.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const COMMON_INDEX = path.join(repoRoot, '!notes', 'common', 'INDEX.md');
const ROOT_INDEX = path.join(repoRoot, '!notes', 'INDEX.md');

/** @type {{doc:string, anchor:string, clause:string, marker:string}[]} */
const EDITS = [
  {
    doc: 'model-context-windows.md',
    anchor: 'context fill is not a compaction signal',
    clause:
      '; the window is only as fresh as the last successful refresh and an id missing from ' +
      '`modelListCache` falls back to 200k silently (5x-wrong percent on a 1M model), so check ' +
      'the cache before suspecting the arithmetic',
    marker: 'only as fresh as the last successful refresh',
  },
  {
    doc: 'e2e-testing.md',
    anchor: "needs an ordering gate against the turn's own `thinking_start`",
    clause:
      '; when the fix *creates* the function under test, mutate the new function back to the old ' +
      'behaviour instead of reverting (a missing export reds for the wrong reason); `-integration` ' +
      'buys a slot in the serial suite, so a pure-function test on the compiled bundle belongs in `mock`',
    marker: 'mutate the new function back',
  },
];

let changed = 0;
for (const file of [COMMON_INDEX, ROOT_INDEX]) {
  const src = fs.readFileSync(file, 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  let touched = false;

  for (const edit of EDITS) {
    const i = lines.findIndex(l => l.includes(edit.doc) && l.trimStart().startsWith('|'));
    if (i < 0) { console.log('row not found:', edit.doc, 'in', file); continue; }
    if (lines[i].includes(edit.marker)) { console.log('already present:', edit.doc, 'in', file); continue; }
    // Anchor match is case-insensitive so a Summary that capitalises differently across the
    // two copies still lands the clause in the same place.
    const at = lines[i].toLowerCase().indexOf(edit.anchor.toLowerCase());
    if (at < 0) { console.log('anchor missing:', edit.doc, 'in', file); continue; }
    const end = at + edit.anchor.length;
    lines[i] = lines[i].slice(0, end) + edit.clause + lines[i].slice(end);
    touched = true;
  }

  if (touched) { fs.writeFileSync(file, lines.join(eol)); changed++; console.log('updated:', file); }
}
console.log('files changed:', changed);
