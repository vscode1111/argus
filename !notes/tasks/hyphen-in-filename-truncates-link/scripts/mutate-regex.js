// Swap the two path regexes between their pre-fix and fixed forms, to run the
// regression spec red. The fix widens the filename suffix, so reverting the whole file
// is not an option (both files carry unrelated uncommitted work from an earlier task).
// Usage: node mutate-regex.js old | node mutate-regex.js new
const fs = require('fs');

const LINES = {
  'webview/src/utils/filePath.tsx': {
    prefix: 'const FILE_PATH_RE =',
    old: String.raw`const FILE_PATH_RE = /((?:(?<![a-zA-Z])[A-Za-z]:[\\\/])[\w.\-!\\\/]+\.\w+|\/(?:[\w.\-!]+\/)+[\w.\-]+\.\w+|(?:[\w.\-@!]+[\\\/])+[\w.\-]+\.\w+)(?::(\d+)(?:-(\d+))?)?/g;`,
    new: String.raw`const FILE_PATH_RE = /((?:(?<![a-zA-Z])[A-Za-z]:[\\\/])[\w.\-!\\\/]+\.\w+(?:-\w+)*|\/(?:[\w.\-!]+\/)+[\w.\-]*\.\w+(?:-\w+)*|(?:[\w.\-@!]+[\\\/])+[\w.\-]*\.\w+(?:-\w+)*)(?::(\d+)(?:-(\d+))?)?/g;`,
  },
  'webview/src/utils/markdown.tsx': {
    prefix: 'const WIN_PATH_RE =',
    old: String.raw`const WIN_PATH_RE = /(?<![a-zA-Z` + '`' + String.raw`])(?:[A-Za-z]:\\|(?:[\w.\-@!]+\\)+)[\w.\-!\\\/]*[\w.\-]+\.\w+(?::\d+(?:-\d+)?)?/g;`,
    new: String.raw`const WIN_PATH_RE = /(?<![a-zA-Z` + '`' + String.raw`])(?:[A-Za-z]:\\|(?:[\w.\-@!]+\\)+)[\w.\-!\\\/]*[\w.\-]*\.\w+(?:-\w+)*(?::\d+(?:-\d+)?)?/g;`,
  },
};

const mode = process.argv[2];
if (mode !== 'old' && mode !== 'new') { console.error('usage: mutate-regex.js old|new'); process.exit(2); }

for (const [file, spec] of Object.entries(LINES)) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(spec.prefix));
  if (i === -1) { console.error('line not found in', file); process.exit(1); }
  lines[i] = spec[mode];
  fs.writeFileSync(file, lines.join('\n'));
  console.log(`${file}: ${mode}`);
}
