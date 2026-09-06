// Pull context around a literal out of the (native) Claude CLI bundle, so we can see how
// the official client itself tags/filters these synthetic user messages.
// Usage: node scan-bundle.js "<needle>" [radius] [maxHits]
const fs = require('fs');
const path = require('path');

const needle = process.argv[2];
const radius = Number(process.argv[3] || 300);
const maxHits = Number(process.argv[4] || 6);

const bundle = path.join('C:/nvm4w/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const buf = fs.readFileSync(bundle);
const hay = buf.toString('latin1');

let from = 0, hits = 0;
while (hits < maxHits) {
  const i = hay.indexOf(needle, from);
  if (i < 0) break;
  hits++;
  from = i + needle.length;
  const slice = hay.slice(Math.max(0, i - radius), i + needle.length + radius);
  console.log(`=== hit ${hits} @${i} ===`);
  console.log(slice.replace(/[^\x20-\x7e]/g, '·'));
  console.log('');
}
console.log(`hits=${hits} for ${JSON.stringify(needle)}`);
