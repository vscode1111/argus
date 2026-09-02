// The two path regexes as they are actually written in the source, not a copy:
// the literals are pulled out of filePath.tsx / markdown.tsx at runtime, so this
// cannot pass against a probe that has drifted from the shipped code.
//
// Checks the pair in sequence, which is how they run in prose: escape pass first
// (markdown would otherwise eat the backslashes), linkifier second.
// Run: node !notes/tasks/dir-preview/scripts/probe-live-regex.js
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
const { re: WIN_PATH_RE } = extractRegex('webview/src/utils/markdown.tsx', 'WIN_PATH_RE');
console.log('FILE_PATH_RE from source:\n ', fpSrc, '\n');

const escapeWinPaths = t => t.replace(WIN_PATH_RE, m => m.replace(/\\/g, '\\\\'));
// What the markdown parser does to an escaped string: `\\` -> `\`.
const renderMarkdown = t => t.replace(/\\(.)/g, '$1');
const firstLink = t => { FILE_PATH_RE.lastIndex = 0; const m = FILE_PATH_RE.exec(t); return m ? m[0] : ''; };

const B = '\\';
const REPORTED = 'C:\\Users\\Admin\\.claude\\skills\\git-remarks\\scripts' + B;

const cases = [
  ['reported line, prose',   'Скрипты лежат в ' + REPORTED,                          REPORTED],
  ['reported line, no sep',  'Скрипты лежат в ' + REPORTED.slice(0, -1),             REPORTED.slice(0, -1)],
  ['bang folder',            'см. D:\\_Projects\\CCS\\!notes\\tasks\\x.md тут',      'D:\\_Projects\\CCS\\!notes\\tasks\\x.md'],
  ['hyphenated dotfile',     'ключ в C:\\Users\\Admin\\.claude\\creds\\.corp-account', 'C:\\Users\\Admin\\.claude\\creds\\.corp-account'],
  ['file with :line',        'в D:\\_Projects\\CCS\\Icon.php:305 баг',               'D:\\_Projects\\CCS\\Icon.php:305'],
  ['full stop stays prose',  'лежит в D:\\_Projects\\argus\\src.',                   'D:\\_Projects\\argus\\src'],
  ['unix file still links',  'lives at /home/user/scripts/run.sh',                   '/home/user/scripts/run.sh'],
  ['relative file links',    'see webview/src/App.tsx',                              'webview/src/App.tsx'],
  // False-positive bait. The API paths are not invented: both appeared as links in the
  // reported session the first time the slash branches were widened to accept a
  // trailing separator, which is why that widening was reverted.
  ['http endpoint',          'GET /api/probes/headers',                              ''],
  ['api path, trailing sep', 'path: /api/v4/projects/6829/merge_requests/99/discussions/', ''],
  ['elided path C:\\...',    'лежит в C:' + B + '... где-то',                        ''],
  ['bare drive root',        'на C:' + B + ' мало места',                            ''],
  ['prose and/or',           'use this and/or that',                                 ''],
  ['ratio 24/7',             'works 24/7 here',                                      ''],
];

let fails = 0;
for (const [label, input, want] of cases) {
  // Prose path: escape, let markdown unescape, then linkify what the user sees.
  const seen = renderMarkdown(escapeWinPaths(input));
  const link = firstLink(seen);
  const backslashesKept = seen === input;
  const ok = link === want && backslashesKept;
  if (!ok) fails++;
  console.log(
    (ok ? 'ok   ' : 'FAIL ') + label.padEnd(24) +
    ' link=' + JSON.stringify(link) +
    (backslashesKept ? '' : '  BACKSLASHES MANGLED -> ' + JSON.stringify(seen))
  );
  if (!ok && link !== want) console.log('      wanted ' + JSON.stringify(want));
}

// The link has to be the whole visible path, not a prefix of it: that was the bug.
const seen = renderMarkdown(escapeWinPaths('лежат в ' + REPORTED));
const link = firstLink(seen);
console.log('\nwhole-path check: link is', link === REPORTED ? 'the FULL path' :
  'a PREFIX (' + link + ')');
console.log('exists on disk  :', fs.existsSync(link) ? 'yes' : 'no');

console.log(fails ? '\n' + fails + ' FAILING' : '\nall cases pass');
process.exit(fails ? 1 : 0);
