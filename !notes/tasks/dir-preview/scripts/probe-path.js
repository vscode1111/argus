// What does the linkifier actually match in the reported line, and what does the
// host answer for the resulting path? Run: node !notes/tasks/dir-preview/scripts/probe-path.js
const fs = require('fs');

const FILE_PATH_RE = /((?:(?<![a-zA-Z])[A-Za-z]:[\\\/])[\w.\-!\\\/]+\.\w+(?:-\w+)*|\/(?:[\w.\-!]+\/)+[\w.\-]*\.\w+(?:-\w+)*|(?:[\w.\-@!]+[\\\/])+[\w.\-]*\.\w+(?:-\w+)*)(?::(\d+)(?:-(\d+))?)?/g;

const line = 'C:\\Users\\Admin\\.claude\\skills\\git-remarks\\scripts\\';
console.log('input  :', line);
for (const m of line.matchAll(FILE_PATH_RE)) {
  console.log('match  :', JSON.stringify(m[0]), ' -> exists:', fs.existsSync(m[1]),
    ' isDir:', fs.existsSync(m[1]) && fs.statSync(m[1]).isDirectory());
}

for (const p of ['C:\\Users\\Admin\\.claude', 'C:\\Users\\Admin\\.claude\\skills\\git-remarks\\scripts']) {
  try {
    fs.readFileSync(p, 'utf-8');
    console.log('read   :', p, '-> ok');
  } catch (e) {
    console.log('read   :', p, '->', e.message);
  }
}
