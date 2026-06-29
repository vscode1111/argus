import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Mock tests for ThinkingBlock: starts expanded, collapsible, with live token estimate.
// Uses injected events so no real CLI is needed.

function send(page: Page, data: object) {
  return page.evaluate(
    (d) =>
      new Promise<void>((resolve) => {
        window.dispatchEvent(new MessageEvent('message', { data: d }));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
    data
  );
}

test.describe('ThinkingBlock', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('header shows token estimate and body is visible by default', async ({ page }) => {
    // 40 chars -> Math.ceil(40 / 4) = 10 tok
    const thinkingText = 'A'.repeat(40);
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'thinking_chunk', text: thinkingText });

    const block = page.locator('[class*="thinkingBlock"]');
    await expect(block).toBeVisible();

    // Header always visible
    const header = block.locator('[class*="header"]');
    await expect(header).toBeVisible();
    await expect(header).toContainText('Thinking...');
    await expect(header).toContainText('10 tok');
    await expect(header).toContainText('›');

    // Body is rendered and visible by default (starts expanded)
    const body = block.locator('[class*="body"]');
    await expect(body).toBeVisible();
    await expect(body).toContainText(thinkingText);
  });

  test('click collapses the body', async ({ page }) => {
    const thinkingText = 'I need to reason about this carefully.';
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'thinking_chunk', text: thinkingText });

    const block = page.locator('[class*="thinkingBlock"]');
    await expect(block).toBeVisible();

    // Body visible initially
    const body = block.locator('[class*="body"]');
    await expect(body).toBeVisible();

    // Click collapses
    await block.click();
    await expect(body).toHaveCount(0);

    // Header still visible with token count
    const header = block.locator('[class*="header"]');
    await expect(header).toContainText('Thinking...');
  });

  test('second click re-expands the body', async ({ page }) => {
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'thinking_chunk', text: 'Some thinking.' });

    const block = page.locator('[class*="thinkingBlock"]');
    await block.click(); // collapse
    await expect(block.locator('[class*="body"]')).toHaveCount(0);

    await block.click(); // re-expand
    await expect(block.locator('[class*="body"]')).toBeVisible();
  });

  test('token count updates live as more thinking text arrives', async ({ page }) => {
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'thinking_chunk', text: 'A'.repeat(40) }); // 10 tok

    const header = page.locator('[class*="thinkingBlock"] [class*="header"]');
    await expect(header).toContainText('10 tok');

    // 360 more chars appended -> total 400 chars -> 100 tok
    await send(page, { type: 'thinking_chunk', text: 'B'.repeat(360) });
    await expect(header).toContainText('100 tok');
  });

  test('token count persists in completed message after turn ends', async ({ page }) => {
    const thinkingText = 'A'.repeat(80); // 20 tok
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-test' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'thinking_chunk', text: thinkingText });
    await send(page, { type: 'text_chunk', text: 'Here is the answer.' });
    await send(page, { type: 'done' });

    // After done, thinking moves to the committed UIMessage and ThinkingBlock re-renders
    const block = page.locator('[class*="thinkingBlock"]');
    await expect(block).toBeVisible();
    const header = block.locator('[class*="header"]');
    await expect(header).toContainText('20 tok');
  });
});
