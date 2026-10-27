import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('copies a message when the async Clipboard API is unavailable', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForApp(page);

  const message = 'Review the pending release notes';
  await page.evaluate(text => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'message', message: { id: 'copy-example', role: 'user', content: text } } }));
  }, message);

  const button = page.getByRole('button', { name: 'Copy to clipboard' }).first();
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveText('✓');
  expect(await page.evaluate(() => {
    delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    return navigator.clipboard.readText();
  })).toBe(message);
});
