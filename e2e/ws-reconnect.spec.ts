import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

test.describe('WebSocket reconnect', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('connected indicator is green on initial load', async ({ page }) => {
    const dot = page.locator('[class*="wsDotOn"]');
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute('title', 'Connected');
  });

  test('disconnect shows red pulsing indicator', async ({ page }) => {
    await send(page, { type: 'ws_status', connected: false });

    const dot = page.locator('[class*="wsDotOff"]');
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute('title', 'Disconnected, reconnecting...');

    const greenDot = page.locator('[class*="wsDotOn"]');
    await expect(greenDot).toHaveCount(0);
  });

  test('reconnect restores green indicator', async ({ page }) => {
    await send(page, { type: 'ws_status', connected: false });
    await expect(page.locator('[class*="wsDotOff"]')).toBeVisible();

    await send(page, { type: 'ws_status', connected: true });
    const dot = page.locator('[class*="wsDotOn"]');
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute('title', 'Connected');
  });

  test('disconnect during idle preserves messages', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-msg-1' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'scub-response-1' });
    await send(page, { type: 'done' });
    await expect(page.getByText('scub-response-1')).toBeVisible();

    await send(page, { type: 'ws_status', connected: false });

    await expect(page.getByText('scub-msg-1')).toBeVisible();
    await expect(page.getByText('scub-response-1')).toBeVisible();
  });

  test('disconnect during streaming commits message with error outcome', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-msg-2' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'scub-partial' });

    await send(page, { type: 'ws_status', connected: false });

    await expect(page.getByText('scub-partial')).toBeVisible();

    const errorTimer = page.locator('[class*="responseTimeError"]');
    await expect(errorTimer).toBeVisible();

    const sendBtn = page.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeEnabled();
  });

  test('disconnect during streaming marks pending tools as errored', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-msg-3' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'scub-before-tool' });
    await send(page, { type: 'tool_start', call: { id: 't1', name: 'Read', input: { file_path: '/src/index.ts' } } });

    const pendingTool = page.locator('[class*="toolNamePending"]');
    await expect(pendingTool).toBeVisible();

    await send(page, { type: 'ws_status', connected: false });

    await expect(pendingTool).not.toBeVisible();

    const errorTimer = page.locator('[class*="responseTimeError"]');
    await expect(errorTimer).toBeVisible();
  });

  test('disconnect during thinking (no text) commits empty message with error outcome', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-msg-4' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'thinking_chunk', text: 'Let me analyze...' });

    await send(page, { type: 'ws_status', connected: false });

    const errorTimer = page.locator('[class*="responseTimeError"]');
    await expect(errorTimer).toBeVisible();

    const sendBtn = page.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeEnabled();
  });

  test('can send new message after reconnect', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-before-dc' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'scub-interrupted' });

    await send(page, { type: 'ws_status', connected: false });
    await expect(page.locator('[class*="wsDotOff"]')).toBeVisible();

    await send(page, { type: 'ws_status', connected: true });
    await expect(page.locator('[class*="wsDotOn"]')).toBeVisible();

    await send(page, { type: 'message', message: { id: '2', role: 'user', content: 'scub-after-rc' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'scub-new-response' });
    await send(page, { type: 'done' });

    await expect(page.getByText('scub-interrupted')).toBeVisible();
    await expect(page.getByText('scub-new-response')).toBeVisible();

    const successTimer = page.locator('[class*="responseTimeSuccess"]');
    await expect(successTimer).toBeVisible();
  });

  test('multiple disconnect/reconnect cycles work correctly', async ({ page }) => {
    for (let i = 0; i < 3; i++) {
      await send(page, { type: 'ws_status', connected: false });
      await expect(page.locator('[class*="wsDotOff"]')).toBeVisible();

      await send(page, { type: 'ws_status', connected: true });
      await expect(page.locator('[class*="wsDotOn"]')).toBeVisible();
    }

    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-after-cycles' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'scub-still-works' });
    await send(page, { type: 'done' });

    await expect(page.getByText('scub-still-works')).toBeVisible();
  });
});
