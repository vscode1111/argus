// Print full raw JSON (pretty) for a line range of a transcript.
const fs = require('fs');
const file = process.argv[2];
const from = Number(process.argv[3]);
const to = Number(process.argv[4] || from);
const maxLen = Number(process.argv[5] || 4000);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
for (let i = from - 1; i < to && i < lines.length; i++) {
  let out;
  try { out = JSON.stringify(JSON.parse(lines[i]), null, 2); } catch { out = lines[i]; }
  if (out.length > maxLen) out = out.slice(0, maxLen) + `\n…truncated (${out.length} chars)`;
  console.log(`----- line ${i + 1} -----`);
  console.log(out);
}
