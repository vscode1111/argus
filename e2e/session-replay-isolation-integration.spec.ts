import { test, expect } from './provider-fixtures';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

test('refresh after choosing another idle session shows only that session', { tag: ['@codex'] }, async ({ page }) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'session-replay-ui-'));
  const secondId = randomUUID();
  const projectDir = path.join(os.homedir(), '.claude', 'projects', path.resolve(workspace).replace(/[^a-zA-Z0-9]/g, '-'));
  const transcript = path.join(projectDir, `${secondId}.jsonl`);
  const firstRequest = 'Inspect the first account and reply ready.';
  const secondRequest = 'Inspect the second account.';

  try {
    await page.goto('/?dir=' + encodeURIComponent(workspace));
    const input = page.getByPlaceholder('Ask Argus');
    await expect(input).toBeVisible();
    await input.fill(firstRequest);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);

    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(transcript, [
      { type: 'system', subtype: 'init', cwd: workspace, session_id: secondId },
      { type: 'user', cwd: workspace, message: { role: 'user', content: secondRequest } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');

    await page.getByRole('button', { name: 'Session history' }).click();
    const history = page.getByRole('dialog', { name: 'Session History' });
    const second = history.locator(`[data-session-id="${secondId}"]`);
    await expect(second).toBeVisible({ timeout: 15_000 });
    await second.click();
    await expect(page.locator('[class*="messageContent"]').filter({ hasText: secondRequest })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh current session' }).click();
    await expect(page.locator('[class*="messageContent"]').filter({ hasText: secondRequest })).toBeVisible();
    await expect(page.locator('[class*="messageContent"]').filter({ hasText: firstRequest })).toHaveCount(0);
  } finally {
    if (fs.existsSync(transcript)) fs.unlinkSync(transcript);
    if (fs.existsSync(projectDir)) fs.rmdirSync(projectDir);
    try { fs.rmdirSync(workspace); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error; }
  }
});
