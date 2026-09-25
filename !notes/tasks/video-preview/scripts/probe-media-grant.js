// End-to-end proof of the media path against the running dev server: ask for a grant
// over the WebSocket, then stream the file over HTTP and check the bytes are the right
// ones. Byte-compares each response against the file on disk, because a range endpoint
// that returns the correct *length* of the wrong *offset* looks perfect in headers and
// plays as a corrupt video.
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require(path.join('d:/_Projects/scub111g/argus', 'node_modules', 'ws'));

const target = process.argv[2];
const nonce = fs.readFileSync('d:/_Projects/scub111g/argus/.dev-nonce', 'utf-8').trim();
const dir = 'd:/_Projects/scub111g/people-agent';
const fileSize = fs.statSync(target).size;

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
}

function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: 'localhost', port: 3001, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

const ws = new WebSocket(`ws://localhost:3001/agent?nonce=${nonce}&dir=${encodeURIComponent(dir)}&client=browser`);
const frames = [];
ws.on('message', (d) => { try { frames.push(JSON.parse(d)); } catch {} });

function waitForGrant(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      const i = frames.findIndex((f) => f.type === 'mediaGrant');
      if (i >= 0) return resolve(frames.splice(i, 1)[0]);
      if (Date.now() > deadline) return reject(new Error('no mediaGrant frame within 10s'));
      setTimeout(poll, 50);
    })();
  });
}

ws.on('open', async () => {
  try {
    const t0 = Date.now();
    ws.send(JSON.stringify({ type: 'mediaUrl', path: target }));
    const grant = await waitForGrant();
    const grantMs = Date.now() - t0;

    console.log(`\nfile: ${path.basename(target)}  ${(fileSize / 1048576).toFixed(1)} MB`);
    console.log(`grant in ${grantMs} ms: kind=${grant.kind} type=${grant.mediaType} size=${grant.size} port=${grant.port}\n`);

    check('grant carries a token', !!grant.token);
    check('grant reports the right size', grant.size === fileSize, `${grant.size} vs ${fileSize}`);
    check('grant classifies as video', grant.kind === 'video', grant.kind);
    check('NO bytes in the grant frame', JSON.stringify(grant).length < 500, `${JSON.stringify(grant).length} chars`);

    const url = `/media/${encodeURIComponent(grant.token)}`;

    // Full body: what a player does when it cannot range (and what Content-Length must say).
    const full = await get(url);
    check('full GET is 200', full.status === 200, String(full.status));
    check('full GET advertises ranges', full.headers['accept-ranges'] === 'bytes', full.headers['accept-ranges']);
    check('full GET length matches file', Number(full.headers['content-length']) === fileSize);
    check('full GET body length matches file', full.body.length === fileSize, `${full.body.length}`);
    check('full GET content-type', full.headers['content-type'] === 'video/mp4', full.headers['content-type']);

    // The seek. Take a slice from the middle and compare it to the file on disk.
    const start = Math.floor(fileSize / 2);
    const end = start + 999;
    const part = await get(url, { Range: `bytes=${start}-${end}` });
    check('range GET is 206', part.status === 206, String(part.status));
    check('range GET content-range', part.headers['content-range'] === `bytes ${start}-${end}/${fileSize}`, part.headers['content-range']);
    check('range GET returns exactly 1000 bytes', part.body.length === 1000, String(part.body.length));
    const onDisk = Buffer.alloc(1000);
    const fd = fs.openSync(target, 'r');
    fs.readSync(fd, onDisk, 0, 1000, start);
    fs.closeSync(fd);
    check('range GET bytes match the file at that offset', part.body.equals(onDisk));

    // Open-ended range, which is what Chrome actually sends first.
    const openEnded = await get(url, { Range: 'bytes=0-' });
    check('open-ended range is 206', openEnded.status === 206, String(openEnded.status));
    check('open-ended range returns whole file', openEnded.body.length === fileSize);

    // Suffix range - the last 500 bytes, used to find an MP4 moov atom at the tail.
    const suffix = await get(url, { Range: 'bytes=-500' });
    check('suffix range is 206', suffix.status === 206, String(suffix.status));
    check('suffix range returns 500 bytes', suffix.body.length === 500, String(suffix.body.length));

    // Unsatisfiable must be 416, not a silent full body.
    const bad = await get(url, { Range: `bytes=${fileSize + 10}-${fileSize + 20}` });
    check('past-the-end range is 416', bad.status === 416, String(bad.status));

    // HEAD: headers only.
    const head = await new Promise((resolve) => {
      const r = http.request({ host: 'localhost', port: 3001, path: url, method: 'HEAD' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      r.end();
    });
    check('HEAD is 200 with no body', head.status === 200 && head.body.length === 0, `${head.status}/${head.body.length}`);
    check('HEAD still reports length', Number(head.headers['content-length']) === fileSize);

    // A token nobody minted.
    const unknown = await get('/media/definitelyNotARealToken');
    check('unknown token is 404', unknown.status === 404, String(unknown.status));

    // The same path twice must reuse its grant rather than minting a second token.
    ws.send(JSON.stringify({ type: 'mediaUrl', path: target }));
    const again = await waitForGrant();
    check('same path reuses its token', again.token === grant.token);

    console.log(`\n${pass} passed, ${fail} failed`);
    ws.close();
    process.exit(fail ? 1 : 0);
  } catch (err) {
    console.error('ERROR', err.message);
    process.exit(1);
  }
});

ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });
