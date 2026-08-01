import { test, expect, type Page } from '@playwright/test';
import * as path from 'path';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

const ROOT_DOC = path.resolve(__dirname, 'fixtures', 'preview-root.md');

// The modal overlay is aria-hidden, so role-based locators cannot see inside it.
const dialog = (page: Page) => page.locator('[role="dialog"]');
const docTitle = (page: Page) => dialog(page).locator('[class*="title"]').first();
const heading = (page: Page, text: string) => dialog(page).locator('h1', { hasText: text });
const docLink = (page: Page, text: string) => dialog(page).locator('a', { hasText: text });

// Open the previewer on the fixture by clicking its path in a chat message.
async function openRoot(page: Page) {
  await send(page, {
    type: 'message',
    message: { id: '1', role: 'assistant', content: `See ${ROOT_DOC} for the index.` },
  });
  const link = page.getByRole('link', { name: /preview-root\.md/ }).first();
  await expect(async () => {
    if ((await dialog(page).count()) === 0) await link.click();
    await expect(dialog(page)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await expect(heading(page, 'scub preview root')).toBeVisible();
}

test.describe('file previewer navigation', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('following a relative link loads the sibling doc in the same modal', async ({ page }) => {
    await openRoot(page);

    await docLink(page, 'child doc').click();

    await expect(heading(page, 'scub preview child')).toBeVisible();
    await expect(docTitle(page)).toContainText('preview-child.md');
    // Still one modal - the document was replaced, not stacked on screen.
    await expect(dialog(page)).toHaveCount(1);
  });

  test('back returns to the previous document', async ({ page }) => {
    await openRoot(page);

    const back = dialog(page).locator('button[aria-label="Back"]');
    await expect(back).toHaveCount(0);

    await docLink(page, 'child doc').click();
    await expect(heading(page, 'scub preview child')).toBeVisible();

    await back.click();

    await expect(heading(page, 'scub preview root')).toBeVisible();
    await expect(back).toHaveCount(0);
  });

  test('resolves links into a subfolder and back up with ..', async ({ page }) => {
    await openRoot(page);

    await docLink(page, 'nested doc').click();
    await expect(heading(page, 'scub preview nested')).toBeVisible();
    await expect(docTitle(page)).toContainText('preview-nested.md');

    // "../preview-root.md" from the subfolder resolves back to the root doc.
    await docLink(page, 'root doc').click();
    await expect(heading(page, 'scub preview root')).toBeVisible();
  });

  test('external links keep their href and do not navigate the previewer', async ({ page }) => {
    await openRoot(page);

    await expect(docLink(page, 'anthropic')).toHaveAttribute('href', 'https://www.anthropic.com');
    await expect(heading(page, 'scub preview root')).toBeVisible();
  });

  test('no "Open in editor" button in browser mode', async ({ page }) => {
    await openRoot(page);

    await expect(dialog(page).locator('button', { hasText: 'Open in editor' })).toHaveCount(0);
  });
});
