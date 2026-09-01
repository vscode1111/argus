// Probe: which spans FILE_PATH_RE claims inside URLs and real paths.
// Run: node "!notes/tasks/url-linkified-as-path/scripts/probe-regex.js"

const FILE_PATH_RE =
  /((?:(?<![a-zA-Z])[A-Za-z]:[\\\/])[\w.\-!\\\/]+\.\w+|\/(?:[\w.\-!]+\/)+[\w.\-]+\.\w+|(?:[\w.\-@!]+[\\\/])+[\w.\-]+\.\w+)(?::(\d+)(?:-(\d+))?)?/g;

const URL_RE = /\b[a-z][a-z0-9+.\-]*:\/\/[^\s<>"'`]+/gi;

const samples = [
  '[WARNING] VMService https://192.168.0.12/ui/scripts/main.js .. invalid VM 1 color',
  '[ERROR] Failed to load resource: 500 (Internal Server Error) @ https://192.168.0.12/sdk:0',
  'see http://localhost:3001/webview.js for the bundle',
  'ws://localhost:3017/agent?nonce=abc',
  'd:\\_Projects\\scub111g\\argus\\webview\\src\\utils\\filePath.tsx:10',
  'src/backend/session.ts:42',
  '/usr/lib/node/index.js:8',
  'D:\\_Projects\\CCS\\!notes\\tasks\\x.md',
];

function pathsOutsideUrls(text) {
  const out = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  let u;
  while ((u = URL_RE.exec(text)) !== null) {
    out.push(...scan(text.slice(last, u.index)));
    last = u.index + u[0].length;
  }
  out.push(...scan(text.slice(last)));
  return out;
}

function scan(text) {
  FILE_PATH_RE.lastIndex = 0;
  return [...text.matchAll(FILE_PATH_RE)].map(m => m[0]);
}

for (const s of samples) {
  console.log(JSON.stringify(s));
  console.log('  now:   ', JSON.stringify(scan(s)));
  console.log('  fixed: ', JSON.stringify(pathsOutsideUrls(s)));
}
