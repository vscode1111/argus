import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { waitForApp } from './helpers';

/**
 * The whole feature end to end against a real CLI: an image the agent read must still
 * preview after the file it came from is gone, and its bytes must not have travelled
 * inside the message to get there.
 *
 * Deleting the file before the click is what makes this decisive - the disk read is
 * still in place as a fallback, so a build that only re-read the path would fail here
 * with `Error reading file: ENOENT`, which is exactly what the user saw.
 */

// Any base64 run this long in a frame means an image was inlined: the only large
// payload in this turn is the image itself (2.3KB -> ~3k base64 chars), and no
// ordinary text produces an unbroken run of base64 characters this long.
const INLINED_IMAGE_RE = /[A-Za-z0-9+/]{1000,}/;

test.describe('tool image preview (real CLI)', () => {
  test('an image read by the agent previews after its file is deleted, without shipping the bytes', async ({ page }) => {
    const name = `scub-tool-image-${Date.now()}.png`;
    const rel = `e2e/${name}`;
    const file = path.resolve(__dirname, name);
    fs.copyFileSync(path.resolve(__dirname, '..', 'media', 'argus-icon.png'), file);

    try {
      // Registered before the page loads, so the whole conversation is captured.
      const frames: string[] = [];
      page.on('websocket', (ws) => {
        ws.on('framereceived', (f) => {
          if (typeof f.payload === 'string') frames.push(f.payload);
        });
      });

      await waitForApp(page);

      await page.getByPlaceholder('Ask Argus').fill(
        `Use the Read tool on ${rel} and then reply with exactly OK. Do not use any other tool.`,
      );
      await page.getByRole('button', { name: 'Send' }).click();

      const link = page.locator('[class*="toolFileLink"]', { hasText: name });
      await expect(link.first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[class*="responseTime"]').first()).toBeVisible({ timeout: 30_000 });

      // The bandwidth half of the fix: the result carries a marker, not the image.
      const inlined = frames.filter((f) => INLINED_IMAGE_RE.test(f));
      expect(inlined, 'no frame may carry inlined base64 image data').toHaveLength(0);
      expect(frames.some((f) => /\[image image\/\w+ \d+ (KB|B)\]/.test(f)), 'the tool result carries an image marker').toBe(true);

      // Now the file is gone, so only the transcript can answer.
      fs.rmSync(file);

      // One click only: the modal opens on it and fills in when the host answers, so a
      // retry loop here would stack a second modal instead of covering a slow reply.
      await link.first().click();
      await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('[role="dialog"] img')).toBeVisible({ timeout: 15_000 });

      const src = await page.locator('[role="dialog"] img').getAttribute('src');
      expect(src ?? '').toMatch(/^data:image\/\w+;base64,/);
      // Non-trivial payload: a truncated or empty data URL would still render an <img>.
      expect((src ?? '').length).toBeGreaterThan(1000);

      await page.keyboard.press('Escape');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
