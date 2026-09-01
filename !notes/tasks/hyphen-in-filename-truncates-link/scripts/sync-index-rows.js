// Write the same Summary cell into both !notes/INDEX.md and !notes/common/INDEX.md, so
// the two copies of a row cannot drift (they did once, by 220 characters, when the same
// row was typed into each file by hand). Idempotent. Run from the repo root.
const fs = require('fs');

const ROWS = {
  'markdown-file-paths.md': {
    topic: 'File paths in markdown',
    summary:
      'The two path regexes (`WIN_PATH_RE` escape pass / `FILE_PATH_RE` linkifier) must stay in sync, and they fail differently - one mangles the text, the other mis-links it; escaping skips code spans; `!` allowed in dir segments only; relative links navigate only inside the previewer; 5000-char cap; a URL\'s path component matches `FILE_PATH_RE` exactly, so `URL_RE` is matched first and the hit rendered as an external link opened via `openExternal()`; the filename suffix takes hyphens (`\\.\\w+(?:-\\w+)*`), because a hyphenated dotfile (`.corp-account`) otherwise linked a shorter path that does not exist, and the segment may be the whole name (`/etc/.gitignore`); still open: `\\w` is ASCII-only so a path with a Cyrillic segment never linkifies at all, and a dotless final segment silently links a shorter prefix',
  },
};

const FILES = [
  { path: '!notes/common/INDEX.md', link: (doc) => `(${doc})` },
  { path: '!notes/INDEX.md', link: (doc) => `(common/${doc})` },
];

let changed = 0;
for (const file of FILES) {
  const lines = fs.readFileSync(file.path, 'utf8').split(/\r?\n/);
  for (const [doc, { topic, summary }] of Object.entries(ROWS)) {
    const i = lines.findIndex((l) => l.trimStart().startsWith('|') && l.includes(file.link(doc)));
    if (i === -1) { console.log(`row not found: ${doc} in ${file.path}`); continue; }
    const row = `| [${doc}]${file.link(doc)} | ${topic} | ${summary} |`;
    if (lines[i] === row) continue;
    lines[i] = row;
    changed++;
  }
  fs.writeFileSync(file.path, lines.join('\n'));
}
console.log(changed ? `rewrote ${changed} row(s)` : 'already in sync');
