import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

test.describe('retry cleanup', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('retry_clean removes trailing error and error-outcome assistant', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'hello' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'partial response' });
    await send(page, { type: 'error', text: 'API Error: 403', errorKind: 'auth' });

    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toBeVisible();

    // Error-outcome assistant message should be committed
    const assistantTimers = page.locator('[class*="responseTime"]');
    await expect(assistantTimers.first()).toBeVisible();

    await send(page, { type: 'retry_clean' });

    await expect(errorBlock).not.toBeVisible();
    // Error-outcome assistant should also be removed
    await expect(assistantTimers).toHaveCount(0);
    // User message should remain
    await expect(page.getByText('hello')).toBeVisible();
  });

  test('retry_clean removes error-only (no assistant) messages', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'hello' } });
    await send(page, { type: 'thinking_start' });
    // Error with no streaming blocks: no assistant committed, just error
    await send(page, { type: 'error', text: 'CLI not found', errorKind: 'not_found' });

    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toBeVisible();

    await send(page, { type: 'retry_clean' });

    await expect(errorBlock).not.toBeVisible();
    await expect(page.getByText('hello')).toBeVisible();
  });

  test('retry_clean preserves successful messages before the error', async ({ page }) => {
    // First successful exchange
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'first question' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'first answer' });
    await send(page, { type: 'done' });

    // Second exchange that fails
    await send(page, { type: 'message', message: { id: '2', role: 'user', content: 'second question' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'error', text: 'Session expired', errorKind: 'session' });

    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toBeVisible();

    await send(page, { type: 'retry_clean' });

    await expect(errorBlock).not.toBeVisible();
    // First exchange preserved
    await expect(page.getByText('first question')).toBeVisible();
    await expect(page.getByText('first answer')).toBeVisible();
    // Second user message preserved
    await expect(page.getByText('second question')).toBeVisible();
  });

  test('repeated retries do not create duplicate messages', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'test msg' } });

    for (let i = 0; i < 3; i++) {
      await send(page, { type: 'thinking_start' });
      await send(page, { type: 'error', text: 'API Error: 403', errorKind: 'auth' });
      await send(page, { type: 'retry_clean' });
    }

    // After 3 retries, only one user message should exist
    const userMessages = page.locator('[class*="user"]').filter({ hasText: 'test msg' });
    await expect(userMessages).toHaveCount(1);

    // No error blocks should remain after cleanup
    const errorBlocks = page.locator('[class*="errorBlock"]');
    await expect(errorBlocks).toHaveCount(0);
  });

  test('thinking_start after retry_clean initializes streaming', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'hello' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'error', text: 'API Error: 403', errorKind: 'auth' });
    await send(page, { type: 'retry_clean' });

    // Simulate retried request arriving
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'retried response' });
    await send(page, { type: 'done' });

    await expect(page.getByText('retried response')).toBeVisible();
    // Should have a success timer
    const timer = page.locator('[class*="responseTimeSuccess"]');
    await expect(timer).toBeVisible();
  });

  test('retry_clean does not remove successful assistant messages', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'hello' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'good response' });
    await send(page, { type: 'done' });

    // Successful assistant message should survive retry_clean
    await send(page, { type: 'retry_clean' });

    await expect(page.getByText('good response')).toBeVisible();
    const timer = page.locator('[class*="responseTimeSuccess"]');
    await expect(timer).toBeVisible();
  });
});
