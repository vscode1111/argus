// Write the same Summary cell into both !notes/INDEX.md and !notes/common/INDEX.md, so
// the two copies of a row cannot drift. Adds the row after an anchor row when it is not
// there yet. Idempotent. Run from the repo root.
const fs = require('fs');

const ROWS = {
  'security.md': {
    topic: 'Security hardening',
    summary:
      "WebSocket origin validation, path traversal protection, settings allowlist, process spawning/termination (execFileSync, no shell); a file's own HTML is rendered in `<iframe srcDoc sandbox=\"\">` with no script privileges, because an inline handler in a file off disk would otherwise run in the app's origin under a CSP that allows outbound http(s)",
  },
  'embedded-document-previews.md': {
    topic: 'Previewing a foreign document',
    summary:
      "The three questions every preview of a file we did not author raises: privilege (none - `sandbox=\"\"`, rationale in security.md), theme (a srcdoc frame cannot see the parent's CSS variables, so resolve them in JS and **append** the sheet after the markup - before the doctype means quirks mode - with `!important`, colours only, since painting `thead` amplified one export's own defect), and testing (Playwright evaluates inside a sandboxed frame; assert the **computed** colour against a fixture that paints itself the opposite, and prove the sandbox by a script that fails to run)",
  },
};

const FILES = [
  { path: '!notes/common/INDEX.md', link: (doc) => `(${doc})`, after: '(security.md)' },
  { path: '!notes/INDEX.md', link: (doc) => `(common/${doc})`, after: '(common/security.md)' },
];

let changed = 0;
for (const file of FILES) {
  const lines = fs.readFileSync(file.path, 'utf8').split(/\r?\n/);
  for (const [doc, { topic, summary }] of Object.entries(ROWS)) {
    const row = `| [${doc}]${file.link(doc)} | ${topic} | ${summary} |`;
    const i = lines.findIndex((l) => l.trimStart().startsWith('|') && l.includes(file.link(doc)));
    if (i !== -1) {
      if (lines[i] === row) continue;
      lines[i] = row;
    } else {
      const anchor = lines.findIndex((l) => l.trimStart().startsWith('|') && l.includes(file.after));
      if (anchor === -1) { console.log(`anchor not found for ${doc} in ${file.path}`); continue; }
      lines.splice(anchor + 1, 0, row);
    }
    changed++;
  }
  fs.writeFileSync(file.path, lines.join('\n'));
}
console.log(changed ? `wrote ${changed} row(s)` : 'already in sync');
