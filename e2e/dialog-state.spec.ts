import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// The Session History modal stands in for all centered dialogs: position, size,
// and tab selection are remembered in a localStorage-backed store that survives
// close / reopen AND a full page refresh, and is wiped by the Settings
// "Reset layout" button (see webview/src/utils/dialogState.ts).

async function openModal(page: Page) {
  await page.getByRole('button', { name: 'Session history' }).click();
  await expect(page.getByRole('dialog', { name: 'Session History' })).toBeVisible();
  return page.getByRole('dialog', { name: 'Session History' });
}

async function closeModal(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Session History' })).toHaveCount(0);
}

// Simulate a manual resize via the native CSS grabber: the geometry hook only
// persists size when a pointerdown lands in the bottom-right grabber zone and is
// followed by a pointerup (content-driven size changes must NOT persist).
async function resizeModal(page: Page, w: number, h?: number) {
  const dialog = page.getByRole('dialog', { name: 'Session History' });
  await dialog.evaluate((el, [width, height]) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 1, clientX: r.right - 4, clientY: r.bottom - 4,
    }));
    (el as HTMLElement).style.width = `${width}px`;
    if (height != null) (el as HTMLElement).style.height = `${height}px`;
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  }, [w, h] as [number, number | undefined]);
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

    await resizeModal(page, 560, 480);

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

  test('dragged Settings stays fully visible as the Argus window shrinks', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    const handle = dialog.locator('[data-dialog-drag-handle]');
    const start = await handle.boundingBox();
    if (!start) throw new Error('Missing Settings drag handle');
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2 + 450, start.y + start.height / 2 + 280, { steps: 5 });
    await page.mouse.up();
    const moved = await dialog.boundingBox();
    if (!moved) throw new Error('Missing dragged Settings dialog');
    await page.setViewportSize({ width: 500, height: 350 });
    await expect.poll(async () => {
      const box = await dialog.boundingBox();
      return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 501 && box.y + box.height <= 351;
    }).toBe(true);
    await page.setViewportSize({ width: 220, height: 190 });
    await expect.poll(async () => {
      const box = await dialog.boundingBox();
      return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 221 && box.y + box.height <= 191;
    }).toBe(true);
    await page.setViewportSize({ width: 1200, height: 800 });
    await expect.poll(async () => {
      const restored = await dialog.boundingBox();
      return !!restored && Math.abs(restored.x - moved.x) < 3 && Math.abs(restored.y - moved.y) < 3;
    }).toBe(true);
  });

  test('resized centered dialog stays fully visible as the Argus window shrinks', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    const dialog = await openModal(page);
    const handle = dialog.locator('[data-dialog-drag-handle]');
    const start = await handle.boundingBox();
    if (!start) throw new Error('Missing dialog drag handle');
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2 + 400, start.y + start.height / 2 + 250, { steps: 5 });
    await page.mouse.up();
    await resizeModal(page, 580, 500);
    await expect.poll(async () => {
      const box = await dialog.boundingBox();
      return !!box && box.x + box.width <= 1201 && box.y + box.height <= 801;
    }).toBe(true);
    const moved = await dialog.boundingBox();
    if (!moved) throw new Error('Missing resized dialog');
    await page.setViewportSize({ width: 500, height: 350 });
    await expect.poll(async () => {
      const box = await dialog.boundingBox();
      return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 501 && box.y + box.height <= 351;
    }).toBe(true);
    await closeModal(page);
    await openModal(page);
    await expect.poll(async () => {
      const box = await dialog.boundingBox();
      return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 501 && box.y + box.height <= 351;
    }).toBe(true);
    await page.setViewportSize({ width: 300, height: 250 });
    await expect.poll(async () => {
      const box = await dialog.boundingBox();
      return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 301 && box.y + box.height <= 251;
    }).toBe(true);
    await page.setViewportSize({ width: 1200, height: 800 });
    await expect.poll(async () => {
      const restored = await dialog.boundingBox();
      return !!restored && Math.abs(restored.x - Math.min(moved.x, 1200 - restored.width)) < 3 && Math.abs(restored.y - moved.y) < 3
        && Math.abs(restored.width - 580) < 3 && Math.abs(restored.height - 500) < 3;
    }).toBe(true);
  });

  test('persists tab and size across a page refresh', async ({ page }) => {
    let dialog = await openModal(page);
    await dialog.getByRole('tab', { name: 'All workspaces' }).click();
    await resizeModal(page, 560);
    await closeModal(page);

    // localStorage survives a full refresh, so the layout comes back.
    await waitForApp(page);
    dialog = await openModal(page);
    await expect(dialog.getByRole('tab', { name: 'All workspaces' })).toHaveAttribute('aria-selected', 'true');
    const box = await dialog.boundingBox();
    if (!box) throw new Error('no dialog box');
    expect(Math.abs(box.width - 560)).toBeLessThan(3);
  });

  test('does not persist size when the user only switches tabs (no manual resize)', async ({ page }) => {
    let dialog = await openModal(page);
    const before = await dialog.boundingBox();
    if (!before) throw new Error('no dialog box');

    // Switch tabs (a content change) but never touch the resize grabber.
    await dialog.getByRole('tab', { name: 'All workspaces' }).click();
    await dialog.getByRole('tab', { name: 'This workspace' }).click();

    // No size should have been recorded for this dialog.
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('argus.dialogState');
      if (!raw) return null;
      const all = JSON.parse(raw) as Record<string, { size?: unknown }>;
      const entry = Object.values(all).find((e) => e && 'size' in e);
      return entry ? entry.size ?? null : null;
    });
    expect(stored).toBeNull();

    await closeModal(page);
    dialog = await openModal(page);
    const after = await dialog.boundingBox();
    if (!after) throw new Error('no reopened box');
    // Width stays at the default - it was not silently pinned to a content size.
    expect(Math.abs(after.width - before.width)).toBeLessThan(3);
  });

  test('"Reset layout" wipes the saved tab and size', async ({ page }) => {
    let dialog = await openModal(page);
    await dialog.getByRole('tab', { name: 'All workspaces' }).click();
    await resizeModal(page, 560);
    await closeModal(page);

    // Reset layout from Settings, then refresh: everything is back to defaults.
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.getByRole('button', { name: 'Reset dialog layout' }).click();
    await page.keyboard.press('Escape');

    await waitForApp(page);
    dialog = await openModal(page);
    await expect(dialog.getByRole('tab', { name: 'This workspace' })).toHaveAttribute('aria-selected', 'true');
    const box = await dialog.boundingBox();
    if (!box) throw new Error('no dialog box');
    expect(Math.abs(box.width - 440)).toBeLessThan(3); // back to the default width
  });

  test('Reset layout restores dialogs that are currently open', async ({ page }) => {
    const history = await openModal(page);
    await history.getByRole('tab', { name: 'All workspaces' }).click();
    await resizeModal(page, 560, 480);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')?.click());
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Info' }).evaluate(button => (button as HTMLButtonElement).click());
    await settings.evaluate(element => {
      const box = element.getBoundingClientRect();
      element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: box.right - 4, clientY: box.bottom - 4 }));
      (element as HTMLElement).style.width = '470px';
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    });
    await settings.getByRole('button', { name: 'Reset dialog layout' }).evaluate(button => (button as HTMLButtonElement).click());
    await expect(settings.getByRole('button', { name: 'General' })).toHaveClass(/tabActive/);
    const settingsBox = await settings.boundingBox();
    if (!settingsBox) throw new Error('Missing Settings dialog');
    expect(Math.abs(settingsBox.width - 340)).toBeLessThan(3);
    await expect(history.getByRole('tab', { name: 'This workspace' })).toHaveAttribute('aria-selected', 'true');
    const box = await history.boundingBox();
    if (!box) throw new Error('Missing session history dialog');
    expect(Math.abs(box.width - 440)).toBeLessThan(3);
  });
});
