import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

function injectImageMessage(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 50;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#444';
    ctx.fillRect(0, 0, 100, 50);
    ctx.fillStyle = '#0f0';
    ctx.font = '14px monospace';
    ctx.fillText('scub-img', 10, 30);
    const base64 = canvas.toDataURL('image/png').split(',')[1];

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'message',
        message: {
          id: 'scub-img-1',
          role: 'user',
          content: 'scub-image-test',
          images: [{ mediaType: 'image/png', data: base64 }],
          ts: Date.now(),
        },
      },
    }));
  });
}

test.describe('image viewer modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await waitForApp(page);
    await injectImageMessage(page);
  });

  test('click image opens modal with copy and close buttons', async ({ page }) => {
    await page.getByRole('img', { name: 'Attachment 1' }).click();

    const dialog = page.getByRole('dialog', { name: 'Image viewer' });
    await expect(dialog).toBeVisible();

    await expect(page.getByRole('button', { name: 'Copy image (Ctrl+C)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
  });

  test('close button dismisses modal', async ({ page }) => {
    await page.getByRole('img', { name: 'Attachment 1' }).click();
    await expect(page.getByRole('dialog', { name: 'Image viewer' })).toBeVisible();

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog', { name: 'Image viewer' })).toHaveCount(0);
  });

  test('Escape key dismisses modal', async ({ page }) => {
    await page.getByRole('img', { name: 'Attachment 1' }).click();
    await expect(page.getByRole('dialog', { name: 'Image viewer' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Image viewer' })).toHaveCount(0);
  });

  test('clicking overlay dismisses modal', async ({ page }) => {
    await page.getByRole('img', { name: 'Attachment 1' }).click();
    await expect(page.getByRole('dialog', { name: 'Image viewer' })).toBeVisible();

    // Click outside the image container (on the overlay)
    await page.locator('[class*="imageOverlay"]').click({ position: { x: 5, y: 5 } });
    await expect(page.getByRole('dialog', { name: 'Image viewer' })).toHaveCount(0);
  });

  test('copy button shows toast in browser mode', async ({ page }) => {
    await page.getByRole('img', { name: 'Attachment 1' }).click();
    await page.getByRole('button', { name: 'Copy image (Ctrl+C)' }).click();

    const toast = page.locator('[class*="toast"]');
    await expect(toast).toBeVisible({ timeout: 3000 });
    await expect(toast).toHaveText('Copied to clipboard');
  });

  test('Ctrl+C shows toast in browser mode', async ({ page }) => {
    await page.getByRole('img', { name: 'Attachment 1' }).click();

    const dialog = page.getByRole('dialog', { name: 'Image viewer' });
    await dialog.click();
    await page.keyboard.press('Control+c');

    const toast = page.locator('[class*="toast"]');
    await expect(toast).toBeVisible({ timeout: 3000 });
    await expect(toast).toHaveText('Copied to clipboard');
  });

  test('toast auto-hides after 2 seconds', async ({ page }) => {
    await page.getByRole('img', { name: 'Attachment 1' }).click();
    await page.getByRole('button', { name: 'Copy image (Ctrl+C)' }).click();

    const toast = page.locator('[class*="toast"]');
    await expect(toast).toBeVisible({ timeout: 3000 });
    await expect(toast).not.toBeVisible({ timeout: 4000 });
  });

  test('modal image displays correct alt text', async ({ page }) => {
    await page.getByRole('img', { name: 'Attachment 1' }).click();

    const dialog = page.getByRole('dialog', { name: 'Image viewer' });
    const img = dialog.getByRole('img', { name: 'Attachment 1' });
    await expect(img).toBeVisible();
  });

  test('multiple images open correct viewer', async ({ page }) => {
    // Inject a message with two images
    await page.evaluate(() => {
      const makeImage = (text: string) => {
        const canvas = document.createElement('canvas');
        canvas.width = 80;
        canvas.height = 40;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#222';
        ctx.fillRect(0, 0, 80, 40);
        ctx.fillStyle = '#ff0';
        ctx.font = '12px monospace';
        ctx.fillText(text, 5, 25);
        return canvas.toDataURL('image/png').split(',')[1];
      };

      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'message',
          message: {
            id: 'scub-multi-img',
            role: 'user',
            content: 'scub-multi-image-test',
            images: [
              { mediaType: 'image/png', data: makeImage('scub-first') },
              { mediaType: 'image/png', data: makeImage('scub-second') },
            ],
            ts: Date.now(),
          },
        },
      }));
    });

    // Click the second image
    const images = page.getByRole('img', { name: 'Attachment 2' });
    await images.click();

    const dialog = page.getByRole('dialog', { name: 'Image viewer' });
    const viewerImg = dialog.getByRole('img', { name: 'Attachment 2' });
    await expect(viewerImg).toBeVisible();
  });
});
