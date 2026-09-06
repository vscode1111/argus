// Print one transcript record with any base64 image data elided.
const fs = require('fs');
const readline = require('readline');

const [file, wanted] = process.argv.slice(2);
const target = Number(wanted);

const elide = (v) => {
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…(${v.length})` : v;
  if (Array.isArray(v)) return v.map(elide);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = k === 'data' ? `<b64 ${String(val).length}>` : elide(val);
    return o;
  }
  return v;
};

let n = 0;
const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
rl.on('line', (line) => {
  n++;
  if (n !== target) return;
  console.log(JSON.stringify(elide(JSON.parse(line)), null, 2));
  rl.close();
});
