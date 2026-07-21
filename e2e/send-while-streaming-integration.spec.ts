import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('send while streaming', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('second message sent during streaming appears as inline inject', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');

    // Send a task long enough to leave room for a mid-turn inject.
    await textarea.fill('Read package.json, then read CLAUDE.md, then summarize both.');
    await page.getByRole('button', { name: 'Send' }).click();

    // Gate on the Stop button, not on a tool call: whether the model actually calls a
    // tool (and how fast) is its own choice, so a toolCall locator is a model-dependent
    // proxy that intermittently never appears. Stop is rendered for every active turn,
    // which is exactly the precondition here - the turn is still in flight.
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });

    // Inject second message while the turn is still running
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

    // Gate on the Stop button rather than a tool call - see the note in the test above:
    // a toolCall locator depends on the model choosing to call a tool, Stop does not.
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });

    // Inject a short question mid-turn
    await textarea.fill('Say "scub-inject-ok" and nothing else.');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for response to complete - use the LAST timer (the inject response, not the first turn)
    const timer = page.locator('[class*="responseTime"]');
    await expect(timer.last()).toBeVisible({ timeout: 60_000 });

    // Inject should be visible
    const inject = page.locator('div[class*="userInject"]');
    await expect(inject).toBeVisible();

    // Now send a regular follow-up (between turns, not mid-turn)
    await textarea.fill('Say "scub-followup-ok" and nothing else.');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for the follow-up turn to start (Stop button appears), then complete (timer appears)
    const stopBtn = page.getByRole('button', { name: 'Stop' });
    await expect(stopBtn).toBeVisible({ timeout: 30_000 });
    await expect(stopBtn).toHaveCount(0, { timeout: 90_000 });

    // Now we have at least 2 timers - assert the follow-up text is present
    await expect(page.getByText('scub-followup-ok').first()).toBeVisible({ timeout: 10_000 });

    // No error blocks
    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);
  });
});
