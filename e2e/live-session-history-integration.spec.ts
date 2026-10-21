import { test, expect } from './provider-fixtures';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('opening a running session shows its earlier conversation and live turn', { tag: ['@codex'] }, async ({ page, browser }) => {
  test.setTimeout(120_000);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-live-history-ui-'));
  const earlier = 'Which season follows spring? Reply with one word.';
  const current = 'List the integers from 1 to 2000, one per line.';
  const otherContext = await browser.newContext();
  const viewer = await otherContext.newPage();
  let sessionId: string | null = null;

  try {
    await page.goto('/?dir=' + encodeURIComponent(workspace));
    const input = page.getByPlaceholder('Ask Argus');
    await expect(input).toBeVisible();
    await input.fill(earlier);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 60_000 });
    sessionId = new URL(page.url()).searchParams.get('session');
    expect(sessionId).toMatch(/^codex:/);

    await input.fill(current);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();

    await viewer.goto('/?dir=' + encodeURIComponent(workspace));
    await expect(viewer.getByPlaceholder('Ask Argus')).toBeVisible();
    await viewer.getByRole('button', { name: 'Session history' }).click();
    const dialog = viewer.getByRole('dialog', { name: 'Session History' });
    const row = dialog.locator(`[data-session-id="${sessionId}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    await expect(viewer.locator('[class*="messageContent"]').filter({ hasText: earlier })).toBeVisible();
    await expect(viewer.locator('[class*="messageContent"]').filter({ hasText: current })).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Stop' })).toBeVisible();
  } finally {
    if (await page.getByRole('button', { name: 'Stop' }).isVisible().catch(() => false)) {
      await page.getByRole('button', { name: 'Stop' }).click();
      await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 15_000 });
    }
    await otherContext.close();
    if (sessionId) require('../out/backend/providers/store').forgetSession(sessionId);
    try { fs.rmdirSync(workspace); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error; }
  }
});
