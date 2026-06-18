import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Exercises the Workspace History "Browse" tab editable breadcrumb against the real
// backend `listDir` handler: clicking the path turns it into an input, where a folder
// path can be typed or pasted. A valid path navigates there; an invalid path is
// corrected to the nearest existing ancestor directory (nearestExistingDir).

// Opens the modal, switches to Browse, and waits for the home-dir listing (breadcrumb
// shows an absolute path). The breadcrumb is the display <div>; while editing it is
// replaced by an <input>, so we target the div specifically.
async function openBrowse(page: Page) {
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  const dialog = page.getByRole('dialog', { name: 'Workspace History' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('tab', { name: 'Browse' }).click();
  const breadcrumb = dialog.locator('div[class*="browsePath"]');
  await expect(breadcrumb).toHaveText(/^[A-Za-z]:[\\/]/, { timeout: 20_000 });
  return { dialog, breadcrumb };
}

// Parent directory of an absolute path, preserving the original separator and the
// trailing slash for a bare drive root (e.g. C:\Users\Admin -> C:\Users).
function parentDir(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const segs = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  segs.pop();
  let parent = segs.join(sep);
  if (/^[A-Za-z]:$/.test(parent)) parent += sep; // drive root needs its slash
  return parent;
}

test.describe('workspace browse / editable path (integration)', () => {
  test('typing a valid path navigates the explorer there', async ({ page }) => {
    test.setTimeout(120_000);
    await waitForApp(page);

    const { dialog, breadcrumb } = await openBrowse(page);
    const home = (await breadcrumb.textContent())!.trim();
    const parent = parentDir(home);
    expect(parent).not.toBe(home); // home is never a drive root

    // Click the breadcrumb to edit, type the parent path, commit with Enter.
    await breadcrumb.click();
    const input = dialog.getByRole('textbox', { name: 'Folder path' });
    await expect(input).toBeVisible();
    await input.fill(parent);
    await input.press('Enter');

    // The real listDir round-trip lands: the input closes and the breadcrumb shows
    // the navigated folder, with at least one sub-folder row rendered.
    await expect(breadcrumb).toHaveText(parent, { timeout: 15_000 });
    await expect(input).toHaveCount(0);
    await expect(dialog.locator('[class*="browseName"]').first()).toBeVisible();
  });

  test('typing an invalid path falls back to the nearest existing directory', async ({ page }) => {
    test.setTimeout(120_000);
    await waitForApp(page);

    const { dialog, breadcrumb } = await openBrowse(page);
    const home = (await breadcrumb.textContent())!.trim();
    const parent = parentDir(home);
    const sep = home.includes('\\') ? '\\' : '/';

    // A path whose last segment does not exist but whose parent does. The backend
    // should correct it to `parent`, which differs from the starting `home`.
    const bogus = parent.replace(/[\\/]+$/, '') + sep + '__scub_nonexistent_xyz__';
    expect(parent).not.toBe(home);

    await breadcrumb.click();
    const input = dialog.getByRole('textbox', { name: 'Folder path' });
    await expect(input).toBeVisible();
    await input.fill(bogus);
    await input.press('Enter');

    // Breadcrumb corrects to the nearest existing ancestor (not the bogus path, and
    // visibly different from where we started), proving nearestExistingDir kicked in.
    await expect(breadcrumb).toHaveText(parent, { timeout: 15_000 });
    await expect(breadcrumb).not.toHaveText(bogus);
  });
});
