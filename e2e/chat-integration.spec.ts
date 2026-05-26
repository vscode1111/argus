import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('sending "test" produces a response and at least 5 logs within 30s', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('argus.showLogs', 'true');
  });
  await waitForApp(page);

  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill('test');
  await page.getByRole('button', { name: 'Send' }).click();

  // The "Debug Log (N)" title updates as logs arrive - wait until N >= 5
  const logTitle = page.locator('text=/Debug Log \\(\\d+\\)/');
  await expect(async () => {
    const text = await logTitle.textContent();
    const match = text?.match(/\((\d+)\)/);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeGreaterThanOrEqual(5);
  }).toPass({ timeout: 30_000 });

  // Verify at least one assistant message appeared (the timer element signals completion)
  const timer = page.locator('[class*="responseTime"]');
  await expect(timer.first()).toBeVisible({ timeout: 30_000 });
});
