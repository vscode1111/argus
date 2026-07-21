import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Integration tests for the CLI launch counter shown in Settings > Info tab.
// The counter (cliLaunchCount) is a module-level variable in session.ts that
// increments each time a new `claude --print` process is spawned. It is
// included in the `serverInfo` WS reply and re-fetched every time the Info
// tab is clicked (not just on modal mount).
//
// The integration project runs workers in parallel against the shared :3001
// backend, so the absolute count can be higher than expected if other workers
// also spawn CLIs. Assertions use lower-bound comparisons (>= N) rather than
// exact equality.

async function openInfoTab(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Info' }).click();
}

function cliLaunchLocator(page: Page) {
  return page.getByTestId('cli-launches');
}

async function readCount(page: Page): Promise<number> {
  const text = (await cliLaunchLocator(page).textContent()) ?? '';
  return parseInt(text.trim(), 10);
}

test.describe('CLI launch counter (integration)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('Info tab shows CLI launches row with a non-negative integer', async ({ page }) => {
    await openInfoTab(page);

    const el = cliLaunchLocator(page);
    await expect(el).toBeVisible();

    // Value must resolve to a real number (not the placeholder '-').
    await expect.poll(() => el.textContent().then(t => t?.trim()), { timeout: 5_000 })
      .toMatch(/^\d+$/);

    const count = await readCount(page);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('CLI launch count increments after a process is spawned', async ({ page }) => {
    // Read the baseline count before sending any message.
    await openInfoTab(page);
    await expect.poll(() => cliLaunchLocator(page).textContent().then(t => t?.trim()), { timeout: 5_000 })
      .toMatch(/^\d+$/);
    const before = await readCount(page);

    // Close settings and send a message - this spawns a new `claude --print` process.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);

    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.fill('hi');
    await page.getByRole('button', { name: 'Send' }).click();

    // Stop button appearing means the CLI was spawned (cliLaunchCount already incremented).
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 15_000 });

    // Re-open settings and click Info - the tab click fires a fresh getServerInfo.
    await openInfoTab(page);

    // Count must be at least before+1 (>= because other parallel workers may also spawn).
    await expect.poll(() => readCount(page), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(before + 1);
  });

  test('Info tab re-fetches the count each time it is clicked', async ({ page }) => {
    // Open Settings modal - mount fires getServerInfo, count resolves to a number.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();

    // Navigate to Info tab (sends getServerInfo via setTab).
    await page.getByRole('button', { name: 'Info' }).click();
    await expect.poll(() => cliLaunchLocator(page).textContent().then(t => t?.trim()), { timeout: 5_000 })
      .toMatch(/^\d+$/);
    const count1 = await readCount(page);

    // Switch away then back to Info - each return click must send another getServerInfo.
    await page.getByRole('button', { name: 'General' }).click();
    await page.getByRole('button', { name: 'Info' }).click();

    // Count must still be a number (not '-') and at least as large as before
    // (no spawns happened, so it cannot decrease; other workers can only add).
    await expect.poll(() => cliLaunchLocator(page).textContent().then(t => t?.trim()), { timeout: 5_000 })
      .toMatch(/^\d+$/);
    const count2 = await readCount(page);
    expect(count2).toBeGreaterThanOrEqual(count1);
  });
});
