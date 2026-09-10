// Adds the session-liveness-signals row to common/INDEX.md and mirrors it byte-identical
// into the root INDEX.md Quick lookup. Idempotent: skips if the row is already present.
const fs = require('fs');

const ROW = '| [session-liveness-signals.md](session-liveness-signals.md) | Telling whether a CLI session is working right now | Transcript mtime cannot answer it (0 writes in 10s on a session that was mid-turn - the CLI writes at message boundaries), CPU% ranges overlap between idle and busy, so only the server\'s own registry knows and a foreign process must render `-`, never `no`; check all three states against ground truth with a foreground `sleep`, since turn duration is model-owned |';

function insertAfter(file, anchorSubstr, row, pathPrefix) {
  let t = fs.readFileSync(file, 'utf8');
  const rowOut = pathPrefix ? row.replace('](session-liveness-signals.md)', '](common/session-liveness-signals.md)') : row;
  if (t.includes('session-liveness-signals.md')) { console.log('already present:', file); return; }
  const lines = t.split(/\r?\n/);
  const i = lines.findIndex(l => l.includes(anchorSubstr));
  if (i < 0) { console.log('ANCHOR NOT FOUND in', file); process.exitCode = 1; return; }
  lines.splice(i + 1, 0, rowOut);
  fs.writeFileSync(file, lines.join('\n'));
  console.log('inserted into', file, 'after line', i + 1);
}

insertAfter('!notes/common/INDEX.md', 'request-reply-invariant.md', ROW, false);
insertAfter('!notes/INDEX.md', 'request-reply-invariant.md', ROW, true);
