import { expect, test, type Page } from '@playwright/test';

export async function waitForApp(page: Page): Promise<void> {
  const placeholder = page.getByPlaceholder('Ask Argus');
  const MAX_ATTEMPTS = 3;

  // Mock-project tests must not be contaminated by the live dev backend: the
  // ?mock=1 flag tells the dev WS bridge to drop data-query messages so only
  // injected data is rendered. Integration tests use the real backend ('/').
  const target = test.info().project.name === 'mock' ? '/?mock=1' : '/';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt === 1) {
      await page.goto(target, { waitUntil: 'domcontentloaded' });
    } else {
      await page.reload({ waitUntil: 'domcontentloaded' });
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
