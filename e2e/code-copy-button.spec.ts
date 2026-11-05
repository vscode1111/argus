import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

const LONG_LINE = `const warehouses = [${Array.from({ length: 40 }, (_, i) => `'warehouse-${i}'`).join(', ')}];`;
const SHORT_LINE = "  const status = 'ready';";
const TOKEN_LINE = `const trackingCode = '${'shipment'.repeat(80)}';`;
const MARKDOWN = ['Here is the code:', '', '```ts', LONG_LINE, SHORT_LINE, TOKEN_LINE, '```'].join('\n');

function emitCodeBlock(page: Page, text: string) {
  return page.evaluate((md) => {
    function fire(data: object) {
      window.dispatchEvent(new MessageEvent('message', { data }));
    }
    fire({ type: 'thinking_start' });
    fire({ type: 'text_chunk', text: md });
    fire({ type: 'done' });
  }, text);
}

test.describe('code block copy button', () => {
  // Located by content, not by the wrapper/pre nesting, so the assertions below
  // fail on the behavior they describe rather than on a changed DOM shape.
  const codeBlock = (page: Page) => page.locator('pre').filter({ hasText: 'warehouse-0' }).first();
  const copyBtn = (page: Page) => page.getByRole('button', { name: 'Copy to clipboard' });

  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
    await emitCodeBlock(page, MARKDOWN);
  });

  test('wraps long lines and keeps the copy button in the visible corner', async ({ page }) => {
    const block = codeBlock(page);
    await expect(block).toBeVisible({ timeout: 5_000 });

    for (const width of [320, 780, 1280]) {
      await page.setViewportSize({ width, height: 700 });
      const dims = await block.evaluate(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, height: el.clientHeight }));
      expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth + 1);
      expect(dims.height).toBeGreaterThan(60);
    }

    await block.hover();
    const btn = copyBtn(page);
    const blockBox = (await block.boundingBox())!;
    const before = (await btn.boundingBox())!;

    expect(before.x + before.width).toBeLessThanOrEqual(blockBox.x + blockBox.width);
    expect(before.x + before.width).toBeGreaterThan(blockBox.x + blockBox.width - 30);

    await block.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(() => block.evaluate(el => el.scrollLeft)).toBe(0);

    const after = (await btn.boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  });

  test('copies the original whitespace and lines after visual wrapping', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const block = codeBlock(page);
    await expect(block).toBeVisible({ timeout: 5_000 });
    await block.evaluate(el => { el.scrollLeft = el.scrollWidth; });

    await block.hover();
    const btn = copyBtn(page);
    await btn.click({ timeout: 5_000 });

    // Wait for the button's own success glyph before reading the clipboard.
    // click() returns once the event is dispatched, while handleCopy's
    // navigator.clipboard.writeText() resolves a round trip later (and its
    // .then() has no .catch(), so a rejection would leave the clipboard holding
    // its previous value and fail the read with a confusing empty string).
    await expect(btn).toHaveText('✓', { timeout: 5_000 });

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText.replace(/\r\n/g, '\n')).toBe([LONG_LINE, SHORT_LINE, TOKEN_LINE].join('\n'));
  });
});
