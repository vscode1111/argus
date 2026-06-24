import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Integration coverage for dialog state persistence (position, size, selected
// tab) against the REAL backend. The mock spec proves the store mechanics; this
// proves it holds up with real async data: in particular that restoring a
// previously-selected lazy tab on reopen actually re-fires its real backend
// load (listAllSessions for Session History, listDir for Workspace History).

// Drag the modal by its handle, then resize it to a fixed 560x480. The handle
// defaults to the shared modal header; SettingsModal uses a thin drag bar, so it
// passes its own handle locator.
async function dragAndResize(
  page: Page,
  dialog: ReturnType<Page['getByRole']>,
  handle?: ReturnType<Page['getByRole']>,
) {
  const h = handle ?? dialog.locator('[class*="header"]').first();
  const start = await h.boundingBox();
  if (!start) throw new Error('no handle box');
  const hy = start.y + Math.min(start.height / 2, 12);
  await page.mouse.move(start.x + start.width / 2, hy);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 - 90, hy + 70, { steps: 5 });
  await page.mouse.up();
  await dialog.evaluate((el) => {
    el.style.width = '560px';
    el.style.height = '480px';
  });
  // Let the rAF-batched ResizeObserver record the new size.
  await page.waitForTimeout(80);
}

test.describe('dialog state persistence (integration)', () => {
  test('Session History: tab + geometry persist across reopen, and the restored lazy tab re-loads from the backend', async ({ page }) => {
    test.setTimeout(120_000);
    await waitForApp(page);

    // Open and switch to the lazy "All workspaces" tab; the real backend scans
    // ~/.claude/projects and replies, so the "Loading..." placeholder clears.
    await page.getByRole('button', { name: 'Session history' }).click();
    let dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'All workspaces' }).click();
    await expect(dialog.getByText('Loading...')).toHaveCount(0, { timeout: 30_000 });

    await dragAndResize(page, dialog);
    const moved = await dialog.boundingBox();
    if (!moved) throw new Error('no dialog box');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Reopen: the tab is restored, and because the lazy-load ref is fresh on the
    // new mount, the "All workspaces" list must be re-fetched from the backend -
    // proven by the placeholder clearing again (it would hang on "Loading..."
    // forever if the restored-tab load didn't fire).
    await page.getByRole('button', { name: 'Session history' }).click();
    dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'All workspaces' })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByText('Loading...')).toHaveCount(0, { timeout: 30_000 });

    const reopened = await dialog.boundingBox();
    if (!reopened) throw new Error('no reopened box');
    expect(Math.abs(reopened.x - moved.x)).toBeLessThan(3);
    expect(Math.abs(reopened.y - moved.y)).toBeLessThan(3);
    expect(Math.abs(reopened.width - 560)).toBeLessThan(3);
    expect(Math.abs(reopened.height - 480)).toBeLessThan(3);
  });

  test('Session History: a full page refresh resets tab and size to defaults', async ({ page }) => {
    test.setTimeout(120_000);
    await waitForApp(page);

    await page.getByRole('button', { name: 'Session history' }).click();
    let dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'All workspaces' }).click();
    await dialog.evaluate((el) => { el.style.width = '560px'; });
    await page.waitForTimeout(80);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // A real reload re-evaluates the webview module, dropping the in-memory store.
    await waitForApp(page);
    await page.getByRole('button', { name: 'Session history' }).click();
    dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'This workspace' })).toHaveAttribute('aria-selected', 'true');
    const box = await dialog.boundingBox();
    if (!box) throw new Error('no dialog box');
    expect(Math.abs(box.width - 440)).toBeLessThan(3); // default width restored
  });

  test('Workspace History: the restored "Browse" tab re-opens the real folder explorer on reopen', async ({ page }) => {
    test.setTimeout(120_000);
    await waitForApp(page);

    await page.getByRole('button', { name: 'Switch workspace' }).click();
    let dialog = page.getByRole('dialog', { name: 'Workspace History' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'Browse' }).click();
    // The real listDir reply populates the home directory; the explorer is ready
    // once "Open this folder" is enabled (a folder, not the drives root, loaded).
    await expect(dialog.getByRole('button', { name: 'Open this folder' })).toBeEnabled({ timeout: 30_000 });

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Reopen: the "Browse" tab is restored and its mount effect must re-issue
    // listDir, so the explorer becomes ready again rather than staying empty.
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    dialog = page.getByRole('dialog', { name: 'Workspace History' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Browse' })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('button', { name: 'Open this folder' })).toBeEnabled({ timeout: 30_000 });
  });

  test('Account & Usage: position and size persist across reopen and reset on refresh', async ({ page }) => {
    test.setTimeout(120_000);
    await waitForApp(page);

    async function openAccount() {
      const textarea = page.getByPlaceholder('Ask Argus');
      await textarea.focus();
      await textarea.pressSequentially('/usage');
      const action = page.locator('[class*="slashMenuItem"]', { hasText: 'Account & usage' });
      await expect(action).toBeVisible();
      await action.click();
      const d = page.getByRole('dialog', { name: 'Account & Usage' });
      await expect(d).toBeVisible();
      return d;
    }

    let dialog = await openAccount();
    await dragAndResize(page, dialog);
    const moved = await dialog.boundingBox();
    if (!moved) throw new Error('no dialog box');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    dialog = await openAccount();
    const reopened = await dialog.boundingBox();
    if (!reopened) throw new Error('no reopened box');
    expect(Math.abs(reopened.x - moved.x)).toBeLessThan(3);
    expect(Math.abs(reopened.y - moved.y)).toBeLessThan(3);
    expect(Math.abs(reopened.width - 560)).toBeLessThan(3);
    expect(Math.abs(reopened.height - 480)).toBeLessThan(3);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // A refresh drops the in-memory geometry; the width returns to its 380 default.
    await waitForApp(page);
    dialog = await openAccount();
    const afterRefresh = await dialog.boundingBox();
    if (!afterRefresh) throw new Error('no box');
    expect(Math.abs(afterRefresh.width - 380)).toBeLessThan(3);
  });

  test('Settings: geometry resets on refresh while the tab survives it (localStorage)', async ({ page }) => {
    test.setTimeout(120_000);
    await waitForApp(page);

    async function openSettings() {
      await page.getByRole('button', { name: 'Settings' }).click();
      const d = page.getByRole('dialog', { name: 'Settings' });
      await expect(d).toBeVisible();
      return d;
    }

    let dialog = await openSettings();
    await dialog.getByRole('button', { name: 'Network' }).click();
    await expect(dialog.getByRole('button', { name: 'Network' })).toHaveClass(/tabActive/);
    await dragAndResize(page, dialog, dialog.locator('[class*="dragHandle"]').first());
    const moved = await dialog.boundingBox();
    if (!moved) throw new Error('no box');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Reopen: tab restored (localStorage) and geometry restored (in-memory store).
    dialog = await openSettings();
    await expect(dialog.getByRole('button', { name: 'Network' })).toHaveClass(/tabActive/);
    const reopened = await dialog.boundingBox();
    if (!reopened) throw new Error('no box');
    expect(Math.abs(reopened.x - moved.x)).toBeLessThan(3);
    expect(Math.abs(reopened.y - moved.y)).toBeLessThan(3);
    expect(Math.abs(reopened.width - 560)).toBeLessThan(3);
    expect(Math.abs(reopened.height - 480)).toBeLessThan(3);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // After a refresh the tab persists (localStorage) but the geometry is reset
    // (in-memory store cleared), so the width is no longer the resized 560.
    await waitForApp(page);
    dialog = await openSettings();
    await expect(dialog.getByRole('button', { name: 'Network' })).toHaveClass(/tabActive/);
    const afterRefresh = await dialog.boundingBox();
    if (!afterRefresh) throw new Error('no box');
    expect(afterRefresh.width).toBeLessThan(520);
  });
});
