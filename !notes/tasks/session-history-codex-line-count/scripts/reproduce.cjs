const assert = require('node:assert/strict');
const fs = require('node:fs');
require('tsx/cjs');

const { records } = require('../../../../src/backend/providers/store.ts');
const { codexProvider } = require('../../../../src/backend/providers/codex.ts');
const { sessionFilePath } = require('../../../../src/backend/sessions.ts');

function countText(content) {
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, block) => {
    if (typeof block?.text !== 'string' || !block.text) return total;
    return total + block.text.split('\n').length;
  }, 0);
}

async function main() {
  for (const record of records()) {
    if (record.selection.providerId !== 'codex') continue;
    const file = sessionFilePath(record.id, record.cwd);
    if (!file || !fs.existsSync(file)) continue;
    let nativeLines = 0;
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!raw) continue;
      let item;
      try { item = JSON.parse(raw); } catch { continue; }
      if (item.type !== 'response_item' || item.payload?.type !== 'message') continue;
      if (item.payload.role !== 'user' && item.payload.role !== 'assistant') continue;
      nativeLines += countText(item.payload.content);
    }
    if (!nativeLines) continue;
    const row = (await codexProvider.list(record.cwd)).find(item => item.id === record.id);
    assert.ok(row, 'Saved session is missing from the provider list');
    console.log(JSON.stringify({ nativeLines, listedLines: row.lines }));
    assert.ok(row.lines > 0, 'Codex session with text has a blank line count');
    return;
  }
  throw new Error('No saved Codex session with a readable text transcript was found');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
