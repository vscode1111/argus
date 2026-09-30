const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('saved native session reports its text lines in the workspace list', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-session-lines-'));
  const previousHome = process.env.CODEX_HOME;
  const previousConfig = process.env.ARGUS_CONFIG;
  const previousPoll = process.env.ARGUS_USAGE_POLL;
  process.env.CODEX_HOME = root;
  process.env.ARGUS_CONFIG = path.join(root, 'scub-settings.json');
  process.env.ARGUS_USAGE_POLL = '0';
  let server;
  let browser;
  try {
    require('tsx/cjs');
    const { codexProvider } = require('../src/backend/providers/codex.ts');
    const { saveSession } = require('../src/backend/providers/store.ts');
    const id = '01a0ec9c-8750-77d3-a880-a9314f3523cc';
    const workspace = path.join(root, 'scub-workspace');
    const file = path.join(root, 'sessions', '2026', '09', '30', `rollout-2026-09-30T12-00-00-${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(workspace);
    fs.writeFileSync(file, [
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'scub-hidden' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'scub-one\nscub-two' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'scub-three\nscub-four\nscub-five' }] } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    saveSession({ id: `${codexProvider.descriptor.id}:${id}`, cwd: workspace, title: 'scub-session', updatedAt: Date.now(),
      selection: { providerId: codexProvider.descriptor.id, model: 'scub-model', effort: '', thinking: true } });
    const rows = await codexProvider.list(workspace);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lines, 5);
    fs.appendFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'scub-six\nscub-seven' }] } }) + '\n');
    const updated = await codexProvider.list(workspace);
    assert.equal(updated[0].lines, 7);

    const { startServer } = require('../out/backend/index');
    const { chromium } = require('@playwright/test');
    server = await startServer({ port: 0 });
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/?dir=${encodeURIComponent(workspace)}`);
    await page.getByRole('button', { name: 'Session history' }).click();
    const dialog = page.getByRole('dialog', { name: 'Session History' });
    const row = dialog.locator('[data-session-id]').filter({ hasText: 'scub-session' });
    await row.locator('[class*="rowCount"]').getByText('7', { exact: true }).waitFor();
    await dialog.getByRole('tab', { name: 'All workspaces' }).click();
    const globalRow = dialog.locator('[data-session-id]').filter({ hasText: 'scub-session' });
    await globalRow.locator('[class*="rowCount"]').getByText('7', { exact: true }).waitFor();
  } finally {
    await browser?.close();
    server?.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.ARGUS_CONFIG; else process.env.ARGUS_CONFIG = previousConfig;
    if (previousPoll === undefined) delete process.env.ARGUS_USAGE_POLL; else process.env.ARGUS_USAGE_POLL = previousPoll;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
