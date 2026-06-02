import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';
import * as fs from 'fs';
import * as path from 'path';

test('paste text.jpg via Ctrl+V and recognize text in response', async ({ page }) => {
  const imagePath = path.resolve(__dirname, '..', 'tests', 'text.jpg');
  const imageBuffer = fs.readFileSync(imagePath);
  const base64 = imageBuffer.toString('base64');

  await waitForApp(page);

  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill('Recognize text');
  await textarea.focus();

  await page.evaluate(async (b64: string) => {
    const byteChars = atob(b64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const file = new File([blob], 'text.jpg', { type: 'image/jpeg' });

    const dt = new DataTransfer();
    dt.items.add(file);

    const el = document.querySelector('textarea')!;
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, base64);

  // Wait for image preview to appear
  const preview = page.locator('[class*="imagePreview"] img');
  await expect(preview.first()).toBeVisible({ timeout: 5_000 });

  await page.getByRole('button', { name: 'Send' }).click();

  // Wait for assistant response containing key phrases from the image
  const messageArea = page.locator('[class*="messageList"], [class*="messages"]');
  await expect(messageArea).toContainText('Key Conventions', { timeout: 60_000 });
  await expect(messageArea).toContainText(/claude-(opus|sonnet|haiku)-\d+-\d+/, { timeout: 5_000 });
  await expect(messageArea).toContainText('finalMessage', { timeout: 5_000 });
  await expect(messageArea).toContainText('showWarningMessage', { timeout: 5_000 });
  await expect(messageArea).toContainText('Node.js/TypeScript', { timeout: 5_000 });
});
