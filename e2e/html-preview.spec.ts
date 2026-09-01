import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

/**
 * An .html file is a document, so the previewer renders it instead of showing markup -
 * the same call the markdown branch already makes. It is rendered in a fully restricted
 * sandbox: the file is whatever the agent happened to write or read, and an inline
 * `onerror=` would otherwise run in the app's own origin, next to the live WebSocket.
 */

const HTML = [
  '<!DOCTYPE html>',
  '<html><head><title>scub report</title></head>',
  '<body>',
  '<h1>Scub export</h1>',
  '<p>Body text of the report.</p>',
  // If scripts ran, this would add #ran to the document. The sandbox is what stops it,
  // so asserting its absence tests behaviour rather than the attribute string.
  '<script>document.body.insertAdjacentHTML("beforeend", "<div id=\'ran\'>ran</div>");</script>',
  '</body></html>',
].join('\n');

function emitRead(page: Page, id: string, path: string, result: string, offset?: number) {
  const input: Record<string, unknown> = { file_path: path };
  if (offset != null) input.offset = offset;
  return page.evaluate(({ id, input, result }) => {
    const fire = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    fire({ type: 'thinking_start' });
    fire({ type: 'tool_start', call: { id, name: 'Read', input } });
    fire({ type: 'tool_end', call: { id, name: 'Read', input, result } });
    fire({ type: 'done' });
  }, { id, input, result });
}

const dialog = (page: Page) => page.locator('[role="dialog"]');
const frame = (page: Page) => page.getByTestId('html-preview');
// The modal overlay is aria-hidden, so role-based locators cannot see inside it.
const dialogBtn = (page: Page, name: string) => dialog(page).locator('button', { hasText: name });

test.describe('html preview', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('renders the document, and its scripts do not run', async ({ page }) => {
    await emitRead(page, 'h1', 'D:/scub/report.html', HTML);
    await page.locator('[class*="toolFileLink"]').first().click();

    await expect(frame(page)).toBeVisible({ timeout: 5_000 });
    await expect(frame(page)).toHaveAttribute('sandbox', '');

    const inner = page.frameLocator('[data-testid="html-preview"]');
    await expect(inner.locator('h1')).toHaveText('Scub export');
    await expect(inner.locator('#ran')).toHaveCount(0);
  });

  test('toggles to the source and back', async ({ page }) => {
    await emitRead(page, 'h2', 'D:/scub/report.html', HTML);
    await page.locator('[class*="toolFileLink"]').first().click();
    await expect(frame(page)).toBeVisible({ timeout: 5_000 });

    await dialogBtn(page, 'Source').click();
    await expect(frame(page)).toHaveCount(0);
    await expect(page.locator('[data-line="1"]')).toContainText('<!DOCTYPE html>');

    await dialogBtn(page, 'Preview').click();
    await expect(frame(page)).toBeVisible();
  });

  test('a Read with an offset still renders the slice', async ({ page }) => {
    // The read a user clicks is usually a slice (`file.html:359-499`), and a browser
    // renders a fragment fine. Defaulting these to source made the whole feature look
    // absent, which is exactly how it was reported.
    //
    // Deliberately no assertion that Source scrolls to the requested line: measured on
    // the real file, the source view numbers the slice from 1 while the scroll target is
    // the absolute offset (359), so it matches nothing. That is a pre-existing defect of
    // the source view, not of this feature - see the task note.
    const slice = ['<p>first</p>', '<p>second</p>', '<p>third</p>'].join('\n');
    await emitRead(page, 'h3', 'D:/scub/report.html', slice, 359);

    await page.locator('[class*="toolFileLink"]').first().click();
    await expect(frame(page)).toBeVisible({ timeout: 5_000 });
    await expect(page.frameLocator('[data-testid="html-preview"]').locator('p').first()).toHaveText('first');

    await dialogBtn(page, 'Source').click();
    await expect(page.locator('[data-line="1"]')).toContainText('first');
  });

  test('renders in the panel theme, over the document own colours', async ({ page }) => {
    // The fixture paints itself white the way a real export does (VS Code's markdown.css
    // ships with the html), so this fails unless the injected sheet actually wins.
    const white = '<style>body { background: #ffffff; color: #111; }</style><p>scub</p>';
    await emitRead(page, 'h5', 'D:/scub/report.html', white);
    await page.locator('[class*="toolFileLink"]').first().click();
    await expect(frame(page)).toBeVisible({ timeout: 5_000 });

    const inner = page.frameLocator('[data-testid="html-preview"]');
    await expect(inner.locator('style#argus-theme')).toHaveCount(1);
    // Computed, not declared: what the user sees is the cascade's answer, and the point
    // of the sheet is that it beats the document's own rule.
    const bg = await inner.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
    const appBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toBe('rgb(255, 255, 255)');
    expect(bg).toBe(appBg);
  });

  test('a non-html file is untouched', async ({ page }) => {
    // The control: no iframe, and no toggle button offered.
    await emitRead(page, 'h4', 'D:/scub/app.ts', 'const scub = 1;');
    await page.locator('[class*="toolFileLink"]').first().click();

    await expect(page.locator('[data-line="1"]')).toBeVisible({ timeout: 5_000 });
    await expect(frame(page)).toHaveCount(0);
    await expect(dialogBtn(page, 'Source')).toHaveCount(0);
  });
});
