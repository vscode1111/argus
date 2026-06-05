import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Exercises the Workspace History "Browse" tab end to end against the real backend
// `listDir` handler: the dev server enumerates actual directories on the machine.
// The explorer opens at the user's home dir, walks up to the synthetic "This PC"
// level (drive roots), back down, and can open any browsed folder as the workspace.

// Opens the modal, switches to the Browse tab, and waits for the first real
// directory listing (home dir) to arrive - proven by the breadcrumb showing an
// absolute path instead of the "Loading..." placeholder.
async function openBrowse(page: Page) {
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  const dialog = page.getByRole('dialog', { name: 'Workspace History' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('tab', { name: 'Browse' }).click();
  const breadcrumb = dialog.locator('[class*="browsePath"]');
  // Home dir is an absolute Windows path, e.g. C:\Users\Admin.
  await expect(breadcrumb).toHaveText(/^[A-Za-z]:[\\/]/, { timeout: 20_000 });
  return { dialog, breadcrumb };
}

test.describe('workspace browse / folder explorer (integration)', () => {
  test('lists real folders, walks up to This PC (drives), and back down', async ({ page }) => {
    test.setTimeout(120_000);
    await waitForApp(page);

    const { dialog, breadcrumb } = await openBrowse(page);

    // Home directory always has sub-folders, so at least one folder row renders,
    // and an "Up" row is present (home is never a filesystem root).
    await expect(dialog.getByText('Up', { exact: true })).toBeVisible();
    await expect(dialog.locator('[class*="browseName"]').first()).toBeVisible();

    // Walk up one level at a time until the explorer reaches the synthetic
    // "This PC" root. Each click is a real listDir round-trip, so wait for the
    // breadcrumb to change before continuing.
    for (let i = 0; i < 12; i++) {
      const label = (await breadcrumb.textContent())?.trim() ?? '';
      if (label === 'This PC') break;
      await dialog.getByText('Up', { exact: true }).click();
      await expect(breadcrumb).not.toHaveText(label, { timeout: 10_000 });
    }

    // At "This PC": no further up, drive roots are listed, and the current folder
    // can't be opened as a workspace (nothing is selected yet).
    await expect(breadcrumb).toHaveText('This PC');
    await expect(dialog.getByText('Up', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(/^[A-Za-z]:\\$/).first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Open this folder' })).toBeDisabled();

    // Navigate back down into the system drive: the breadcrumb updates to the
    // drive root and the "Up" row reappears.
    await dialog.getByText(/^C:\\$/).first().click();
    await expect(breadcrumb).toHaveText('C:\\', { timeout: 10_000 });
    await expect(dialog.getByText('Up', { exact: true })).toBeVisible();
  });

  test('opens the browsed folder as the workspace', async ({ page }) => {
    test.setTimeout(120_000);
    await waitForApp(page);

    const { dialog, breadcrumb } = await openBrowse(page);

    // Capture the folder currently shown (home dir) and derive its basename, which
    // is what the header tile renders after a switch.
    const path = (await breadcrumb.textContent())!.trim();
    const expectedName = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop()!;

    // Open the current folder: the modal closes and the panel reconnects to it.
    await dialog.getByRole('button', { name: 'Open this folder' }).click();
    await expect(dialog).toHaveCount(0);

    // The workspace tile now reflects the opened folder's name (proves the
    // Browse -> Open -> switchWorkspace -> reducer -> basename round-trip).
    const tile = page.getByRole('button', { name: 'Switch workspace' });
    await expect(tile).toHaveText(expectedName, { timeout: 15_000 });
  });
});
