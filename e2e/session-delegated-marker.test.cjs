const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexSessionMeta } = require('../out/backend/sessions');

test('session metadata detects marked user prompts without trusting titles or instructions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-delegated-'));
  const previous = process.env.CODEX_HOME;
  const id = '01a0ec9c-8750-77d3-a880-a9314f3523cc';
  const file = path.join(root, 'sessions', '2026', '10', '15', `rollout-2026-10-15T09-00-00-${id}.jsonl`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    process.env.CODEX_HOME = root;
    const write = prompt => fs.writeFileSync(file, [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'scub-instructions mention 🤖 in prose' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    write('scub-ordinary request');
    assert.equal(codexSessionMeta(`codex:${id}`).delegated, false);
    write('/scub-check 🤖 scub-delegated request with a longer title');
    assert.equal(codexSessionMeta(`codex:${id}`).delegated, true);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
