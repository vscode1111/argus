// Adds the "Extracted to common docs" section to the task note. Idempotent.
const fs = require('fs');
const p = '!notes/tasks/cli-process-list/notes.md';
let t = fs.readFileSync(p, 'utf8');
if (t.includes('## Extracted to common docs')) { console.log('already present'); return; }
const section = `## Extracted to common docs

The reusable half of this task lives outside the task folder; what stays here is the
ticket-specific record. Written during /update-notes:

- [../../common/session-liveness-signals.md](../../common/session-liveness-signals.md) - why transcript mtime and CPU% both fail as "is this session busy" signals, and what does work.
- [../../common/ui-that-reads-as-broken.md](../../common/ui-that-reads-as-broken.md) - two adjacent numbers with different scope/kind, and the three attempts it took to make them readable.
- [../../common/security.md](../../common/security.md) - the client-supplied-pid guard pair on \`killCliProcess\`.
- [../../common/e2e-testing.md](../../common/e2e-testing.md) - testing a destructive action in both directions (guard aimed at the runner's own pid, decoy named as the real target), the \`x\`-not-\`not ok\` reporter trap, and the two load flakes.
- [../../common/development.md](../../common/development.md) - \`src/backend/\` is typechecked by nothing you run day to day.
- [../../../!notes/common/windows-process-introspection.md](../../../!notes/common/windows-process-introspection.md) (company level) - the OS-level half: CIM output shapes, FILETIME CPU math, ancestry, \`taskkill\` semantics.
- [../../../!notes/common/playwright-run-hygiene.md](../../../!notes/common/playwright-run-hygiene.md) (company level) - stopping the developer's dev server wedges their open tab.

`;
t = t.replace('## Decisions', section + '## Decisions');
fs.writeFileSync(p, t);
console.log('extracted-links section added');
