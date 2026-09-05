// Extract a latin1 window around a byte offset in a large binary (CLI bundle mining).
const fs = require('fs');
const file = process.argv[2];
const offset = Number(process.argv[3]);
const before = Number(process.argv[4] || 1500);
const after = Number(process.argv[5] || 1500);

const start = Math.max(0, offset - before);
const len = before + after;
const fd = fs.openSync(file, 'r');
const buf = Buffer.alloc(len);
const read = fs.readSync(fd, buf, 0, len, start);
fs.closeSync(fd);
process.stdout.write(buf.slice(0, read).toString('latin1'));
