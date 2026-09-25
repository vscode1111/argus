// What the backend actually answers when a .mp4 path is clicked.
//
// Isolates the server half of the reported "endless spinner": talks raw WS to the
// running dev server on :3001, sends one readFilePreview for a real video file, and
// reports how big the reply is and how long it took. No browser, no React, so a hang
// here and a hang in the renderer cannot be confused for each other.
//
// Usage: node probe-mp4-preview.js <abs-path-to-file>
const fs = require('fs');
const path = require('path');
const WebSocket = require(path.join('d:/_Projects/scub111g/argus', 'node_modules', 'ws'));

const target = process.argv[2];
if (!target) {
  console.error('usage: node probe-mp4-preview.js <abs-path>');
  process.exit(1);
}

const nonce = fs.readFileSync('d:/_Projects/scub111g/argus/.dev-nonce', 'utf-8').trim();
const dir = 'd:/_Projects/scub111g/people-agent';
const url = `ws://localhost:3001/agent?nonce=${nonce}&dir=${encodeURIComponent(dir)}&client=browser`;

const fileBytes = fs.statSync(target).size;
console.log(`file: ${path.basename(target)} (${(fileBytes / 1048576).toFixed(1)} MB)`);

const ws = new WebSocket(url);
let sentAt = 0;
let bytes = 0;

// Buffer from construction: a reply can share a TCP read with other frames.
ws.on('message', (data) => {
  bytes += data.length;
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.type !== 'filePreview') return;
  const ms = Date.now() - sentAt;
  const content = String(msg.content ?? '');
  console.log(`filePreview reply after ${ms} ms`);
  console.log(`  frame bytes      : ${data.length} (${(data.length / 1048576).toFixed(1)} MB)`);
  console.log(`  blowup vs file   : ${(data.length / fileBytes).toFixed(2)}x`);
  console.log(`  content chars    : ${content.length}`);
  console.log(`  newlines (= rendered line elements): ${(content.match(/\n/g) || []).length}`);
  console.log(`  looks like text? : ${/^[\x09\x0a\x0d\x20-\x7e]*$/.test(content.slice(0, 200)) ? 'yes' : 'NO - binary'}`);
  console.log(`  first 60 chars   : ${JSON.stringify(content.slice(0, 60))}`);
  ws.close();
  process.exit(0);
});

ws.on('open', () => {
  sentAt = Date.now();
  ws.send(JSON.stringify({ type: 'readFilePreview', path: target }));
});

ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });

setTimeout(() => {
  console.log(`NO filePreview reply within 60s (received ${bytes} bytes of other frames)`);
  process.exit(2);
}, 60_000);
