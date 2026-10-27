import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XioAAAAASUVORK5CYII=', 'base64');

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('mobile browser can attach an image when keyboard paste is unavailable', async ({ page }) => {
  await waitForApp(page);

  const draft = page.getByPlaceholder('Ask Argus');
  await draft.fill('Describe this diagram');

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach image' }).tap();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: image });

  const preview = page.getByRole('img', { name: 'Attachment 1' });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(draft).toHaveValue('Describe this diagram');

  await page.getByRole('button', { name: 'Remove attachment 1' }).click();
  await expect(preview).toHaveCount(0);
});

test('clipboard paste still attaches an image when the browser delivers a file', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(base64 => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const file = new File([bytes], 'diagram.png', { type: 'image/png' });
    const data = new DataTransfer();
    data.items.add(file);
    document.querySelector('textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  }, image.toString('base64'));

  const preview = page.getByRole('img', { name: 'Attachment 1' });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
});
