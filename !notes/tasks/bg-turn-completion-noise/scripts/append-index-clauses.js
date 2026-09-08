// Append a clause to a common/ doc's Summary cell in BOTH index copies in one run,
// so the two cannot drift. Idempotent: re-running detects the marker and skips.
// Usage: node "!notes/tasks/bg-turn-completion-noise/scripts/append-index-clauses.js"
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..'); // repo root
const FILES = ['!notes/common/INDEX.md', '!notes/INDEX.md'];

const EDITS = [
  {
    doc: 'cli-turn-boundaries.md',
    marker: 'also arrives as a user record',
    clause:
      'the same notification **also arrives as a user record** whose only mark is that same `origin.kind` ' +
      '(no `isMeta`/`isVisibleInTranscriptOnly`, so the `isSynthetic` test is false for it): live it is dropped ' +
      'only by accident, on replay it must both be hidden and `finalize()` the turn, or a whole watch merges ' +
      'into one message',
  },
  {
    doc: 'development.md',
    marker: 'source is CRLF while `!notes/` is LF',
    clause:
      'source is CRLF while `!notes/` is LF, so a script anchoring a replacement on `\\n` silently matches ' +
      'nothing in a `.ts` file (a "verify red" that reverted nothing and then passed)',
  },
  {
    doc: 'e2e-testing.md',
    marker: 'never edit `src/backend/` while a suite is running',
    clause:
      'never edit `src/backend/` while a suite is running - `scripts/dev.js` watches it and the restart drops ' +
      'every client mid-test, which looks like the cascade or a flake in an unrelated spec (a run that survived ' +
      'one is what makes the habit stick)',
  },
];

let changed = 0;
for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let touched = false;

  for (const edit of EDITS) {
    const i = lines.findIndex(
      l => l.trimStart().startsWith('|') && l.includes('](') && l.includes(edit.doc)
    );
    if (i === -1) {
      console.log('ROW NOT FOUND:', rel, edit.doc);
      continue;
    }
    if (lines[i].includes(edit.marker)) {
      console.log('already applied:', rel, edit.doc);
      continue;
    }
    lines[i] = lines[i].replace(/\s*\|\s*$/, '; ' + edit.clause + ' |');
    touched = true;
    changed++;
    console.log('appended:', rel, edit.doc, '->', lines[i].length, 'chars');
  }

  if (touched) fs.writeFileSync(file, lines.join(eol));
}
console.log(changed ? 'rows updated: ' + changed : 'nothing to do');
