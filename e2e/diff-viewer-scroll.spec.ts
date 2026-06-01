import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

function emitEditTool(page: Page) {
  const oldString = 'const x = 1;\nconst y = 2;\nconst z = 3;';
  const newString = 'const x = 100;\nconst y = 200;\nconst z = 300;\nconst w = 400;';
  const input = { file_path: 'D:/_Projects/scub/app.ts', old_string: oldString, new_string: newString };
  return page.evaluate(({ input }) => {
    function fire(data: object) {
      window.dispatchEvent(new MessageEvent('message', { data }));
    }
    fire({ type: 'thinking_start' });
    fire({ type: 'tool_start', call: { id: 'ed1', name: 'Edit', input } });
    fire({ type: 'tool_end', call: { id: 'ed1', name: 'Edit', input, result: 'OK' } });
    fire({ type: 'text_chunk', text: 'Done.' });
    fire({ type: 'done' });
  }, { input });
}

test.describe('DiffViewerModal scroll', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
    await emitEditTool(page);
  });

  test('diff modal columns do not overlap at narrow viewport', async ({ page }) => {
    const diffLink = page.locator('[class*="toolOutLink"]', { hasText: 'Diff' });
    await expect(diffLink).toBeVisible({ timeout: 5_000 });
    await diffLink.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const scrollEl = dialog.locator('[class*="scroll"]');
    const tableEl = dialog.locator('[class*="table"]');
    await expect(scrollEl).toBeVisible();
    await expect(tableEl).toBeVisible();

    // Set narrow viewport
    await page.setViewportSize({ width: 400, height: 600 });

    const dims = await scrollEl.evaluate(el => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));

    // The table should overflow the scroll container, enabling horizontal scroll
    expect(dims.scrollWidth).toBeGreaterThan(dims.clientWidth);

    // Grid columns should be at least 320px each
    const gridCols = await tableEl.evaluate(el =>
      getComputedStyle(el).gridTemplateColumns
    );
    const colWidths = gridCols.split(' ').map(s => parseFloat(s));
    for (const w of colWidths) {
      expect(w).toBeGreaterThanOrEqual(320);
    }
  });

  test('diff modal columns fill space at wide viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });

    const diffLink = page.locator('[class*="toolOutLink"]', { hasText: 'Diff' });
    await expect(diffLink).toBeVisible({ timeout: 5_000 });
    await diffLink.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const tableEl = dialog.locator('[class*="table"]');
    const gridCols = await tableEl.evaluate(el =>
      getComputedStyle(el).gridTemplateColumns
    );
    const colWidths = gridCols.split(' ').map(s => parseFloat(s));

    // Both columns should be wider than the 320px minimum at 1200px viewport
    for (const w of colWidths) {
      expect(w).toBeGreaterThan(320);
    }

    // Columns should be roughly equal (1fr 1fr)
    const diff = Math.abs(colWidths[0] - colWidths[1]);
    expect(diff).toBeLessThan(5);
  });
});
