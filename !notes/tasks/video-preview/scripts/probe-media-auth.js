// Does /media actually refuse a remote peer?
//
// The gate is `isLocalAddress(req.socket.remoteAddress)`, so it cannot be exercised over
// loopback - every curl from this machine is exempt by design. Reaching the same server
// through its own LAN address makes the peer address non-local, which is the only way to
// see the remote branch run. The same trick the Origin-gate probe uses.
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const WebSocket = require(path.join('d:/_Projects/scub111g/argus', 'node_modules', 'ws'));

const target = process.argv[2];
const nonce = fs.readFileSync('d:/_Projects/scub111g/argus/.dev-nonce', 'utf-8').trim();

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

const lan = lanAddress();
if (!lan) {
  console.log('SKIP: no non-loopback IPv4 address on this machine');
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
};

function get(host, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port: 3001, path: urlPath, headers: { Range: 'bytes=0-99' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

const ws = new WebSocket(`ws://localhost:3001/agent?nonce=${nonce}&dir=${encodeURIComponent('d:/_Projects/scub111g/argus')}&client=browser`);
const frames = [];
ws.on('message', (d) => { try { frames.push(JSON.parse(d)); } catch {} });

ws.on('open', async () => {
  ws.send(JSON.stringify({ type: 'mediaUrl', path: target }));
  const deadline = Date.now() + 10000;
  let grant;
  while (Date.now() < deadline) {
    grant = frames.find((f) => f.type === 'mediaGrant');
    if (grant) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!grant?.token) { console.error('no grant', grant); process.exit(1); }

  console.log(`\nLAN address: ${lan}   (loopback peer is exempt by design)\n`);
  const url = `/media/${encodeURIComponent(grant.token)}`;

  // Control: the same token over loopback must work, or a 401 below would prove nothing.
  const localRes = await get('127.0.0.1', url);
  check('loopback peer is served', localRes.status === 206, String(localRes.status));

  // The real question: the identical URL from a non-local peer address.
  const remoteRes = await get(lan, url);
  check('remote peer WITHOUT a session is refused', remoteRes.status === 401, String(remoteRes.status));
  check('...and gets no bytes', remoteRes.body.length === 0 || !remoteRes.body.includes('ftyp'), `${remoteRes.body.length} bytes`);

  // A forged token from a remote peer must not get past the auth gate either.
  const remoteBogus = await get(lan, '/media/notAToken');
  check('remote peer with a bogus token is refused at auth, not 404', remoteBogus.status === 401, String(remoteBogus.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  ws.close();
  process.exit(fail ? 1 : 0);
});

ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });
