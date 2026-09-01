// What do the two path regexes actually do with the reported path? FILE_PATH_RE
// (filePath.tsx) linkifies; WIN_PATH_RE (markdown.tsx) escapes backslashes before the
// markdown parser eats them. They must accept the same class of paths.
const fs = require('fs');

const src = (f, name) => {
  const line = fs.readFileSync(f, 'utf8').split(/\r?\n/).find(l => l.includes(`const ${name}`));
  return line.slice(line.indexOf('/'), line.lastIndexOf('/g') + 2);
};
const FILE_PATH_RE = eval(src('webview/src/utils/filePath.tsx', 'FILE_PATH_RE ='));
const WIN_PATH_RE = eval(src('webview/src/utils/markdown.tsx', 'WIN_PATH_RE ='));
console.log('FILE_PATH_RE', FILE_PATH_RE.source, '\nWIN_PATH_RE ', WIN_PATH_RE.source, '\n');

const CASES = [
  ['reported', String.raw`C:\Users\Admin\.claude\companies\CCS\credentials\.corp-account`],
  ['works today', String.raw`d:\_Projects\CCS\!notes\common\vault-service-env-paths.md`],
  ['hyphen in stem', String.raw`d:\_Projects\CCS\some-file.md`],
  ['dotfile w/ ext', String.raw`C:\Users\Admin\.claude\.credentials.json`],
  ['no extension', String.raw`C:\Users\Admin\.claude\companies\CCS\credentials\corp`],
  ['unix dotfile', `/home/admin/.claude/credentials/.corp-account`],
  ['ext + line', String.raw`d:\_Projects\CCS\file.md:42`],
];

for (const [label, text] of CASES) {
  for (const re of [FILE_PATH_RE, WIN_PATH_RE]) re.lastIndex = 0;
  const link = [...text.matchAll(FILE_PATH_RE)].map(m => m[0]);
  const esc = [...text.matchAll(WIN_PATH_RE)].map(m => m[0]);
  const whole = link.length === 1 && link[0] === text;
  console.log(`${label.padEnd(15)} ${whole ? 'OK  ' : 'BAD '} link=${JSON.stringify(link)}`);
  if (!whole) console.log(`${' '.repeat(20)}dropped=${JSON.stringify(text.replace(link[0] ?? '', ''))} escape=${JSON.stringify(esc)}`);
}
