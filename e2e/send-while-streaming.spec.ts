import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

test.describe('send while streaming', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('send button is enabled during streaming', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-first' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'partial response' });

    const sendBtn = page.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeEnabled();
  });

  test('user_inject block renders inline in streaming content', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-first' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'analysis part one' });
    await send(page, { type: 'tool_start', call: { id: 't1', name: 'Read', input: { file_path: '/src/index.ts' } } });
    await send(page, { type: 'tool_end', call: { id: 't1', name: 'Read', input: { file_path: '/src/index.ts' }, result: 'file content' } });

    await send(page, { type: 'user_inject', text: 'scub-injected-msg' });

    await send(page, { type: 'text_chunk', text: 'continued after inject' });

    const inject = page.locator('div[class*="userInject"]');
    await expect(inject).toBeVisible();
    await expect(inject).toContainText('scub-injected-msg');
  });

  test('user_inject block has fit-content width, not full width', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-first' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'response text' });
    await send(page, { type: 'user_inject', text: 'short' });

    const inject = page.locator('div[class*="userInject"]');
    await expect(inject).toBeVisible();
    const box = await inject.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeLessThan(400);
  });

  test('user_inject copy button appears on hover', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-first' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'user_inject', text: 'scub-copy-test' });

    const inject = page.locator('div[class*="userInject"]');
    const copyBtn = inject.locator('[class*="userInjectCopy"]');

    // Hidden by default
    await expect(copyBtn).toHaveCSS('opacity', '0');

    // Visible on hover
    await inject.hover();
    await expect(async () => {
      const opacity = await copyBtn.evaluate(el => getComputedStyle(el).opacity);
      expect(parseFloat(opacity)).toBeGreaterThan(0);
    }).toPass({ timeout: 2000 });
  });

  test('user_inject block preserved in committed message after done', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-first' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'before inject' });
    await send(page, { type: 'user_inject', text: 'scub-persist-test' });
    await send(page, { type: 'text_chunk', text: 'after inject' });
    await send(page, { type: 'done' });

    const inject = page.locator('div[class*="userInject"]');
    await expect(inject).toBeVisible();
    await expect(inject).toContainText('scub-persist-test');

    // Both text parts should also be visible
    await expect(page.getByText('before inject')).toBeVisible();
    await expect(page.getByText('after inject')).toBeVisible();
  });

  test('user_inject appears between tool calls at correct position', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-first' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'tool_start', call: { id: 't1', name: 'Read', input: { file_path: '/a.ts' } } });
    await send(page, { type: 'tool_end', call: { id: 't1', name: 'Read', input: { file_path: '/a.ts' }, result: 'content a' } });
    await send(page, { type: 'user_inject', text: 'scub-between-tools' });
    await send(page, { type: 'tool_start', call: { id: 't2', name: 'Read', input: { file_path: '/b.ts' } } });
    await send(page, { type: 'tool_end', call: { id: 't2', name: 'Read', input: { file_path: '/b.ts' }, result: 'content b' } });
    await send(page, { type: 'done' });

    // Verify ordering: tool1, inject, tool2
    const blocks = page.locator('[class*="assistant"] > *');
    const texts = await blocks.evaluateAll(els =>
      els.map(el => {
        if (el.className.includes('userInject')) return 'INJECT:' + el.textContent?.replace(/[⧉✓]/g, '').trim();
        if (el.className.includes('toolCall') || el.className.includes('tool')) {
          const summary = el.querySelector('[class*="toolSummary"]');
          return 'TOOL:' + (summary?.textContent ?? '').trim();
        }
        return 'OTHER';
      }).filter(t => t !== 'OTHER')
    );
    expect(texts[0]).toContain('TOOL:');
    expect(texts[1]).toBe('INJECT:scub-between-tools');
    expect(texts[2]).toContain('TOOL:');
  });

  test('multiple user_inject blocks render in order', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-first' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'part one' });
    await send(page, { type: 'user_inject', text: 'scub-inject-1' });
    await send(page, { type: 'text_chunk', text: 'part two' });
    await send(page, { type: 'user_inject', text: 'scub-inject-2' });
    await send(page, { type: 'text_chunk', text: 'part three' });
    await send(page, { type: 'done' });

    const injects = page.locator('div[class*="userInject"]');
    await expect(injects).toHaveCount(2);
    await expect(injects.nth(0)).toContainText('scub-inject-1');
    await expect(injects.nth(1)).toContainText('scub-inject-2');
  });

  test('stop clears streaming with user_inject blocks cleanly', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-first' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'response' });
    await send(page, { type: 'user_inject', text: 'scub-stop-test' });
    await send(page, { type: 'text_chunk', text: 'more response' });

    await page.getByRole('button', { name: 'Stop' }).click();
    await send(page, { type: 'done' });

    // No error
    const errorBlock = page.locator('[class*="errorBlock"]');
    await expect(errorBlock).toHaveCount(0);

    // Inject preserved in committed message
    await expect(page.locator('div[class*="userInject"]')).toContainText('scub-stop-test');

    // Stopped outcome
    const timer = page.locator('[class*="responseTimeStopped"]');
    await expect(timer).toBeVisible();
  });
});
