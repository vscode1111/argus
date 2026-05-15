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

  test('retry_clean preserves error-outcome assistant as retried', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'hello' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'partial response' });
    await send(page, { type: 'error', text: 'API Error: 403', errorKind: 'auth' });

    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toBeVisible();

    await send(page, { type: 'retry_clean' });

    // Error role message removed
    await expect(errorBlock).not.toBeVisible();
    // Assistant content preserved
    await expect(page.getByText('partial response')).toBeVisible();
    // Timer re-marked as retried (yellow)
    const timer = page.locator('[class*="responseTimeRetried"]');
    await expect(timer).toBeVisible();
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

  test('retry_clean preserves retried messages from watchdog reconnects', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-retry-history' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'First attempt work.' });
    await send(page, { type: 'tool_start', call: { id: 't1', name: 'Read', input: { file_path: '/src/a.ts' } } });
    await send(page, { type: 'tool_end', call: { id: 't1', name: 'Read', result: 'content' } });

    // Auto-retry commits retried message
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 5000, autoRetry: 1, autoRetryMax: 2 });
    await send(page, { type: 'thinking_start', reused: true });

    // Timeout + done
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 0, autoRetry: 2, autoRetryMax: 2, timedOut: true });
    await send(page, { type: 'done' });

    // Error from proc close
    await send(page, { type: 'error', text: 'claude exited with code 1' });

    // Verify retried message + error outcome message exist
    await expect(page.getByText('First attempt work.')).toBeVisible();
    const retriedTimers = page.locator('[class*="responseTimeRetried"]');
    await expect(retriedTimers.first()).toBeVisible();

    // retry_clean should preserve retried messages
    await send(page, { type: 'retry_clean' });

    // Retried message still visible
    await expect(page.getByText('First attempt work.')).toBeVisible();
    await expect(retriedTimers.first()).toBeVisible();

    // User message preserved
    await expect(page.getByText('scub-retry-history')).toBeVisible();
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
