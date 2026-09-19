// Isolates raw disk I/O from UTF-8 decode cost: readFileSync as a Buffer (no
// encoding = no decode) vs readFileSync with 'utf8' (decode included), on the same
// real, already-OS-cached transcript file, each run 3x to see caching effects.
const path = require('path');
const fs = require('fs');

const SESSION_ID = '8dbb366b-44d5-4b07-bae1-ba0ae03589d8';
const TRANSCRIPT = path.join(
  process.env.USERPROFILE || 'C:\\Users\\Admin',
  '.claude', 'projects', 'd---Projects-scub111g-estate-agent', SESSION_ID + '.jsonl',
);

function ms(start) { return Number(process.hrtime.bigint() - start) / 1e6; }

console.log('size:', (fs.statSync(TRANSCRIPT).size / (1024 * 1024)).toFixed(1), 'MB\n');

for (let i = 1; i <= 3; i++) {
  let t = process.hrtime.bigint();
  const buf = fs.readFileSync(TRANSCRIPT); // raw Buffer, no decode
  const bufMs = ms(t);

  t = process.hrtime.bigint();
  const str = fs.readFileSync(TRANSCRIPT, 'utf8'); // decode to JS string
  const strMs = ms(t);

  t = process.hrtime.bigint();
  const lines = str.split(/\r?\n/);
  const splitMs = ms(t);

  // Byte-level newline scan on the raw buffer, no decode at all - what a
  // buffer-based candidate fix would pay before it even looks at content.
  t = process.hrtime.bigint();
  let count = 0;
  for (let j = 0; j < buf.length; j++) if (buf[j] === 0x0a) count++;
  const scanMs = ms(t);

  console.log(`run ${i}: readFileSync(Buffer) ${bufMs.toFixed(0)}ms | readFileSync(utf8) ${strMs.toFixed(0)}ms | ` +
    `split ${splitMs.toFixed(0)}ms (${lines.length} lines) | byte newline-scan ${scanMs.toFixed(0)}ms (${count} newlines)`);
}
