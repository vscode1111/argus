import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Integration coverage for dialog state persistence (position, size, selected
// tab) against the REAL backend. The mock spec proves the store mechanics; this
// proves it holds up with real async data: in particular that restoring a
// previously-selected lazy tab on reopen actually re-fires its real backend
// load (listAllSessions for Session History, listDir for Workspace History).
//
// The store is localStorage-backed, so geometry/tab survive a full page refresh;
// the Settings "Reset layout" button wipes the whole store (every dialog) at once.

// Simulate a manual resize via the native CSS grabber: the geometry hook only
// persists size when a pointerdown lands in the bottom-right grabber zone and is
// followed by a pointerup (content-driven size changes must NOT persist).
async function resizeViaGrabber(
  dialog: ReturnType<Page['getByRole']>,
  w: number,
  h?: number,
) {
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
  await resizeViaGrabber(dialog, 560, 480);
}

test.describe('dialog state persistence (integration)', () => {
  test('Session History: tab + geometry persist across reopen, and the restored lazy tab re-loads from the backend', async ({ page }) => {
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

  test('Session History: tab and size survive a full page refresh, and "Reset layout" clears them', async ({ page }) => {
    await waitForApp(page);

    await page.getByRole('button', { name: 'Session history' }).click();
    let dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'All workspaces' }).click();
    await resizeViaGrabber(dialog, 560);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // localStorage survives a real reload, so the tab and width come back.
    await waitForApp(page);
    await page.getByRole('button', { name: 'Session history' }).click();
    dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'All workspaces' })).toHaveAttribute('aria-selected', 'true');
    let box = await dialog.boundingBox();
    if (!box) throw new Error('no dialog box');
    expect(Math.abs(box.width - 560)).toBeLessThan(3);
    await page.keyboard.press('Escape');

    // Reset layout, then refresh: tab and size fall back to defaults.
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.getByRole('button', { name: 'Reset dialog layout' }).click();
    await page.keyboard.press('Escape');

    await waitForApp(page);
    await page.getByRole('button', { name: 'Session history' }).click();
    dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'This workspace' })).toHaveAttribute('aria-selected', 'true');
    box = await dialog.boundingBox();
    if (!box) throw new Error('no dialog box');
    expect(Math.abs(box.width - 440)).toBeLessThan(3); // default width restored
  });

  test('Workspace History: the restored "Browse" tab re-opens the real folder explorer on reopen', async ({ page }) => {
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

  test('Account & Usage: position and size persist across reopen and across a refresh', async ({ page }) => {
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

    // localStorage survives a refresh, so the resized width persists.
    await waitForApp(page);
    dialog = await openAccount();
    const afterRefresh = await dialog.boundingBox();
    if (!afterRefresh) throw new Error('no box');
    expect(Math.abs(afterRefresh.width - 560)).toBeLessThan(3);
  });

  test('Settings: tab and geometry both survive a refresh, and "Reset layout" clears them', async ({ page }) => {
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

    // Reopen: both tab and geometry are restored from localStorage.
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

    // After a refresh, tab and geometry both persist (localStorage).
    await waitForApp(page);
    dialog = await openSettings();
    await expect(dialog.getByRole('button', { name: 'Network' })).toHaveClass(/tabActive/);
    let afterRefresh = await dialog.boundingBox();
    if (!afterRefresh) throw new Error('no box');
    expect(Math.abs(afterRefresh.width - 560)).toBeLessThan(3);

    // "Reset layout" clears the stored tab + geometry; the live modal snaps back
    // to default width immediately, and after a refresh the tab is default too.
    // (The drag+resize left the modal's footer partly below the viewport, so pull
    // it back on-screen first; the reset recenters it regardless.)
    await dialog.evaluate((el) => { (el as HTMLElement).style.top = '40px'; });
    await dialog.getByRole('button', { name: 'Reset dialog layout' }).click();
    afterRefresh = await dialog.boundingBox();
    if (!afterRefresh) throw new Error('no box');
    expect(afterRefresh.width).toBeLessThan(520);
    await page.keyboard.press('Escape');

    await waitForApp(page);
    dialog = await openSettings();
    await expect(dialog.getByRole('button', { name: 'General' })).toHaveClass(/tabActive/);
    const cleared = await dialog.boundingBox();
    if (!cleared) throw new Error('no box');
    expect(cleared.width).toBeLessThan(520);
  });

  test('"Reset layout" clears EVERY dialog at once (cross-dialog), and the wipe survives a refresh', async ({ page }) => {
    await waitForApp(page);

    async function openSessionHistory() {
      await page.getByRole('button', { name: 'Session history' }).click();
      const d = page.getByRole('dialog', { name: 'Session History' });
      await expect(d).toBeVisible();
      return d;
    }
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

    // Seed non-default state in two different dialogs: Session History (lazy tab +
    // resize) and Account & Usage (resize). Both write into the shared store.
    let sessions = await openSessionHistory();
    await sessions.getByRole('tab', { name: 'All workspaces' }).click();
    await resizeViaGrabber(sessions, 560);
    await page.keyboard.press('Escape');
    await expect(sessions).toHaveCount(0);

    let account = await openAccount();
    await resizeViaGrabber(account, 560);
    await page.keyboard.press('Escape');
    await expect(account).toHaveCount(0);

    // The store now holds entries for both dialogs.
    const seeded = await page.evaluate(() => localStorage.getItem('argus.dialogState'));
    expect(seeded).toContain('sessionHistory');
    expect(seeded).toContain('account');

    // One "Reset layout" click from Settings wipes the whole store (the open
    // Settings modal may re-record its own default size, but no other dialog's).
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.getByRole('button', { name: 'Reset dialog layout' }).click();
    const afterReset = await page.evaluate(() => localStorage.getItem('argus.dialogState'));
    expect(afterReset ?? '').not.toContain('sessionHistory');
    expect(afterReset ?? '').not.toContain('account');
    await page.keyboard.press('Escape');

    // The wipe persists through a real refresh: both dialogs are back to defaults.
    await waitForApp(page);

    sessions = await openSessionHistory();
    await expect(sessions.getByRole('tab', { name: 'This workspace' })).toHaveAttribute('aria-selected', 'true');
    let box = await sessions.boundingBox();
    if (!box) throw new Error('no session box');
    expect(Math.abs(box.width - 440)).toBeLessThan(3); // default width
    await page.keyboard.press('Escape');
    await expect(sessions).toHaveCount(0);

    account = await openAccount();
    box = await account.boundingBox();
    if (!box) throw new Error('no account box');
    expect(Math.abs(box.width - 380)).toBeLessThan(3); // default width
  });
});
