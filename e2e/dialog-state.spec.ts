import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// The Session History modal stands in for all centered dialogs: position, size,
// and tab selection are remembered in an in-memory store that survives close /
// reopen but resets on a full page refresh (see webview/src/utils/dialogState.ts).

async function openModal(page: Page) {
  await page.getByRole('button', { name: 'Session history' }).click();
  await expect(page.getByRole('dialog', { name: 'Session History' })).toBeVisible();
  return page.getByRole('dialog', { name: 'Session History' });
}

async function closeModal(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Session History' })).toHaveCount(0);
}

test.describe('dialog state persistence', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('remembers the selected tab across close and reopen', async ({ page }) => {
    let dialog = await openModal(page);
    await dialog.getByRole('tab', { name: 'All workspaces' }).click();
    await expect(dialog.getByRole('tab', { name: 'All workspaces' })).toHaveAttribute('aria-selected', 'true');
    await closeModal(page);

    dialog = await openModal(page);
    await expect(dialog.getByRole('tab', { name: 'All workspaces' })).toHaveAttribute('aria-selected', 'true');
  });

  test('remembers position and size across close and reopen', async ({ page }) => {
    let dialog = await openModal(page);

    // Drag the header to move the modal, then resize it.
    const header = dialog.locator('[class*="header"]').first();
    const start = await header.boundingBox();
    if (!start) throw new Error('no header box');
    await page.mouse.move(start.x + start.width / 2, start.y + 10);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2 - 80, start.y + 70, { steps: 5 });
    await page.mouse.up();

    await dialog.evaluate((el) => {
      el.style.width = '560px';
      el.style.height = '480px';
    });
    // Let the ResizeObserver (rAF-batched) record the new size.
    await page.waitForTimeout(50);

    const moved = await dialog.boundingBox();
    if (!moved) throw new Error('no dialog box');

    await closeModal(page);
    dialog = await openModal(page);

    const reopened = await dialog.boundingBox();
    if (!reopened) throw new Error('no reopened box');
    expect(Math.abs(reopened.x - moved.x)).toBeLessThan(3);
    expect(Math.abs(reopened.y - moved.y)).toBeLessThan(3);
    expect(Math.abs(reopened.width - 560)).toBeLessThan(3);
    expect(Math.abs(reopened.height - 480)).toBeLessThan(3);
  });

  test('resets to defaults after a page refresh', async ({ page }) => {
    let dialog = await openModal(page);
    await dialog.getByRole('tab', { name: 'All workspaces' }).click();
    await dialog.evaluate((el) => { el.style.width = '560px'; });
    await page.waitForTimeout(50);
    await closeModal(page);

    // A full refresh re-evaluates the module, dropping the in-memory store.
    await waitForApp(page);
    dialog = await openModal(page);
    await expect(dialog.getByRole('tab', { name: 'This workspace' })).toHaveAttribute('aria-selected', 'true');
    const box = await dialog.boundingBox();
    if (!box) throw new Error('no dialog box');
    expect(Math.abs(box.width - 440)).toBeLessThan(3); // back to the default width
  });
});
