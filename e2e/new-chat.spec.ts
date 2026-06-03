import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

test.describe('new chat', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('New chat button clears the conversation', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-newchat-msg' } });
    await expect(page.getByText('scub-newchat-msg')).toBeVisible();

    // The button posts `newSession`; the dev server echoes `clear`, which the
    // reducer applies to wipe the conversation.
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(page.getByText('scub-newchat-msg')).toHaveCount(0);
  });
});
