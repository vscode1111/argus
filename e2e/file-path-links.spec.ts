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

// Click a link and wait for the modal to open. Retries because the WS roundtrip
// for readFilePreview can be slow under parallel test load.
async function clickAndWaitForModal(
  link: import('@playwright/test').Locator,
  page: import('@playwright/test').Page,
  lineNo = 1,
) {
  await expect(async () => {
    await link.click();
    await expect(modalLine(page, lineNo)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 15_000 });
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
    await expect(messageArea.locator('p').getByRole('link', { name: /App\.tsx:390/ }).first()).toBeVisible();

    // Path inside inline code
    await expect(messageArea.getByRole('link', { name: /markdown\.tsx:4/ })).toBeVisible();

    // Path with line range after "File:" label
    await expect(messageArea.getByRole('link', { name: /src\\argusServer\.ts:31-48/ })).toBeVisible();

    // Paths inside table cells
    await expect(messageArea.locator('td').getByRole('link')).toHaveCount(3);

    // Path inside <strong>
    await expect(messageArea.locator('strong').getByRole('link', { name: /extension\.ts/ })).toBeVisible();

    // Path in regular text (config.ts)
    await expect(messageArea.getByRole('link', { name: /config\.ts/ })).toBeVisible();
  });

  test('clicking a file path link opens FileViewerModal with file content', async ({ page }) => {
    const link = page.getByRole('link', { name: /App\.tsx:390/ }).first();
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

    await expect(modalLine(page, 1)).toContainText('{');
    await expect(modalLine(page, 2)).toContainText('"name"');

    await page.keyboard.press('Escape');
  });

  test('file path with line number highlights and scrolls to that line', async ({ page }) => {
    const link = page.getByRole('link', { name: /App\.tsx:390/ }).first();
    await clickAndWaitForModal(link, page, 390);

    await expect(modalLine(page, 390)).toHaveClass(/highlighted-line/);

    // A non-highlighted line should not have the class
    await expect(modalLine(page, 1)).not.toHaveClass(/highlighted-line/);

    await page.keyboard.press('Escape');
  });

  test('file path with line range highlights all lines in range', async ({ page }) => {
    const link = page.getByRole('link', { name: /argusServer\.ts:31-48/ });
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
      'Changed files: src/argusServer.ts webview/src/App.tsx and e2e/helpers.ts');

    const messageArea = page.locator('[class*="messageList"], [class*="messages"]');
    await expect(messageArea.getByRole('link', { name: 'src/argusServer.ts' })).toBeVisible({ timeout: 5_000 });
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
    await sendDevMessage(page, 'Error at src/extension.ts:5');

    const link = page.getByRole('link', { name: 'src/extension.ts:5' });
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
