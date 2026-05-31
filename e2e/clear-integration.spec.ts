import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('/clear command', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('clears conversation without error block', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.fill('say "scub-clear-test" and nothing else');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for the assistant to finish responding
    const timer = page.locator('[class*="responseTime"]');
    await expect(timer.first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('scub-clear-test')).toBeVisible();

    // Send /clear
    await textarea.fill('/clear');
    await page.getByRole('button', { name: 'Send' }).click();

    // Conversation should be cleared - no messages visible
    await expect(page.getByText('scub-clear-test')).toHaveCount(0, { timeout: 5_000 });

    // No error block should appear
    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);

    // Input area should still be usable
    await expect(textarea).toBeVisible();
    await expect(textarea).toBeEnabled();
  });

  test('can send a message after /clear', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.fill('say "scub-before-clear" and nothing else');
    await page.getByRole('button', { name: 'Send' }).click();

    const timer = page.locator('[class*="responseTime"]');
    await expect(timer.first()).toBeVisible({ timeout: 30_000 });

    // Clear
    await textarea.fill('/clear');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('scub-before-clear')).toHaveCount(0, { timeout: 5_000 });

    // Send a new message
    await textarea.fill('say "scub-after-clear" and nothing else');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for new response
    const newTimer = page.locator('[class*="responseTime"]');
    await expect(newTimer.first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('scub-after-clear')).toBeVisible();

    // No error blocks
    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);
  });

  test('stop then /clear does not produce error', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.fill('write a detailed essay about the history of computing');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for streaming to start
    const stopBtn = page.getByRole('button', { name: 'Stop' });
    await expect(stopBtn).toBeVisible({ timeout: 15_000 });

    // Stop the session
    await stopBtn.click();

    // Wait for stopped state
    const stoppedTimer = page.locator('[class*="responseTimeStopped"]');
    await expect(stoppedTimer).toBeVisible({ timeout: 10_000 });

    // Now send /clear
    await textarea.fill('/clear');
    await page.getByRole('button', { name: 'Send' }).click();

    // Short wait for any error to appear
    await page.waitForTimeout(2_000);

    // No error block should appear
    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);

    // Messages should be cleared
    await expect(stoppedTimer).toHaveCount(0);

    // Input should be ready for new messages
    await expect(textarea).toBeVisible();
    await expect(textarea).toBeEnabled();
  });
});
