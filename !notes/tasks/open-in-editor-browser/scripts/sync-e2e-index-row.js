// Appends the new "--repeat-each + top-level env var" finding to the e2e-testing.md
// Summary cell in both index copies, in one run, so they cannot drift from a hand-edit.
// Idempotent: skips a file that already contains the marker.
const fs = require('fs');

const MARKER = 'silently reverts under `--repeat-each`';
const OLD_TAIL = 'and an env override captured at **import** lets a reused worker read the developer\'s real credential file, surfacing as flakiness - resolve per call and pin the override for every worker |';
const NEW_TAIL = 'and an env override captured at **import** lets a reused worker read the developer\'s real credential file, surfacing as flakiness - resolve per call and pin the override for every worker; and a top-level `process.env` set paired with an `afterAll` delete ' + MARKER + ' - `beforeAll`/`afterAll` re-fire every repeat, top-level module code runs once at import, so the var is only ever set on the first repeat |';

for (const file of ['!notes/common/INDEX.md', '!notes/INDEX.md']) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(MARKER)) { console.log('SKIP (already present):', file); continue; }
  if (!text.includes(OLD_TAIL)) { console.log('NOT FOUND, skipping:', file); continue; }
  fs.writeFileSync(file, text.replace(OLD_TAIL, NEW_TAIL));
  console.log('UPDATED:', file);
}
