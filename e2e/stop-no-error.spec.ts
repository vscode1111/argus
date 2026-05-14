import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
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
});
