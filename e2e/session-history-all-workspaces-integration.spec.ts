import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Exercises the Session History "All workspaces" tab end to end against the real
// backend `listAllSessions` handler: the dev server scans ~/.claude/projects across
// every workspace the CLI has run in and returns the most-recent sessions globally.
// The dev machine always has prior sessions across several workspaces (argus,
// career-agent, .claude, telegram, ...), so the list is non-empty and spans more
// than one workspace.

// Opens Session History and switches to the "All workspaces" tab, waiting for the
// real global session list to arrive (the tab-specific search box appears and the
// loading placeholder is gone).
async function openAllWorkspaces(page: Page) {
  await page.getByRole('button', { name: 'Session history' }).click();
  const dialog = page.getByRole('dialog', { name: 'Session History' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('tab', { name: 'All workspaces' }).click();
  const search = dialog.getByRole('textbox', { name: 'Search all sessions' });
  await expect(search).toBeVisible();
  await expect(dialog.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });
  return { dialog, search };
}

test.describe('session history - all workspaces (integration)', () => {
  test('lists global sessions spanning multiple workspaces and filters by search', async ({ page }) => {
    await waitForApp(page);

    const { dialog, search } = await openAllWorkspaces(page);

    // The dev machine has prior sessions, so at least one global row renders.
    const rows = dialog.locator('[class*="allRowMain"]');
    await expect(rows.first()).toBeVisible();
    const initialCount = await rows.count();
    expect(initialCount).toBeGreaterThan(0);

    // The list is genuinely global: the per-row workspace-name subtitle takes on
    // more than one distinct value (the current workspace plus at least one other).
    const subs = await dialog.locator('[class*="rowSub"]').allTextContents();
    const distinctWorkspaces = new Set(subs.map(s => s.trim()).filter(Boolean));
    expect(distinctWorkspaces.size).toBeGreaterThan(1);

    // A query that cannot match collapses the list to the empty-match placeholder.
    await search.fill('zzz-no-such-session-xyzzy');
    await expect(dialog.getByText('No matching sessions.')).toBeVisible();

    // The search matches the workspace name too (not just the title): filtering on
    // a workspace name keeps it in the results (other workspaces may still match via
    // their titles, so we assert inclusion rather than exclusivity).
    const someWorkspace = [...distinctWorkspaces][0];
    await search.fill(someWorkspace);
    await expect(rows.first()).toBeVisible();
    const shownSubs = (await dialog.locator('[class*="rowSub"]').allTextContents()).map(s => s.trim());
    expect(shownSubs).toContain(someWorkspace);

    // Clearing the query restores the full list.
    await search.fill('');
    await expect(rows).toHaveCount(initialCount);
  });

  test('the two tabs show different shapes of data', async ({ page }) => {
    await waitForApp(page);

    // Default "This workspace" tab: per-session rows carry rename/delete actions
    // and no workspace-name subtitle.
    await page.getByRole('button', { name: 'Session history' }).click();
    const dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });
    await expect(dialog.getByRole('button', { name: 'Delete session' }).first()).toBeVisible();
    await expect(dialog.locator('[class*="rowSub"]')).toHaveCount(0);

    // "All workspaces" tab: rows gain the workspace-name subtitle and drop the
    // per-row rename/delete actions (resume-only, cross-workspace).
    await dialog.getByRole('tab', { name: 'All workspaces' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Search all sessions' })).toBeVisible();
    await expect(dialog.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });
    await expect(dialog.locator('[class*="rowSub"]').first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Delete session' })).toHaveCount(0);
  });

  test('resuming a session from another workspace switches the workspace and replays', async ({ page }) => {
    await waitForApp(page);

    // The panel starts in the argus workspace (from the ?dir= query in waitForApp).
    const tile = page.getByRole('button', { name: 'Switch workspace' });
    const currentWorkspace = (await tile.textContent())?.trim() ?? '';
    expect(currentWorkspace).toBeTruthy();

    const { dialog } = await openAllWorkspaces(page);

    // Find the first session whose workspace-name subtitle differs from the current
    // workspace - clicking it must switch the panel to that workspace.
    const subs = dialog.locator('[class*="rowSub"]');
    const subTexts = (await subs.allTextContents()).map(s => s.trim());
    const foreignIndex = subTexts.findIndex(s => s && s !== currentWorkspace);
    expect(foreignIndex, 'expected a session from another workspace').toBeGreaterThanOrEqual(0);
    const foreignWorkspace = subTexts[foreignIndex];

    // Clicking the row (the subtitle bubbles to the row handler) resumes it.
    await subs.nth(foreignIndex).click();
    await expect(dialog).toHaveCount(0);

    // The workspace tile flips to the foreign workspace (proves switchWorkspace),
    // and the resumed transcript populates the header session name (proves the
    // reconnect -> resumeSession -> sessionLoaded round-trip replayed).
    await expect(tile).toHaveText(foreignWorkspace, { timeout: 20_000 });
    const sessionName = page.locator('.sessionName');
    await expect(sessionName).toBeVisible({ timeout: 20_000 });
    await expect(sessionName).not.toHaveText('');
  });
});
