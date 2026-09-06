// Generate a large PNG (no deps) so the CLI has to downscale it and emits its
// "[Image: original WxH, displayed at ...]" meta note. Uses scub-* naming.
const fs = require('fs');
const zlib = require('zlib');

const W = 2200, H = 3200;
const out = process.argv[2] || 'scub-big.png';

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 0;   // grayscale
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc(H * (W + 1));
for (let y = 0; y < H; y++) {
  const off = y * (W + 1);
  raw[off] = 0; // filter: none
  for (let x = 0; x < W; x++) raw[off + 1 + x] = ((x >> 5) + (y >> 5)) % 2 ? 40 : 215;
}

fs.writeFileSync(out, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log(`${out} ${W}x${H} ${fs.statSync(out).size} bytes`);
