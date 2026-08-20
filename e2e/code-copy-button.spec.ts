import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// One line long enough to overflow any viewport, so the block scrolls horizontally.
const LONG_LINE = `const scub = [${Array.from({ length: 40 }, (_, i) => `'scub-value-${i}'`).join(', ')}];`;
const SHORT_LINE = "const y = 'scub-short';";
const MARKDOWN = ['Here is the code:', '', '```ts', LONG_LINE, SHORT_LINE, '```'].join('\n');

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
  const codeBlock = (page: Page) => page.locator('pre').filter({ hasText: 'scub-value-0' }).first();
  const copyBtn = (page: Page) => page.getByRole('button', { name: 'Copy to clipboard' });

  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
    await emitCodeBlock(page, MARKDOWN);
  });

  // The copy button used to live inside the scrolling <pre>. An absolutely
  // positioned child of a scroll container is laid out against the padding box
  // at scroll origin and then scrolls with the content, so the button looked
  // right only at scrollLeft 0 and slid left across the block (~3700px on this
  // fixture) once a long line was scrolled. The post-scroll comparison is what
  // catches that; the unscrolled one passed even when broken.
  test('stays in the visible right corner while the block scrolls', async ({ page }) => {
    const block = codeBlock(page);
    await expect(block).toBeVisible({ timeout: 5_000 });

    const dims = await block.evaluate(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(dims.scrollWidth).toBeGreaterThan(dims.clientWidth);

    await block.hover();
    const btn = copyBtn(page);
    const blockBox = (await block.boundingBox())!;
    const before = (await btn.boundingBox())!;

    expect(before.x + before.width).toBeLessThanOrEqual(blockBox.x + blockBox.width);
    expect(before.x + before.width).toBeGreaterThan(blockBox.x + blockBox.width - 30);

    await block.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(() => block.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);

    const after = (await btn.boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  });

  // Not a regression test for the drift (Playwright scrolls a target into view
  // before clicking, so this passed against the broken layout too): it guards
  // the fix itself - the button now lives outside the <pre> it copies, so the
  // text it hands to the clipboard has to keep coming from the code element.
  test('copies the code after the block has been scrolled', async ({ page, context }) => {
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
    expect(clipboardText).toContain(LONG_LINE);
    expect(clipboardText).toContain(SHORT_LINE);
  });
});
