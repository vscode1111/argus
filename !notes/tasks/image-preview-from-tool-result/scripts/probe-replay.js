// What does a replayed session actually ship to the webview for an image Read?
// Runs the compiled loadSession over the reported session and reports, per Read
// tool call: the requested path, whether it still exists on disk, and what the
// `result` string carries (a JSON image block, text, or nothing).
const path = require('path');
const fs = require('fs');
const { loadSession } = require(path.resolve('out/backend/sessions.js'));

const SESSION = process.argv[2] || '7ac16cc8-59bd-4540-ba46-f4b9a50f2815';
const WS = process.argv[3] || 'd:\\_Projects\\scub111g\\estate-agent';

const messages = loadSession(SESSION, WS);
let totalBytes = 0;
let imageResults = 0;
const rows = [];

for (const m of messages) {
  for (const b of m.blocks || []) {
    if (b.type !== 'tool' || b.call.name !== 'Read') continue;
    const p = b.call.input.file_path || '';
    const r = b.call.result || '';
    totalBytes += r.length;
    let kind = 'text';
    if (/^\{"type":"image"/.test(r)) { kind = 'image-json'; imageResults++; }
    else if (!r) kind = 'empty';
    rows.push({ exists: fs.existsSync(p), kind, len: r.length, path: p });
  }
}

const payload = JSON.stringify({ type: 'sessionLoaded', id: SESSION, messages }).length;
console.log(`messages=${messages.length} readCalls=${rows.length} imageResults=${imageResults}`);
console.log(`result bytes total=${(totalBytes / 1e6).toFixed(1)}MB  sessionLoaded payload=${(payload / 1e6).toFixed(1)}MB`);
console.log('--- missing-on-disk Read calls ---');
for (const r of rows.filter(x => !x.exists)) {
  console.log(`${r.kind.padEnd(10)} len=${String(r.len).padStart(9)}  ${r.path}`);
}
