// Writes the same Summary cell into !notes/common/INDEX.md and the Quick lookup section of
// !notes/INDEX.md in one run, so the two copies cannot drift. Idempotent: each edit checks
// for a marker substring and skips if already applied.
//
// Usage: node sync-index-rows.js   (from the repo root)

const fs = require('fs');

const COMMON = '!notes/common/INDEX.md';
const ROOT = '!notes/INDEX.md';

const NEW_SUMMARY =
  'The CLI runs turns of its own and each one emits a `result`: a background task orphaned by a previous CLI process is replayed at `--resume` startup and answered **before** the user\'s queued message (`num_turns: 0`, empty result), so treating it as the end of the turn committed an empty ~1s assistant message and pushed the real answer into the autonomous-turn recovery branch as a second one; `origin.kind` alone cannot filter it, because a legitimate idle background-task turn carries the same kind and dropping that one hangs the spinner forever - gate on who started the turn (`s.autonomousTurn`), with the watchdog as the safety net';

const E2E_APPEND =
  '; turn *duration* is model-owned too, so pin a live turn open with a foreground Bash `sleep` instead of a long generation prompt, and tighten a prompt rather than loosen an assertion; a live-API skip guard is probed once while the real fetch can 429 just after it, so the spec fails on the correct no-data fallback - never re-run usage-dependent specs back-to-back with the full suite';

/** Insert `line` immediately after the row linking to `afterDoc`. */
function insertRow(file, afterDoc, line, marker) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(marker)) return `${file}: already present, skipped`;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(l => l.trimStart().startsWith('|') && l.includes(afterDoc));
  if (at === -1) throw new Error(`${file}: anchor row for ${afterDoc} not found`);
  lines.splice(at + 1, 0, line);
  fs.writeFileSync(file, lines.join('\n'));
  return `${file}: inserted after ${afterDoc}`;
}

/** Append `extra` to the end of the Summary cell of the row linking to `doc`. */
function appendToSummary(file, doc, extra, marker) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(marker)) return `${file}: already appended, skipped`;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(l => l.trimStart().startsWith('|') && l.includes(doc));
  if (at === -1) throw new Error(`${file}: row for ${doc} not found`);
  const row = lines[at].replace(/\s*\|\s*$/, '');
  lines[at] = `${row}${extra} |`;
  fs.writeFileSync(file, lines.join('\n'));
  return `${file}: appended to ${doc}`;
}

const MARKER = 'gate on who started the turn';
const E2E_MARKER = 'pin a live turn open with a foreground Bash';

console.log(insertRow(COMMON, '(cli-bundle-mining.md)',
  `| [cli-turn-boundaries.md](cli-turn-boundaries.md) | Which CLI \`result\` ends the user's turn | ${NEW_SUMMARY} |`,
  MARKER));
console.log(insertRow(ROOT, '(common/cli-bundle-mining.md)',
  `| [common/cli-turn-boundaries.md](common/cli-turn-boundaries.md) | Which CLI \`result\` ends the user's turn | ${NEW_SUMMARY} |`,
  MARKER));

console.log(appendToSummary(COMMON, '(e2e-testing.md)', E2E_APPEND, E2E_MARKER));
console.log(appendToSummary(ROOT, '(common/e2e-testing.md)', E2E_APPEND, E2E_MARKER));
