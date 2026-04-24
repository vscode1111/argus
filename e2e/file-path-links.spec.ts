import { test, expect } from '@playwright/test';

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

test.describe('file path links', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('argus.showDevHarness', 'true');
    });
    await page.goto('/');
    // Wait for the app to mount before interacting with DevHarness
    await expect(page.getByPlaceholder('Ask Argus')).toBeVisible({ timeout: 10_000 });
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
    await expect(messageArea.getByRole('link', { name: /server\\index\.ts:31-48/ })).toBeVisible();

    // Paths inside table cells
    await expect(messageArea.locator('td').getByRole('link')).toHaveCount(3);

    // Path inside <strong>
    await expect(messageArea.locator('strong').getByRole('link', { name: /extension\.ts/ })).toBeVisible();

    // Path in regular text (config.ts)
    await expect(messageArea.getByRole('link', { name: /config\.ts/ })).toBeVisible();
  });

  test('clicking a file path link opens FileViewerModal with file content', async ({ page }) => {
    page.getByRole('link', { name: /App\.tsx:390/ }).first().click();

    // Modal line numbers only appear after file content loads
    await expect(modalLine(page, 1)).toContainText('import React', { timeout: 10_000 });

    // Escape closes the modal
    await page.keyboard.press('Escape');
    await expect(modalLine(page, 1)).not.toBeVisible({ timeout: 2_000 });
  });

  test('clicking a table cell file path opens FileViewerModal', async ({ page }) => {
    page.locator('td').getByRole('link', { name: /package\.json/ }).click();

    await expect(modalLine(page, 1)).toContainText('{', { timeout: 10_000 });
    await expect(modalLine(page, 2)).toContainText('"name"');

    await page.keyboard.press('Escape');
  });

  test('file path with line number highlights and scrolls to that line', async ({ page }) => {
    page.getByRole('link', { name: /App\.tsx:390/ }).first().click();

    // The highlighted line should be visible (scrolled into view) and marked
    const target = modalLine(page, 390);
    await expect(target).toBeVisible({ timeout: 10_000 });
    await expect(target).toHaveClass(/highlighted-line/);

    // A non-highlighted line should not have the class
    await expect(modalLine(page, 1)).not.toHaveClass(/highlighted-line/);

    await page.keyboard.press('Escape');
  });

  test('file path with line range highlights all lines in range', async ({ page }) => {
    page.getByRole('link', { name: /index\.ts:31-48/ }).click();

    // First line in range should be visible (scrolled into view)
    await expect(modalLine(page, 31)).toBeVisible({ timeout: 10_000 });

    // First, middle, and last lines in range should all be highlighted
    for (const n of [31, 39, 48]) {
      await expect(modalLine(page, n)).toHaveClass(/highlighted-line/);
    }

    // Line just outside the range should NOT be highlighted
    await expect(modalLine(page, 49)).not.toHaveClass(/highlighted-line/);

    await page.keyboard.press('Escape');
  });

  test('clicking a bold-wrapped file path opens FileViewerModal', async ({ page }) => {
    page.locator('strong').getByRole('link', { name: /extension\.ts/ }).click();

    // extension.ts starts with "import * as vscode"
    await expect(modalLine(page, 1)).toContainText('import', { timeout: 10_000 });

    await page.keyboard.press('Escape');
  });
});
