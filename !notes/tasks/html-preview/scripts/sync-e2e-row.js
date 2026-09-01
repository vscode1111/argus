// e2e-testing.md's Summary cell is ~3.2k chars and lives in two indexes; append the new
// clauses to both from one run so the copies cannot drift. Idempotent via the marker.
const fs = require('fs');

const MARKER = 'Playwright evaluates inside a `sandbox=""` iframe';
const ADD = '; ' + MARKER + ', so assert the **computed** colour there against a fixture painting itself the opposite (an attribute check passes on a build where the sheet never applied) and prove a sandbox by a script that fails to run; a fixture built with `String.raw` silently escaped its own backticks and tested prose instead of a code span, so print the input or assert something only true in the intended context';

const FILES = ['!notes/common/INDEX.md', '!notes/INDEX.md'];
let changed = 0;

for (const file of FILES) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const i = lines.findIndex((l) => l.trimStart().startsWith('|') && l.includes('e2e-testing.md'));
  if (i === -1) { console.log('row not found in', file); continue; }
  if (lines[i].includes(MARKER)) continue;
  const cells = lines[i].split('|');
  // Summary is the last content cell; the row is `| link | topic | summary |`.
  cells[3] = ' ' + cells[3].trim() + ADD + ' ';
  lines[i] = cells.join('|');
  fs.writeFileSync(file, lines.join('\n'));
  changed++;
}
console.log(changed ? `appended to ${changed} row(s)` : 'already in sync');
