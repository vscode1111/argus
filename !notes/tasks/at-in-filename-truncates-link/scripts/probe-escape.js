// What escapeWinPaths actually emits for a path with a mid-segment "@", and whether the
// markdown parser the app uses turns that "@" into a mailto autolink anyway.
// Run: node !notes/tasks/at-in-filename-truncates-link/scripts/probe-escape.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..');
const src = fs.readFileSync(path.join(ROOT, 'webview/src/utils/markdown.tsx'), 'utf8');
const line = src.split('\n').find(l => l.trim().startsWith('const WIN_PATH_RE = /'));
const WIN_PATH_RE = eval(`(${line.slice(line.indexOf('/'), line.lastIndexOf(';'))})`);

// Mirrors escapeWinPaths in markdown.tsx.
const escape = t => t.replace(WIN_PATH_RE, m => m.replace(/[\\@]/g, c => '\\' + c));

const cases = [
  'Asset: d:\\_Projects\\CCS\\apps\\client\\src\\assets\\img\\newYear\\garland@2x.png is the one.',
  'Key at D:\\_Projects\\_tools\\telegram\\out\\@snowy_137.json now.',
];
for (const t of cases) {
  console.log('input  :', t);
  console.log('escaped:', escape(t));
  console.log();
}
