import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  // Dispatch the synthetic extension message, then wait for React to flush and
  // commit the resulting update before resolving. These events are injected in
  // the same tick (unlike real WS frames, which arrive in separate ticks), so
  // without a flush boundary React 18 can batch/defer them under load and a
  // later event (e.g. `done`) can commit against state that an earlier event
  // (e.g. `text_chunk`) has not been applied to yet, dropping the chunk.
  return page.evaluate(
    (d) =>
      new Promise<void>((resolve) => {
        window.dispatchEvent(new MessageEvent('message', { data: d }));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
    data
  );
}

test.describe('stop does not produce error', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('stop during streaming shows stopped outcome, no error block', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'test' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'partial response' });

    // User clicks stop
    await page.getByRole('button', { name: 'Stop' }).click();
    await send(page, { type: 'done' });

    // No error block should appear
    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);

    // Timer should show stopped (blue) outcome
    const timer = page.locator('[class*="responseTimeStopped"]');
    await expect(timer).toBeVisible();

    // User message and partial response preserved
    await expect(page.getByText('test')).toBeVisible();
    await expect(page.getByText('partial response')).toBeVisible();
  });

  test('stop during thinking (no text yet) shows stopped outcome, no error', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'hello' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'thinking_chunk', text: 'Let me think...' });

    await page.getByRole('button', { name: 'Stop' }).click();
    await send(page, { type: 'done' });

    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);

    const timer = page.locator('[class*="responseTimeStopped"]');
    await expect(timer).toBeVisible();
  });

  test('stop with pending tool calls marks them as errored, no error block', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'do something' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'I will read a file.' });
    await send(page, { type: 'tool_start', call: { id: 't1', name: 'Read', input: { file_path: '/src/App.tsx' } } });

    await page.getByRole('button', { name: 'Stop' }).click();
    await send(page, { type: 'done' });

    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);

    const timer = page.locator('[class*="responseTimeStopped"]');
    await expect(timer).toBeVisible();
  });

  test('can send a new message after stop', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'first' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'partial' });

    await page.getByRole('button', { name: 'Stop' }).click();
    await send(page, { type: 'done' });

    // Send button should be enabled again
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeEnabled();

    // Simulate a second message
    await send(page, { type: 'message', message: { id: '2', role: 'user', content: 'second' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'second response' });
    await send(page, { type: 'done' });

    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);

    // Both messages should be visible
    await expect(page.getByText('first')).toBeVisible();
    await expect(page.getByText('second response')).toBeVisible();

    // Second message should have success outcome
    const successTimer = page.locator('[class*="responseTimeSuccess"]');
    await expect(successTimer).toBeVisible();
  });

  test('stop immediately after send (no streaming content) shows no error', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'quick stop' } });
    await send(page, { type: 'thinking_start' });

    await page.getByRole('button', { name: 'Stop' }).click();
    await send(page, { type: 'done' });

    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);

    const timer = page.locator('[class*="responseTimeStopped"]');
    await expect(timer).toBeVisible();
  });

  test('stop after watchdog retries shows stopped outcome, no error block', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'test watchdog stop' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'partial' });

    // Watchdog retries twice
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 5000, autoRetry: 1, autoRetryMax: 3 });
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 10000, autoRetry: 2, autoRetryMax: 3 });

    // User clicks stop during reconnect
    await page.getByRole('button', { name: 'Stop' }).click();
    await send(page, { type: 'done' });

    // No "Connection interrupted" error block
    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);

    // Stopped outcome, not error or retried
    const stoppedTimer = page.locator('[class*="responseTimeStopped"]');
    await expect(stoppedTimer).toBeVisible();
    const errorTimer = page.locator('[class*="responseTimeError"]');
    await expect(errorTimer).toHaveCount(0);
  });

  test('stop after watchdog timed out shows stopped outcome, no error block', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'test timeout stop' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'partial' });

    // Watchdog exhausts all retries
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 5000, autoRetry: 1, autoRetryMax: 3 });
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 0, autoRetry: 3, autoRetryMax: 3, timedOut: true });

    // "Timed out, press Stop" indicator visible
    const retrying = page.locator('[class*="retrying"]');
    await expect(retrying).toContainText('Timed out, press Stop');

    // User clicks stop
    await page.getByRole('button', { name: 'Stop' }).click();
    await send(page, { type: 'done' });

    // No error block or "Connection interrupted"/"Connection timed out"
    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);

    // Stopped outcome
    const stoppedTimer = page.locator('[class*="responseTimeStopped"]');
    await expect(stoppedTimer).toBeVisible();
    const errorTimer = page.locator('[class*="responseTimeError"]');
    await expect(errorTimer).toHaveCount(0);
  });

  test('stop after watchdog retries does not show Connection interrupted block', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-watchdog-test' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'some response' });

    // Simulate 2 watchdog retries then success resumes
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 5000, autoRetry: 1, autoRetryMax: 3 });
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'retry_status', attempt: 0, maxRetries: 0, delayMs: 10000, autoRetry: 2, autoRetryMax: 3 });
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'resumed content' });

    // User stops mid-stream after retries happened
    await page.getByRole('button', { name: 'Stop' }).click();
    await send(page, { type: 'done' });

    // "Connection interrupted" block must not appear
    await expect(page.getByText('Connection interrupted')).toHaveCount(0);
    await expect(page.getByText('Connection timed out')).toHaveCount(0);

    const stoppedTimer = page.locator('[class*="responseTimeStopped"]');
    await expect(stoppedTimer).toBeVisible();
  });
});
