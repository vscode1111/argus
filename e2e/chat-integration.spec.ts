import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('sending "test" produces an assistant response within 60s', async ({ page }) => {
  await waitForApp(page);

  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill('test');
  await page.getByRole('button', { name: 'Send' }).click();

  // Wait for streaming to start, then complete (Stop disappears when done).
  const stopBtn = page.getByRole('button', { name: 'Stop' });
  await expect(stopBtn).toBeVisible({ timeout: 10_000 });
  await expect(stopBtn).toHaveCount(0, { timeout: 60_000 });

  // The completed assistant message should have a non-empty response timer.
  const timer = page.locator('[class*="responseTime"]');
  await expect(timer.first()).toBeVisible({ timeout: 5_000 });
});
