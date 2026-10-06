import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

const DIRECTORY = 'C:\\scub\\scub Disk stats';
const MESSAGE = `Check ${DIRECTORY} \nscub next line`;

function showMessage(page: Page, role: 'user' | 'assistant') {
  return page.evaluate(({ content, messageRole }) => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'message', message: { id: 'scub-spaced-directory', role: messageRole, content } },
    }));
  }, { content: MESSAGE, messageRole: role });
}

test.describe('spaced directory link at a line break', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  for (const role of ['user', 'assistant'] as const) {
    test(`links the full directory in a ${role} message`, async ({ page }) => {
      await showMessage(page, role);
      const link = page.locator('a.file-path-link');
      await expect(link).toHaveCount(1);
      await expect(link).toHaveText(DIRECTORY);
      await expect(link).toHaveAttribute('title', `Open ${DIRECTORY}`);
      await expect(page.getByText('scub next line')).toBeVisible();
    });
  }

  test('control: a trailing separator already preserves the spaced directory', async ({ page }) => {
    const path = `${DIRECTORY}\\`;
    await page.evaluate((content) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'message', message: { id: 'scub-directory-control', role: 'user', content } },
      }));
    }, `Check ${path} \nscub next line`);
    await expect(page.locator('a.file-path-link')).toHaveText(path);
  });

  test('links a spaced directory that fills an inline code span', async ({ page }) => {
    await page.evaluate((content) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'message', message: { id: 'scub-inline-directory', role: 'assistant', content } },
      }));
    }, `See \`${DIRECTORY}\`. Scub reports are inside.`);
    const code = page.locator('code', { hasText: DIRECTORY });
    const link = code.locator('a.file-path-link');
    await expect(link).toHaveText(DIRECTORY);
    await expect(link).toHaveAttribute('title', `Open ${DIRECTORY}`);
    await expect(page.locator('p').filter({ has: code })).toContainText('Scub reports are inside.');
  });
});
