import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('send while streaming', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('second message sent during streaming appears as inline inject', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');

    // Send a task that requires tool calls so it takes long enough to inject
    await textarea.fill('Read package.json, then read CLAUDE.md, then summarize both.');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for at least one tool call to appear (confirms streaming is active)
    const toolCall = page.locator('[class*="toolCall"], [class*="tool_"]');
    await expect(toolCall.first()).toBeVisible({ timeout: 30_000 });

    // Inject second message while tool calls are running
    await textarea.fill('What is 123 + 456? Reply with just the number.');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for the response to complete
    const timer = page.locator('[class*="responseTime"]');
    await expect(timer.first()).toBeVisible({ timeout: 90_000 });

    // The injected user message should appear inline as a userInject block
    const inject = page.locator('div[class*="userInject"]');
    await expect(inject).toBeVisible();
    await expect(inject).toContainText('123 + 456');

    // No error blocks
    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);
  });

  test('can send normally after mid-turn inject completes', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');

    // First: a task with tool calls
    await textarea.fill('Read package.json and tell me the version number.');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for streaming to start with tool calls
    const toolCall = page.locator('[class*="toolCall"], [class*="tool_"]');
    await expect(toolCall.first()).toBeVisible({ timeout: 30_000 });

    // Inject a short question mid-turn
    await textarea.fill('Say "scub-inject-ok" and nothing else.');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for response to complete
    const timer = page.locator('[class*="responseTime"]');
    await expect(timer.first()).toBeVisible({ timeout: 60_000 });

    // Inject should be visible
    const inject = page.locator('div[class*="userInject"]');
    await expect(inject).toBeVisible();

    // Now send a regular follow-up (between turns, not mid-turn)
    await textarea.fill('Say "scub-followup-ok" and nothing else.');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for second response
    await expect(async () => {
      const count = await timer.count();
      expect(count).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 60_000 });

    // The follow-up response should contain the requested text (not exact - model may wrap it)
    await expect(page.getByText('scub-followup-ok').first()).toBeVisible();

    // No error blocks
    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);
  });
});
