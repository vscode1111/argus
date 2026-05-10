import { expect, type Page } from '@playwright/test';

/**
 * Navigate to the app and wait for React to mount.
 * Retries with page.reload() if the app gets stuck on the loading spinner
 * (can happen when Vite dev server is under parallel load).
 */
export async function waitForApp(page: Page): Promise<void> {
  const placeholder = page.getByPlaceholder('Ask Argus');
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt === 1) {
      await page.goto('/');
    } else {
      await page.reload();
    }

    try {
      await expect(placeholder).toBeVisible({ timeout: 10_000 });
      return;
    } catch {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`App failed to mount after ${MAX_ATTEMPTS} attempts`);
      }
    }
  }
}
