// Append this session's clauses to the Summary cell of four common/ docs, in BOTH index
// copies, in one run - the root !notes/INDEX.md mirrors common/INDEX.md byte-identically,
// and two hand-edits are how the copies drift.
//
// Idempotent: each entry carries a marker substring; if it is already in the cell the row
// is left alone, so re-running is safe.
//
// NB this file exists because the skill says not to attempt it as an inline `node -e`:
// the clauses are full of backslashes and backticks, and doing it inline mangled this
// very script on the first try (regex literals arrived with their backslashes stripped).
//
//   node "!notes/tasks/remote-access-auth/scripts/sync-index-rows.js"

const fs = require('fs');

const ENTRIES = [
  {
    doc: 'ui-that-reads-as-broken.md',
    marker: 'drops out of table layout',
    clause: "; a `display: flex` cell drops out of table layout entirely, so rows break onto their own line while every assertion still passes; and a block wrapper around an inline input carries the font's strut, so a centred overlay drifts by device (+30px under a tall font, 0 under flex) - assert the invariant `wrapper height == input height`, never a pixel offset",
  },
  {
    doc: 'security.md',
    marker: 'non-local peer address',
    clause: "; remote-access auth gates a **non-local peer address** (never the Origin header, whose absent value was treated as local from anywhere - measured) behind a scrypt password in its own 600-mode file, in-memory sessions and a per-address lockout, and no password configured means refused rather than open",
  },
  {
    doc: 'e2e-testing.md',
    marker: 'workspace size is a hidden variable',
    clause: "; workspace size is a hidden variable - `listSessions` parses every transcript (775ms at 1949 vs 2ms at 30), so a spec racing that reply is intermittent in a long-used workspace and green in a worktree, which reads exactly like a regression until you bisect with `git worktree`; and an env override captured at **import** lets a reused worker read the developer's real credential file, surfacing as flakiness - resolve per call and pin the override for every worker",
  },
  {
    doc: 'backend-restart.md',
    marker: 'no cache headers at all',
    clause: "; the static allowlist went out with **no cache headers at all**, so an already-open browser client keeps a stale bundle and a verified UI fix still reproduces on that device - `Cache-Control: no-cache` now, checked with curl rather than by reloading and squinting",
  },
];

const FILES = ['!notes/common/INDEX.md', '!notes/INDEX.md'];

// Match on the row's FIRST link (its entry), never on a substring: the two files differ
// legitimately in the path (`(security.md)` vs `(common/security.md)`), and a loose
// `includes` would also hit a doc cited inside some other row's summary.
function rowIndex(lines, doc) {
  return lines.findIndex((l) => {
    if (!l.trimStart().startsWith('|')) return false;
    const m = l.match(/\]\(([^)]+)\)/);
    return !!m && (m[1] === doc || m[1] === 'common/' + doc);
  });
}

let changed = 0;
let skipped = 0;

for (const file of FILES) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let touched = false;

  for (const entry of ENTRIES) {
    const i = rowIndex(lines, entry.doc);
    if (i === -1) { console.log('NOT FOUND:', file, entry.doc); continue; }
    if (lines[i].includes(entry.marker)) { skipped++; continue; }

    // Insert before the row's closing pipe, keeping the table shape intact.
    lines[i] = lines[i].replace(/\s*\|\s*$/, entry.clause + ' |');
    touched = true;
    changed++;
  }

  if (touched) fs.writeFileSync(file, lines.join('\n'));
}

console.log(`rows updated: ${changed}, already current: ${skipped}`);

// Verify the two copies agree on the Summary cell, comparing the parsed cell rather than
// the raw line (the link path legitimately differs between them).
//
// A summary may itself contain links, and those are relative to each index's own folder -
// `backend-restart.md` cites `scripts/restart-daemon-detached.js` from common/ and
// `common/scripts/...` from the root. That is correct, not drift, and comparing raw text
// reports it as a 14-character difference; normalise the prefix away before comparing, or
// the next run "repairs" a file that was already right.
// Both halves of a markdown link carry the prefix - the target AND the visible text
// (`[common/scripts/x.js](common/scripts/x.js)` vs `[scripts/x.js](scripts/x.js)`) - so
// stripping only the target still leaves a 7-character "difference" that is not one.
const normalise = (s) => (s === null ? null : s.replace(/\]\(common\//g, '](').replace(/\[common\//g, '['));

for (const entry of ENTRIES) {
  const cell = (file) => {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const i = rowIndex(lines, entry.doc);
    return i === -1 ? null : lines[i].split('|').slice(1, -1).map((s) => s.trim())[2];
  };
  const a = normalise(cell(FILES[0]));
  const b = normalise(cell(FILES[1]));
  console.log(`${entry.doc}: identical=${a === b} len=${a && a.length}/${b && b.length}`);
}
