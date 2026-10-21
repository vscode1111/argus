import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

const image = {
  mediaType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XioAAAAASUVORK5CYII=',
};

test('image in a mid-turn request appears in the inline bubble', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(attachment => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'message', message: {
      id: 'first', role: 'user', content: 'Opening image', images: [attachment],
    } } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'thinking_start' } }));
  }, image);
  await expect(page.locator('img[alt="Attachment 1"]')).toHaveCount(1);
  await page.evaluate(attachment => {
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'user_inject', text: 'Inspect this diagram', images: [attachment],
    } }));
  }, image);

  const bubble = page.locator('div[class*="userInject"]');
  await expect(bubble).toContainText('Inspect this diagram');
  await expect(bubble.locator('img')).toHaveCount(1);
  await expect.poll(() => bubble.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(1);
  await bubble.locator('img').click();
  await expect(page.getByRole('dialog', { name: 'Image viewer' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'done' } }));
  });
  await expect(bubble.locator('img')).toHaveCount(1);
});
