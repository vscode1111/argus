// Appends this session's clause to the `common/e2e-testing.md` Summary cell in BOTH index
// copies in one run, so they cannot drift. Idempotent: detects MARKER and skips.
//
// A file rather than `node -e` on purpose - the payload carries backticks and backslashes,
// which cross two escaping layers inline and get silently eaten or fail to match.
const fs = require('fs');

const NOTES = '!notes';
const DOC = 'e2e-testing.md';
const MARKER = 'two frames the server writes in one tick';

const CLAUSE = '; the buffer-from-construction rule is not only about the upgrade - any '
  + 'two frames the server writes in one tick coalesce the same way mid-session (both '
  + '`getAccountUsage` sends hang off one promise, so a warm usage snapshot puts them '
  + 'microtask hops apart), and a two-phase reply means the buffer must be **consumed** or '
  + 'phase 1 is handed back twice; a helper timeout that throws its own message must sit '
  + 'BELOW the 30s test timeout, or Playwright kills the test first and the bare '
  + '`Test timeout of 30000ms exceeded` replaces the line naming the missing frame';

// The row links differ between the two files (`common/e2e-testing.md` in the root index,
// `e2e-testing.md` in the sub-index), so match on the filename and require a table row.
function patch(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.includes(MARKER)) return `skip (already present): ${file}`;
  const lines = raw.split(/\r?\n/);
  const i = lines.findIndex(l => l.trimStart().startsWith('|') && l.includes(DOC));
  if (i < 0) return `NOT FOUND: ${file}`;
  // Append inside the last cell, before the row's trailing pipe.
  const end = lines[i].lastIndexOf('|');
  lines[i] = lines[i].slice(0, end).trimEnd() + CLAUSE + ' |';
  fs.writeFileSync(file, lines.join('\n'));
  return `patched: ${file}`;
}

for (const f of [`${NOTES}/common/INDEX.md`, `${NOTES}/INDEX.md`]) console.log(patch(f));
