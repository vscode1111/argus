import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

test.describe('retry indicator', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('argus.showDevHarness', 'true');
    });
    await waitForApp(page);
  });

  test('shows retry indicator on empty streaming message', async ({ page }) => {
    await send(page, { type: 'thinking_start', reused: false });
    await send(page, { type: 'retry_status', attempt: 3, maxRetries: 10, delayMs: 2000 });

    const retrying = page.locator('[class*="retrying"]');
    await expect(retrying).toBeVisible();
    await expect(retrying).toContainText('Retrying (3/10)');

    // Only one indicator should be visible (no duplicate "Examining...")
    const indicators = page.locator('[class*="working"]');
    await expect(indicators).toHaveCount(1);
  });

  test('shows retry indicator below content when retrying after tools', async ({ page }) => {
    await send(page, { type: 'thinking_start', reused: false });
    await send(page, { type: 'thinking_chunk', text: 'Analyzing...' });
    await send(page, { type: 'text_chunk', text: 'Some content here.\n' });
    await send(page, { type: 'tool_start', call: { id: 't1', name: 'Read', input: { file_path: '/src/App.tsx' } } });
    await send(page, { type: 'tool_end', call: { id: 't1', name: 'Read', result: 'file content' } });
    await send(page, { type: 'retry_status', attempt: 6, maxRetries: 10, delayMs: 8000 });

    const retrying = page.locator('[class*="retrying"]');
    await expect(retrying).toBeVisible();
    await expect(retrying).toContainText('Retrying (6/10)');

    // Verify ordering: tool call above retry indicator above timer
    const message = page.locator('[class*="streaming"]');
    const toolCall = message.locator('[class*="toolCall"]').first();
    const timer = message.locator('[class*="responseTime"]');
    await expect(toolCall).toBeVisible();
    await expect(timer).toBeVisible();

    const toolBox = await toolCall.boundingBox();
    const retryBox = await retrying.boundingBox();
    const timerBox = await timer.boundingBox();
    expect(toolBox!.y).toBeLessThan(retryBox!.y);
    expect(retryBox!.y).toBeLessThan(timerBox!.y);
  });

  test('retry indicator clears when new content arrives', async ({ page }) => {
    await send(page, { type: 'thinking_start', reused: false });
    await send(page, { type: 'retry_status', attempt: 2, maxRetries: 10, delayMs: 1000 });

    const retrying = page.locator('[class*="retrying"]');
    await expect(retrying).toBeVisible();

    // text_chunk should clear the retry indicator
    await send(page, { type: 'text_chunk', text: 'Content after retry.' });
    await expect(retrying).not.toBeVisible();
  });

  test('retry indicator clears on thinking_chunk', async ({ page }) => {
    await send(page, { type: 'thinking_start', reused: false });
    await send(page, { type: 'retry_status', attempt: 1, maxRetries: 10, delayMs: 500 });

    const retrying = page.locator('[class*="retrying"]');
    await expect(retrying).toBeVisible();

    await send(page, { type: 'thinking_chunk', text: 'Now thinking...' });
    await expect(retrying).not.toBeVisible();
  });

  test('retry indicator clears on tool_start', async ({ page }) => {
    await send(page, { type: 'thinking_start', reused: false });
    await send(page, { type: 'text_chunk', text: 'Some text.' });
    await send(page, { type: 'retry_status', attempt: 4, maxRetries: 10, delayMs: 4000 });

    const retrying = page.locator('[class*="retrying"]');
    await expect(retrying).toBeVisible();

    await send(page, { type: 'tool_start', call: { id: 't2', name: 'Bash', input: { command: 'ls' } } });
    await expect(retrying).not.toBeVisible();
  });
});
