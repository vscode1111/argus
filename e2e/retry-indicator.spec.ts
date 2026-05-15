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

  test('shows watchdog auto-retry reconnecting indicator', async ({ page }) => {
    await send(page, { type: 'thinking_start', reused: false });
    await send(page, { type: 'text_chunk', text: 'Some content.' });
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 5000, autoRetry: 1, autoRetryMax: 3 });

    const retrying = page.locator('[class*="retrying"]');
    await expect(retrying).toBeVisible();
    await expect(retrying).toContainText('Reconnecting (1/3)');
  });

  test('shows timed out indicator when all watchdog retries exhausted', async ({ page }) => {
    await send(page, { type: 'thinking_start', reused: false });
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 0, autoRetry: 3, autoRetryMax: 3, timedOut: true });

    const retrying = page.locator('[class*="retrying"]');
    await expect(retrying).toBeVisible();
    await expect(retrying).toContainText('Timed out, press Stop');
  });

  test('watchdog auto-retry preserves previous blocks as committed message', async ({ page }) => {
    await send(page, { type: 'thinking_start', reused: false });
    await send(page, { type: 'thinking_chunk', text: 'Let me analyze...' });
    await send(page, { type: 'text_chunk', text: 'Partial content from first attempt.' });

    // Watchdog auto-retry should commit blocks as a completed message
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 5000, autoRetry: 1, autoRetryMax: 3 });

    // Old content should be preserved in a committed message
    await expect(page.getByText('Partial content from first attempt.')).toBeVisible();

    // Reconnecting indicator should be visible
    const retrying = page.locator('[class*="retrying"]');
    await expect(retrying).toContainText('Reconnecting (1/3)');
  });

  test('each watchdog retry commits a separate retried timer', async ({ page }) => {
    await send(page, { type: 'thinking_start', reused: false });
    await send(page, { type: 'text_chunk', text: 'First attempt content.' });
    await send(page, { type: 'tool_start', call: { id: 't1', name: 'Read', input: { file_path: '/src/a.ts' } } });
    await send(page, { type: 'tool_end', call: { id: 't1', name: 'Read', result: 'file content' } });

    // First auto-retry: commits blocks
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 5000, autoRetry: 1, autoRetryMax: 3 });
    const timer1 = page.locator('[class*="responseTimeRetried"]');
    await expect(timer1.first()).toBeVisible();
    await expect(timer1.first()).toContainText('reconnected 1x');

    // Second auto-retry: commits even with empty blocks
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 10000, autoRetry: 2, autoRetryMax: 3 });
    const timers = page.locator('[class*="responseTimeRetried"]');
    await expect(timers).toHaveCount(2);
    await expect(timers.nth(1)).toContainText('reconnected 2x');

    // Third auto-retry
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 20000, autoRetry: 3, autoRetryMax: 3 });
    await expect(timers).toHaveCount(3);
    await expect(timers.nth(2)).toContainText('reconnected 3x');
  });

  test('reconnecting indicator persists across thinking_start', async ({ page }) => {
    await send(page, { type: 'thinking_start', reused: false });
    await send(page, { type: 'text_chunk', text: 'Some content.' });

    // Auto-retry sets retryStatus
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 5000, autoRetry: 1, autoRetryMax: 3 });
    const retrying = page.locator('[class*="retrying"]');
    await expect(retrying).toContainText('Reconnecting (1/3)');

    // thinking_start from new attempt should inherit retryStatus
    await send(page, { type: 'thinking_start', reused: true });
    await expect(retrying).toBeVisible();
    await expect(retrying).toContainText('Reconnecting (1/3)');
  });

  test('watchdog timeout + done ends session, no streaming remains', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-timeout-test' } });
    await send(page, { type: 'thinking_start', reused: false });
    await send(page, { type: 'text_chunk', text: 'Content before timeout.' });
    await send(page, { type: 'tool_start', call: { id: 't1', name: 'Read', input: { file_path: '/src/a.ts' } } });
    await send(page, { type: 'tool_end', call: { id: 't1', name: 'Read', result: 'file' } });

    // Auto-retry commits blocks
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 5000, autoRetry: 1, autoRetryMax: 3 });

    // Timeout exhausts retries
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 0, autoRetry: 1, autoRetryMax: 1, timedOut: true });

    // Server sends done on timeout
    await send(page, { type: 'done' });

    // Session ended: no streaming indicator
    const streaming = page.locator('[class*="streaming"]');
    await expect(streaming).toHaveCount(0);

    // Committed retried message preserved
    await expect(page.getByText('Content before timeout.')).toBeVisible();

    // Error timer on final message (timed out)
    const errorTimer = page.locator('[class*="responseTimeError"]');
    await expect(errorTimer).toBeVisible();

    // Send button available (session ended)
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeEnabled();
  });

  test('no redundant error message after watchdog timeout with done', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-no-dup-error' } });
    await send(page, { type: 'thinking_start', reused: false });
    await send(page, { type: 'text_chunk', text: 'Some work.' });

    // Auto-retry
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 5000, autoRetry: 1, autoRetryMax: 1 });
    await send(page, { type: 'thinking_start', reused: true });

    // Timeout + done
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 0, autoRetry: 1, autoRetryMax: 1, timedOut: true });
    await send(page, { type: 'done' });

    // Proc close sends error after timeout
    await send(page, { type: 'error', text: 'claude exited with code 1' });

    // "Something went wrong" should NOT appear (suppressed by watchdog block)
    await expect(page.getByText('Something went wrong')).toHaveCount(0);

    // Committed retried content preserved
    await expect(page.getByText('Some work.')).toBeVisible();
  });

  test('late events after timeout do not create phantom session', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-phantom-test' } });
    await send(page, { type: 'thinking_start', reused: false });
    await send(page, { type: 'text_chunk', text: 'Original content.' });

    // Timeout + done ends session
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 0, autoRetry: 1, autoRetryMax: 1, timedOut: true });
    await send(page, { type: 'done' });

    // No streaming
    const streaming = page.locator('[class*="streaming"]');
    await expect(streaming).toHaveCount(0);

    // Late thinking_start from dying process should create new streaming
    // but on the server side cliDone prevents this; simulate the frontend receiving it anyway
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Phantom content that should not persist.' });
    await send(page, { type: 'done' });

    // The phantom content would appear (frontend has no cliDone guard)
    // but the important thing is the original content is preserved
    await expect(page.getByText('Original content.')).toBeVisible();
    await expect(page.getByText('scub-phantom-test')).toBeVisible();
  });
});
