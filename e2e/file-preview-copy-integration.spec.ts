import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

const modalDialog = (page: import('@playwright/test').Page) =>
  page.locator('[role="dialog"]');

const modalLine = (page: import('@playwright/test').Page, n: number) =>
  page.locator(`[data-line="${n}"]`);

test.describe('file preview copy path', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await waitForApp(page);
  });

  test('copy path button copies file path from Read tool preview', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.fill('read the file package.json using the Read tool, nothing else');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for the Read tool call to appear with package.json
    const fileLink = page.locator('[class*="toolFileLink"]', { hasText: 'package.json' });
    await expect(fileLink.first()).toBeVisible({ timeout: 30_000 });

    // Wait for the response to finish
    const timer = page.locator('[class*="responseTime"]');
    await expect(timer.first()).toBeVisible({ timeout: 30_000 });

    // Click the file link to open FileViewerModal
    await expect(async () => {
      await fileLink.first().click();
      await expect(modalLine(page, 1)).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 20_000 });

    // Verify modal is open with file content
    const dialog = modalDialog(page);
    await expect(dialog).toBeVisible();
    await expect(modalLine(page, 1)).toContainText('{');

    // Click the copy path button
    const copyBtn = dialog.locator('button[aria-label="Copy path"]');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    // Verify clipboard contains a path ending with package.json
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toMatch(/package\.json$/);

    // Verify checkmark appears
    const checkmark = copyBtn.locator('path[d="M2 8L6 12L14 4"]');
    await expect(checkmark).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });
});
