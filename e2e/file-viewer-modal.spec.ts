import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

const modalLine = (page: Page, n: number) =>
  page.locator(`[data-line="${n}"]`);

const modalDialog = (page: Page) =>
  page.locator('[role="dialog"]');

function emitReadTool(
  page: Page,
  id: string,
  path: string,
  result: string,
  opts?: { offset?: number; limit?: number },
) {
  const input: Record<string, unknown> = { file_path: path };
  if (opts?.offset != null) input.offset = opts.offset;
  if (opts?.limit != null) input.limit = opts.limit;
  return page.evaluate(({ id, input, result }) => {
    function fire(data: object) {
      window.dispatchEvent(new MessageEvent('message', { data }));
    }
    fire({ type: 'thinking_start' });
    fire({ type: 'tool_start', call: { id, name: 'Read', input } });
    fire({ type: 'tool_end', call: { id, name: 'Read', input, result } });
    fire({ type: 'text_chunk', text: 'Done.' });
    fire({ type: 'done' });
  }, { id, input, result });
}

const SAMPLE_TS = Array.from({ length: 24 }, (_, i) => `${String(i + 1).padStart(6, ' ')}\t${'const line' + (i + 1) + ' = ' + (i + 1) + ';'}`).join('\n');

test.describe('Read tool line highlighting', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('Read with limit=80 shows :1-80 summary but does not highlight lines', async ({ page }) => {
    await emitReadTool(page, 'rh1', 'D:/_Projects/scub/app.ts', SAMPLE_TS, { limit: 80 });

    const summary = page.locator('[class*="toolSummary"]');
    await expect(summary).toContainText(':1-80');

    await summary.click();
    await expect(modalLine(page, 1)).toBeVisible({ timeout: 5_000 });

    await expect(modalLine(page, 1)).not.toHaveClass(/highlighted-line/);
    await expect(modalLine(page, 10)).not.toHaveClass(/highlighted-line/);
    await expect(modalLine(page, 24)).not.toHaveClass(/highlighted-line/);

    await page.keyboard.press('Escape');
  });

  test('Read with offset=5 limit=10 highlights lines 5-15', async ({ page }) => {
    await emitReadTool(page, 'rh2', 'D:/_Projects/scub/app.ts', SAMPLE_TS, { offset: 5, limit: 10 });

    const summary = page.locator('[class*="toolSummary"]');
    await expect(summary).toContainText(':5-15');

    await summary.click();
    await expect(modalLine(page, 5)).toBeVisible({ timeout: 5_000 });

    for (const n of [5, 10, 15]) {
      await expect(modalLine(page, n)).toHaveClass(/highlighted-line/);
    }

    await expect(modalLine(page, 4)).not.toHaveClass(/highlighted-line/);
    await expect(modalLine(page, 16)).not.toHaveClass(/highlighted-line/);

    await page.keyboard.press('Escape');
  });

  test('Read without offset/limit shows plain path and no highlight', async ({ page }) => {
    await emitReadTool(page, 'rh3', 'D:/_Projects/scub/app.ts', SAMPLE_TS);

    const summary = page.locator('[class*="toolSummary"]');
    await expect(summary).toHaveText('D:/_Projects/scub/app.ts');

    await summary.click();
    await expect(modalLine(page, 1)).toBeVisible({ timeout: 5_000 });

    await expect(modalLine(page, 1)).not.toHaveClass(/highlighted-line/);

    await page.keyboard.press('Escape');
  });
});

test.describe('FileViewerModal copy path button', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await waitForApp(page);
  });

  test('copy path button copies file path to clipboard', async ({ page }) => {
    const filePath = 'D:/_Projects/scub/config.ts';
    await emitReadTool(page, 'cp1', filePath, SAMPLE_TS);

    const summary = page.locator('[class*="toolSummary"]');
    await summary.click();
    await expect(modalLine(page, 1)).toBeVisible({ timeout: 5_000 });

    const copyBtn = modalDialog(page).locator('button[aria-label="Copy path"]');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(filePath);
  });

  test('copy path button shows checkmark after click', async ({ page }) => {
    await emitReadTool(page, 'cp2', 'D:/_Projects/scub/utils.ts', SAMPLE_TS);

    const summary = page.locator('[class*="toolSummary"]');
    await summary.click();
    await expect(modalLine(page, 1)).toBeVisible({ timeout: 5_000 });

    const copyBtn = modalDialog(page).locator('button[aria-label="Copy path"]');
    await copyBtn.click();

    const checkmark = copyBtn.locator('path[d="M2 8L6 12L14 4"]');
    await expect(checkmark).toBeVisible();
  });
});
