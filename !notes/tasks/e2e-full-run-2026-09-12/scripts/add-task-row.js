// Inserts this task's row at the top of the table in BOTH !notes/tasks/INDEX.md and the
// Task notes section of !notes/INDEX.md, byte-identical apart from the link prefix the two
// levels require. Idempotent via the folder slug.
const fs = require('fs');

const SLUG = 'e2e-full-run-2026-09-12';
const MODULE = 'e2e/usage-indicator-integration, !notes/common/e2e-testing (no product code)';
const SUMMARY = 'Full `yarn test:e2e`: **454 passed, 2 failed, 6 skipped, 10 did not run**, '
  + 'mock 333/333 green. `usage-indicator-integration.spec.ts:110` hung on a bare 30s test '
  + 'timeout while its two API-dependent siblings skipped correctly - that asymmetry is the '
  + 'tell, since reaching the skip needs BOTH frames of the two-phase `accountUsage` reply. '
  + 'Its `waitForFrame` attached a listener per call, so nothing listened between waits and '
  + 'two frames sharing a TCP read cost the second; the server writes them in one tick '
  + 'whenever the usage snapshot is warm, because both sends hang off the same promise. '
  + 'Fixed by buffering from construction and **consuming** the queue, plus a cap lowered '
  + '45s -> 25s (above the 30s test timeout it was dead code that deleted the diagnostic). '
  + 'The end-to-end failure was deliberately **not** claimed as reproduced: a red control '
  + '(pre-fix, `--repeat-each=3`, warm) passed every iteration, so the mechanism is '
  + 'demonstrated in isolation while "this is what killed that run" stays a hypothesis - '
  + 'which also weakens the previous 20s -> 45s raise, blamed on a slow spawn the dropped '
  + 'frame explains just as well. `effort-thinking-integration.spec.ts:185` failed for the '
  + 'second day running (16/16 alone); `readConfig`\'s mtime cache checked and killed as a '
  + 'candidate, still unexplained';

// `findSep` locates the separator by position rather than by shape: several tables in the
// root index have identically-shaped separator rows, so a regex match would insert the task
// row into whichever table happens to come first (Common docs).
function findSep(lines, heading) {
  const h = heading ? lines.findIndex(l => l.trim() === heading) : -1;
  if (heading && h < 0) return -1;
  return lines.findIndex((l, n) => n > h && /^\|\s*-+/.test(l));
}

function insert(file, linkPrefix, heading) {
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.includes(`${SLUG}/`)) return `skip (already present): ${file}`;
  const lines = raw.split(/\r?\n/);
  const sep = findSep(lines, heading);
  if (sep < 0) return `NOT FOUND (separator under ${heading ?? 'top'}): ${file}`;
  const row = `| [${SLUG}/](${linkPrefix}${SLUG}/) | ${MODULE} | ${SUMMARY} |`;
  lines.splice(sep + 1, 0, row);
  fs.writeFileSync(file, lines.join('\n'));
  return `patched: ${file} (after line ${sep + 1})`;
}

console.log(insert('!notes/tasks/INDEX.md', '', null));
console.log(insert('!notes/INDEX.md', 'tasks/', '### Task notes'));
