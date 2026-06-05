import { test, expect, type Page } from '@playwright/test';
import * as path from 'path';
import { waitForApp } from './helpers';

// The dev server resolves its workspace from the WS upgrade `dir` param, falling
// back to its own cwd (the repo root). It returns that path in the `workspaceInfo`
// reply to `getInfo`. The header renders the folder name (basename of the path) in
// a dedicated tile button that opens the Workspace History dialog.

test.describe('workspace name tile (integration)', () => {
  test('renders the server-provided workspace folder name as its own tile', async ({ page }) => {
    await waitForApp(page);

    // With no `?dir=` on the page URL, the only source of the workspace path is the
    // server's `workspaceInfo` reply - so seeing the folder name proves the round
    // trip (WS handshake -> getInfo -> workspaceInfo -> reducer -> basename -> tile).
    const tile = page.getByRole('button', { name: 'Switch workspace' });
    await expect(tile).toBeVisible({ timeout: 15_000 });

    // The dev server's cwd is the repo root, whose folder name is "argus".
    await expect(tile).toHaveText('argus');

    // The tooltip carries the full absolute path the server sent.
    await expect(tile).toHaveAttribute('title', /[\\/]argus$/i);

    // It is a distinct element from the session-title label (the whole point of the
    // separate tile): exactly one workspace tile button is present.
    await expect(tile).toHaveCount(1);
  });

  test('reflects the basename of a `?dir=` override path', async ({ page }) => {
    // Point the app at a real subfolder of the project so the server accepts it
    // (it validates the path exists). The folder name should appear in the tile.
    const dir = path.join(process.cwd(), 'e2e');
    await page.goto(`/?dir=${encodeURIComponent(dir)}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByPlaceholder('Ask Argus')).toBeVisible({ timeout: 15_000 });

    const tile = page.getByRole('button', { name: 'Switch workspace' });
    await expect(tile).toBeVisible({ timeout: 15_000 });
    await expect(tile).toHaveText('e2e');
    await expect(tile).toHaveAttribute('title', /[\\/]e2e$/i);
  });

  test('hides the tile when the session bar is collapsed', async ({ page }) => {
    await waitForApp(page);

    const tile = page.getByRole('button', { name: 'Switch workspace' });
    await expect(tile).toBeVisible({ timeout: 15_000 });

    // The chevron toggle collapses the session bar to a corner tab; the workspace
    // tile lives inside that bar, so it disappears with it.
    await page.getByRole('button', { name: 'Hide session bar' }).click();
    await expect(tile).toHaveCount(0);

    await page.getByRole('button', { name: 'Show session bar' }).click();
    await expect(page.getByRole('button', { name: 'Switch workspace' })).toBeVisible({ timeout: 10_000 });
  });
});
