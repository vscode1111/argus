import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

function clickDevButton(page: import('@playwright/test').Page, label: string) {
  return page.evaluate((lbl) => {
    const btns = document.querySelectorAll('#dev-harness button');
    for (const b of btns) {
      if (b.textContent === lbl) { (b as HTMLButtonElement).click(); return true; }
    }
    return false;
  }, label);
}

// The modal's SyntaxHighlighter lines have data-line attributes.
// Use them to verify file content loaded (avoids ambiguity with review code blocks).
const modalLine = (page: import('@playwright/test').Page, n: number) =>
  page.locator(`[data-line="${n}"]`);

async function clickAndWaitForModal(
  link: import('@playwright/test').Locator,
  page: import('@playwright/test').Page,
  lineNo = 1,
) {
  await expect(async () => {
    await link.click();
    await expect(modalLine(page, lineNo)).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 20_000 });
}

test.describe('file path links', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('argus.showDevHarness', 'true');
    });
    await waitForApp(page);
    await clickDevButton(page, 'rich+paths');
    // Wait for the review content to render
    await expect(page.getByRole('heading', { name: 'Code Review Results' })).toBeVisible({ timeout: 5_000 });
  });

  test('renders file paths as clickable links in various markdown contexts', async ({ page }) => {
    const messageArea = page.locator('[class*="messageList"], [class*="messages"]');

    // Bare path in paragraph
    await expect(messageArea.locator('p').getByRole('link', { name: /App\.tsx:120/ }).first()).toBeVisible();

    // Path inside inline code
    await expect(messageArea.getByRole('link', { name: /markdown\.tsx:4/ })).toBeVisible();

    // Path with line range after "File:" label
    await expect(messageArea.getByRole('link', { name: /src\\backend\\index\.ts:31-48/ })).toBeVisible();

    // Paths inside table cells
    await expect(messageArea.locator('td').getByRole('link')).toHaveCount(3);

    // Path inside <strong>
    await expect(messageArea.locator('strong').getByRole('link', { name: /extension\.ts/ })).toBeVisible();

    // Path in regular text (config.ts)
    await expect(messageArea.getByRole('link', { name: /config\.ts/ })).toBeVisible();
  });

  test('clicking a file path link opens FileViewerModal with file content', async ({ page }) => {
    const link = page.getByRole('link', { name: /App\.tsx:120/ }).first();
    await clickAndWaitForModal(link, page);

    await expect(modalLine(page, 1)).toContainText('import React');

    // Escape closes the modal (retry press under parallel load)
    await expect(async () => {
      await page.keyboard.press('Escape');
      await expect(modalLine(page, 1)).not.toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 5_000 });
  });

  test('clicking a table cell file path opens FileViewerModal', async ({ page }) => {
    const link = page.locator('td').getByRole('link', { name: /package\.json/ });
    await clickAndWaitForModal(link, page);

    await expect(modalLine(page, 1)).toContainText('{', { timeout: 5_000 });
    await expect(modalLine(page, 2)).toContainText('"name"', { timeout: 5_000 });

    await page.keyboard.press('Escape');
  });

  test('file path with line number highlights and scrolls to that line', async ({ page }) => {
    const link = page.getByRole('link', { name: /App\.tsx:120/ }).first();
    await clickAndWaitForModal(link, page, 120);

    await expect(modalLine(page, 120)).toHaveClass(/highlighted-line/);

    // A non-highlighted line should not have the class
    await expect(modalLine(page, 1)).not.toHaveClass(/highlighted-line/);

    await page.keyboard.press('Escape');
  });

  test('file path with line range highlights all lines in range', async ({ page }) => {
    const link = page.getByRole('link', { name: /backend\\index\.ts:31-48/ });
    await clickAndWaitForModal(link, page, 31);

    // First, middle, and last lines in range should all be highlighted
    for (const n of [31, 39, 48]) {
      await expect(modalLine(page, n)).toHaveClass(/highlighted-line/);
    }

    // Line just outside the range should NOT be highlighted
    await expect(modalLine(page, 49)).not.toHaveClass(/highlighted-line/);

    await page.keyboard.press('Escape');
  });

  test('clicking a bold-wrapped file path opens FileViewerModal', async ({ page }) => {
    const link = page.locator('strong').getByRole('link', { name: /extension\.ts/ });
    await clickAndWaitForModal(link, page);

    await expect(modalLine(page, 1)).toContainText('import');

    await page.keyboard.press('Escape');
  });
});

function sendDevMessage(page: import('@playwright/test').Page, text: string) {
  return page.evaluate((t) => {
    function send(data: object) {
      window.dispatchEvent(new MessageEvent('message', { data }));
    }
    send({ type: 'thinking_start' });
    send({ type: 'text_chunk', text: t });
    send({ type: 'done' });
  }, text);
}

test.describe('relative file path links', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('argus.showDevHarness', 'true');
    });
    await waitForApp(page);
  });

  test('renders relative paths as clickable links', async ({ page }) => {
    await sendDevMessage(page,
      'Changed files: src/backend/index.ts webview/src/App.tsx and e2e/helpers.ts');

    const messageArea = page.locator('[class*="messageList"], [class*="messages"]');
    await expect(messageArea.getByRole('link', { name: 'src/backend/index.ts' })).toBeVisible({ timeout: 5_000 });
    await expect(messageArea.getByRole('link', { name: 'webview/src/App.tsx' })).toBeVisible();
    await expect(messageArea.getByRole('link', { name: 'e2e/helpers.ts' })).toBeVisible();
  });

  test('clicking a relative path opens FileViewerModal with resolved content', async ({ page }) => {
    await sendDevMessage(page, 'See webview/src/App.tsx for details');

    const link = page.getByRole('link', { name: 'webview/src/App.tsx' });
    await clickAndWaitForModal(link, page);

    await expect(modalLine(page, 1)).toContainText('import React');

    await expect(async () => {
      await page.keyboard.press('Escape');
      await expect(modalLine(page, 1)).not.toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 5_000 });
  });

  test('relative path with line number opens at correct line', async ({ page }) => {
    await sendDevMessage(page, 'Error at src/frontend/extension.ts:5');

    const link = page.getByRole('link', { name: 'src/frontend/extension.ts:5' });
    await clickAndWaitForModal(link, page, 5);

    await expect(modalLine(page, 5)).toHaveClass(/highlighted-line/);
    await expect(modalLine(page, 1)).not.toHaveClass(/highlighted-line/);

    await page.keyboard.press('Escape');
  });

  test('URLs are not broken by relative path detection', async ({ page }) => {
    await sendDevMessage(page, 'See https://example.com/docs/guide.html for reference');

    const link = page.getByRole('link', { name: /example\.com/ });
    await expect(link).toBeVisible({ timeout: 5_000 });
    await expect(link).toHaveAttribute('href', 'https://example.com/docs/guide.html');

    // No nested file-path link inside the URL
    await expect(link.getByRole('link')).toHaveCount(0);
  });
});

const modalDialog = (page: import('@playwright/test').Page) =>
  page.locator('[role="dialog"]');

const modalImage = (page: import('@playwright/test').Page) =>
  modalDialog(page).locator('img');

test.describe('image file preview', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('argus.showDevHarness', 'true');
    });
    await waitForApp(page);
  });

  async function clickImageAndWaitForModal(
    link: import('@playwright/test').Locator,
    page: import('@playwright/test').Page,
  ) {
    await expect(async () => {
      await link.click();
      await expect(modalImage(page)).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 20_000 });
  }

  test('clicking an image path opens FileViewerModal with <img> instead of code', async ({ page }) => {
    await clickDevButton(page, 'rich+paths');
    await expect(page.getByRole('heading', { name: 'App icon' })).toBeVisible({ timeout: 5_000 });

    const link = page.getByRole('link', { name: /argus-icon\.png/ });
    await clickImageAndWaitForModal(link, page);

    const img = modalImage(page);
    await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(img).toHaveAttribute('alt', 'argus-icon.png');

    // No SyntaxHighlighter lines for images
    await expect(modalDialog(page).locator('[data-line]')).toHaveCount(0);
  });

  test('image modal has no encoding dropdown', async ({ page }) => {
    await clickDevButton(page, 'rich+paths');
    await expect(page.getByRole('heading', { name: 'App icon' })).toBeVisible({ timeout: 5_000 });

    const link = page.getByRole('link', { name: /argus-icon\.png/ });
    await clickImageAndWaitForModal(link, page);

    const dialog = modalDialog(page);
    await expect(dialog.locator('select')).toHaveCount(0);
    await expect(dialog.locator('button', { hasText: 'Open in editor' })).toBeVisible();
  });

  test('Escape closes the image modal', async ({ page }) => {
    await clickDevButton(page, 'rich+paths');
    await expect(page.getByRole('heading', { name: 'App icon' })).toBeVisible({ timeout: 5_000 });

    const link = page.getByRole('link', { name: /argus-icon\.png/ });
    await clickImageAndWaitForModal(link, page);

    await expect(async () => {
      await page.keyboard.press('Escape');
      await expect(modalDialog(page)).not.toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 5_000 });
  });

  test('relative image path opens as image preview', async ({ page }) => {
    await sendDevMessage(page, 'Check media/argus-icon.png for the icon');

    const link = page.getByRole('link', { name: /argus-icon\.png/ });
    await clickImageAndWaitForModal(link, page);

    const img = modalImage(page);
    await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(modalDialog(page).locator('[data-line]')).toHaveCount(0);

    await page.keyboard.press('Escape');
  });
});

test.describe('tool result count pluralization', () => {
  function send(page: import('@playwright/test').Page, data: object) {
    return page.evaluate((d) => {
      window.dispatchEvent(new MessageEvent('message', { data: d }));
    }, data);
  }

  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('Glob with 1 result shows inline result', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-glob-test' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'tool_start', call: { id: 'g1', name: 'Glob', input: { pattern: '*.ts' } } });
    await send(page, { type: 'tool_end', call: { id: 'g1', name: 'Glob', input: { pattern: '*.ts' }, result: 'src/index.ts' } });
    await send(page, { type: 'done' });

    const inline = page.locator('[class*="toolResultInline"]');
    await expect(inline).toHaveText('src/index.ts');
  });

  test('Glob with 3 results shows "3 files"', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-glob-multi' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'tool_start', call: { id: 'g2', name: 'Glob', input: { pattern: '*.ts' } } });
    await send(page, { type: 'tool_end', call: { id: 'g2', name: 'Glob', input: { pattern: '*.ts' }, result: 'a.ts\nb.ts\nc.ts' } });
    await send(page, { type: 'done' });

    const countLink = page.locator('[class*="toolResultCount"]');
    await expect(countLink).toHaveText('3 files');
  });

  test('Grep with 1 result shows inline result', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-grep-test' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'tool_start', call: { id: 'gr1', name: 'Grep', input: { pattern: 'foo' } } });
    await send(page, { type: 'tool_end', call: { id: 'gr1', name: 'Grep', input: { pattern: 'foo' }, result: 'src/foo.ts' } });
    await send(page, { type: 'done' });

    const inline = page.locator('[class*="toolResultInline"]');
    await expect(inline).toHaveText('src/foo.ts');
  });

  test('Grep with multiple results shows "N lines of output"', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-grep-multi' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'tool_start', call: { id: 'gr2', name: 'Grep', input: { pattern: 'bar' } } });
    await send(page, { type: 'tool_end', call: { id: 'gr2', name: 'Grep', input: { pattern: 'bar' }, result: 'a.ts:1:bar\nb.ts:2:bar' } });
    await send(page, { type: 'done' });

    const countLink = page.locator('[class*="toolResultCount"]');
    await expect(countLink).toHaveText('2 lines of output');
  });
});
