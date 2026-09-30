const fs = require('node:fs');
require('tsx/cjs');
const { records } = require('../../../../src/backend/providers/store.ts');
const { sessionFilePath } = require('../../../../src/backend/sessions.ts');

const files = records().filter(record => record.selection.providerId === 'codex')
  .map(record => sessionFilePath(record.id, record.cwd))
  .filter(file => file && fs.existsSync(file));
files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
const counts = {};
const shapes = {};
for (const raw of fs.readFileSync(files[0], 'utf8').split(/\r?\n/)) {
  if (!raw) continue;
  let item;
  try { item = JSON.parse(raw); } catch { continue; }
  const payload = item.payload || {};
  const kind = item.type === 'response_item' ? `${item.type}:${payload.type}:${payload.role || ''}` : item.type;
  counts[kind] = (counts[kind] || 0) + 1;
  if (item.type === 'response_item' && !shapes[kind]) shapes[kind] = Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, Array.isArray(value) ? 'array' : typeof value]));
}
console.log(JSON.stringify({ bytes: fs.statSync(files[0]).size, counts, shapes }));
