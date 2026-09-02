// Widening the path regexes so a directory path links whole.
// Old vs new, over the cases the existing e2e specs pin plus false-positive bait.
// Run: node !notes/tasks/dir-preview/scripts/probe-regex.js
//
// NB: plain quoted strings with doubled backslashes throughout. String.raw cannot be
// used here - a template ending in a backslash escapes its own closing backtick, which
// is how a fixture ends up testing something other than what it reads as.
const fs = require('fs');

const OLD = /((?:(?<![a-zA-Z])[A-Za-z]:[\\\/])[\w.\-!\\\/]+\.\w+(?:-\w+)*|\/(?:[\w.\-!]+\/)+[\w.\-]*\.\w+(?:-\w+)*|(?:[\w.\-@!]+[\\\/])+[\w.\-]*\.\w+(?:-\w+)*)(?::(\d+)(?:-(\d+))?)?/g;

// Windows is drive-anchored, so it can drop the "must end in .ext" requirement
// outright: segments, then either a final segment that does not end in a dot (so a
// sentence's full stop stays prose) or nothing at all (the path ended in a separator).
// Unix and relative keep the extension requirement - without a drive letter "and/or"
// is indistinguishable from a path - and only gain the explicit trailing-separator form.
const WIN = '(?<![a-zA-Z])[A-Za-z]:[\\\\\\/](?:[\\w.\\-!]+[\\\\\\/])*(?:[\\w.\\-!]*[\\w\\-!])?';
const UNIX = '\\/(?:[\\w.\\-!]+\\/)+[\\w.\\-]*\\.\\w+(?:-\\w+)*|\\/(?:[\\w.\\-!]+\\/)+';
// A bare relative directory has no anchor at all - no drive letter, no leading
// slash - so one separator is not evidence of a path: "and/or" and "24/7" both
// matched. Two or more is: "src/backend/" qualifies, prose does not.
const REL = '(?:[\\w.\\-@!]+[\\\\\\/])+[\\w.\\-]*\\.\\w+(?:-\\w+)*|(?:[\\w.\\-@!]+[\\\\\\/]){2,}';
const NEW = new RegExp('(' + WIN + '|' + UNIX + '|' + REL + ')(?::(\\d+)(?:-(\\d+))?)?', 'g');

const B = '\\'; // one literal backslash

const cases = [
  // [label, text, what the link SHOULD be ('' = nothing should linkify)]
  ['reported dir (trailing sep)', 'лежат в C:\\Users\\Admin\\.claude\\skills\\git-remarks\\scripts' + B, 'C:\\Users\\Admin\\.claude\\skills\\git-remarks\\scripts' + B],
  ['dir, no trailing sep',        'смотри C:\\Users\\Admin\\.claude\\skills\\git-remarks',               'C:\\Users\\Admin\\.claude\\skills\\git-remarks'],
  ['file with ext',               'D:\\_Projects\\CCS\\src\\Icon\\IconService.php',                      'D:\\_Projects\\CCS\\src\\Icon\\IconService.php'],
  ['file with :line',             'D:\\_Projects\\CCS\\src\\Icon\\IconService.php:305',                  'D:\\_Projects\\CCS\\src\\Icon\\IconService.php:305'],
  ['bang folder',                 'D:\\_Projects\\CCS\\!notes\\tasks\\x.md',                             'D:\\_Projects\\CCS\\!notes\\tasks\\x.md'],
  ['hyphenated dotfile',          'C:\\Users\\Admin\\.claude\\credentials\\.corp-account',               'C:\\Users\\Admin\\.claude\\credentials\\.corp-account'],
  ['sentence full stop',          'лежит в D:\\_Projects\\argus\\src.',                                  'D:\\_Projects\\argus\\src'],
  ['comma after path',            'в D:\\_Projects\\argus\\src\\backend, потом',                         'D:\\_Projects\\argus\\src\\backend'],
  ['drive root',                  'на C:' + B + ' мало места',                                           'C:' + B],
  ['unix file',                   'lives at /home/user/scripts/run.sh',                                  '/home/user/scripts/run.sh'],
  ['unix dir (trailing sep)',     'лежит в /home/user/scripts/',                                         '/home/user/scripts/'],
  ['relative file',               'see webview/src/App.tsx',                                             'webview/src/App.tsx'],
  ['relative dir (trailing sep)', 'лежит в src/backend/',                                                'src/backend/'],
  // False-positive bait: none of these are paths.
  ['prose and/or',                'use this and/or that',                                                ''],
  ['ratio 24/7',                  'works 24/7 here',                                                     ''],
  ['drive letter inside word',    'abc:' + B + 'foo',                                                    ''],
  ['bare prose',                  'just some prose here',                                                ''],
];

let fails = 0;
const first = (re, text) => { re.lastIndex = 0; const m = re.exec(text); return m ? m[0] : ''; };

console.log('label                        | old                             | new                             | want');
console.log('-'.repeat(135));
for (const [label, text, want] of cases) {
  const o = first(OLD, text);
  const n = first(NEW, text);
  const ok = n === want;
  if (!ok) fails++;
  console.log(
    (ok ? ' ' : 'X') + label.padEnd(28) + '| ' + JSON.stringify(o).padEnd(32) +
    '| ' + JSON.stringify(n).padEnd(32) + '| ' + JSON.stringify(want)
  );
}

console.log('\nresolves on disk:');
for (const p of [
  'C:\\Users\\Admin\\.claude\\skills\\git-remarks\\scripts' + B,
  'C:\\Users\\Admin\\.claude\\credentials\\.corp-account',
]) {
  console.log(' ', fs.existsSync(p) ? 'yes' : 'NO ', p);
}

console.log(fails ? '\n' + fails + ' FAILING' : '\nall cases match');
