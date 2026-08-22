// Appends one clause to the e2e-testing.md Summary row in BOTH indexes, identically.
// The root !notes/INDEX.md mirrors common/INDEX.md byte-for-byte in the Summary cell
// (only the link path differs), so the clause must be applied by the same script to
// both rather than hand-edited twice.
//
// Usage: node "!notes/tasks/session-active-marker/scripts/sync-e2e-index-row.js"
// Idempotent: re-running detects the clause and does nothing.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const files = [
  path.join(repoRoot, '!notes', 'common', 'INDEX.md'),
  path.join(repoRoot, '!notes', 'INDEX.md'),
];

const ANCHOR = "needs an ordering gate against the turn's own `thinking_start`";
const CLAUSE =
  '; an open centered modal blocks every click on the app behind it via its full-viewport ' +
  '`.overlay` (the target passes visible/enabled/stable, only the final hit test fails)';
const MARKER = 'full-viewport';

let changed = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const i = lines.findIndex(l => l.includes('e2e-testing.md') && l.trimStart().startsWith('|'));
  if (i < 0) { console.log('row not found:', file); continue; }
  if (lines[i].includes(MARKER)) { console.log('already present:', file); continue; }
  if (!lines[i].includes(ANCHOR)) { console.log('anchor missing:', file); continue; }
  lines[i] = lines[i].replace(ANCHOR, ANCHOR + CLAUSE);
  fs.writeFileSync(file, lines.join(eol));
  changed++;
  console.log('updated:', file);
}
console.log('files changed:', changed);
