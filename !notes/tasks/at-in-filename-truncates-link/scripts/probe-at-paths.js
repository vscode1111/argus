// The reported case: a filename starting with "@" (`out\@snowy_137.json`).
// Both regexes are pulled out of the source at runtime, not copied, so this cannot
// pass against a probe that has drifted from the shipped code.
//
// Checks the pair in the two contexts they run in:
//   prose     - escape pass first (markdown would eat the backslashes), then linkify;
//   code span - escaping is skipped, the linkifier sees the literal text.
// Run: node !notes/tasks/at-in-filename-truncates-link/scripts/probe-at-paths.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

function extractRegex(file, name) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const line = src.split('\n').find(l => l.trim().startsWith(`const ${name} = /`));
  if (!line) throw new Error(`${name} not found in ${file}`);
  const body = line.slice(line.indexOf('/'), line.lastIndexOf(';'));
  return { re: eval(`(${body})`), text: body };
}

const { re: FILE_PATH_RE, text: fpSrc } = extractRegex('webview/src/utils/filePath.tsx', 'FILE_PATH_RE');
const { re: WIN_PATH_RE, text: wpSrc } = extractRegex('webview/src/utils/markdown.tsx', 'WIN_PATH_RE');
console.log('FILE_PATH_RE from source:\n ', fpSrc);
console.log('WIN_PATH_RE  from source:\n ', wpSrc, '\n');

const escapeWinPaths = t => t.replace(WIN_PATH_RE, m => m.replace(/\\/g, '\\\\'));
// What the markdown parser does to an escaped string: `\\` -> `\`.
const renderMarkdown = t => t.replace(/\\(.)/g, '$1');
const firstLink = t => { FILE_PATH_RE.lastIndex = 0; const m = FILE_PATH_RE.exec(t); return m ? m[0] : ''; };

// The reported path, from the session at
// http://localhost:5173/?dir=d%3A%5C_Projects%5CGMTrade&session=6cbf4cbd-afda-4e43-8d32-44af9de707d1
const REPORTED = 'D:\\_Projects\\_tools\\telegram\\out\\@snowy_137.json';

const cases = [
  // [label, text as the model wrote it, expected link, prose? ]
  ['reported, code span',    REPORTED,                                               REPORTED, false],
  ['reported, prose',        'ключ лежит в ' + REPORTED + ' - удалить',               REPORTED, true],
  ['@ file, no drive',       'см. out\\@snowy_137.json тут',                          'out\\@snowy_137.json', true],
  ['@ dir, windows',         'D:\\p\\node_modules\\@types\\node\\index.d.ts',         'D:\\p\\node_modules\\@types\\node\\index.d.ts', false],
  ['@ dir, unix',            '/home/u/node_modules/@types/node/index.d.ts',           '/home/u/node_modules/@types/node/index.d.ts', false],
  ['@ dir, relative',        'node_modules/@types/node/index.d.ts',                   'node_modules/@types/node/index.d.ts', false],
  ['@ file, unix',           '/home/u/telegram/out/@snowy_137.json',                  '/home/u/telegram/out/@snowy_137.json', false],
  ['@ file with :line',      REPORTED + ':12',                                        REPORTED + ':12', false],
  // Regressions the widening must not cause. A handle and an address are the two
  // shapes of "@" that are not paths, and both appear in the same reported session.
  ['telegram handle',        '@snowy_137 now has a DM',                               '', true],
  ['handle after path',      'D:\\_Projects\\out\\ @snowy_137 писал',                 'D:\\_Projects\\out\\', true],
  ['email in prose',         'write to john@corp.com about it',                       '', true],
  ['email after a folder',   'see docs/john@corp.com for that',                       '', true],
  ['email, unix-ish',        'mail /home/john@corp.com now',                          '', true],
  // Cases the previous fixes bought, re-asserted so this widening cannot undo them.
  ['bang folder',            'см. D:\\_Projects\\CCS\\!notes\\tasks\\x.md тут',       'D:\\_Projects\\CCS\\!notes\\tasks\\x.md', true],
  ['hyphenated dotfile',     'ключ в C:\\Users\\a\\.claude\\creds\\.corp-account',    'C:\\Users\\a\\.claude\\creds\\.corp-account', true],
  ['http endpoint',          'GET /api/probes/headers',                               '', true],
  ['elided path C:\\...',    'лежит в C:\\... где-то',                                '', true],
  ['prose and/or',           'use this and/or that',                                  '', true],
];

let fails = 0;
for (const [label, input, want, prose] of cases) {
  // Prose: escape, let markdown unescape, then linkify what the user sees.
  // Code span: the text reaches the linkifier untouched.
  const seen = prose ? renderMarkdown(escapeWinPaths(input)) : input;
  const link = firstLink(seen);
  const backslashesKept = seen === input;
  const ok = link === want && backslashesKept;
  if (!ok) fails++;
  console.log(
    (ok ? 'ok   ' : 'FAIL ') + label.padEnd(22) +
    ' link=' + JSON.stringify(link) +
    (backslashesKept ? '' : '  BACKSLASHES MANGLED -> ' + JSON.stringify(seen))
  );
  if (!ok && link !== want) console.log('      wanted ' + JSON.stringify(want));
}

// The bug is not "no link" but "a link to something else": the truncated prefix is a
// real directory, so the click opened a folder listing instead of the file.
const link = firstLink(REPORTED);
console.log('\nreported path  :', REPORTED);
console.log('link           :', JSON.stringify(link), link === REPORTED ? '(FULL)' : '(PREFIX)');
console.log('link exists    :', fs.existsSync(link) ? 'yes - clicking opens THAT instead' : 'no');
console.log('is a directory :', link && fs.existsSync(link) && fs.statSync(link).isDirectory() ? 'yes' : 'no');

console.log(fails ? '\n' + fails + ' FAILING' : '\nall cases pass');
process.exit(fails ? 1 : 0);
