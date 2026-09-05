// Find offsets where two strings occur within N bytes of each other in a large binary.
// Streams the file so a 236MB bundle does not have to be held in memory twice.
const fs = require('fs');
const file = process.argv[2];
const a = process.argv[3];
const b = process.argv[4];
const window = Number(process.argv[5] || 120);
const minOffset = Number(process.argv[6] || 0);

const CHUNK = 1 << 22;
const overlap = Math.max(a.length, b.length) + window;
const fd = fs.openSync(file, 'r');
const size = fs.statSync(file).size;
const buf = Buffer.alloc(CHUNK + overlap);
let pos = minOffset;
let carry = 0;
const hits = [];

while (pos < size) {
  const read = fs.readSync(fd, buf, carry, CHUNK, pos);
  if (read <= 0) break;
  const text = buf.slice(0, carry + read).toString('latin1');
  const base = pos - carry;
  let i = -1;
  while ((i = text.indexOf(a, i + 1)) !== -1) {
    const from = Math.max(0, i - window);
    const near = text.slice(from, i + a.length + window);
    if (near.includes(b)) hits.push(base + i);
  }
  carry = Math.min(overlap, carry + read);
  buf.copy(buf, 0, carry + read - carry, carry + read);
  pos += read;
}
fs.closeSync(fd);
const uniq = [...new Set(hits)].sort((x, y) => x - y);
console.log(`"${a}" within ${window}b of "${b}": ${uniq.length} hit(s)`);
for (const h of uniq.slice(0, 40)) console.log('  ' + h);
