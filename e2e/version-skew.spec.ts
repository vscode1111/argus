import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

// Settings > Info shows Client (this build) and Server (the daemon serving the
// panel) versions, and flags whichever one is actually behind with "(stale)". A
// plain inequality check can't tell direction, so it used to always blame the
// Server row even when the daemon was the newer side - see SettingsModal.tsx's
// versionCompare/serverIsStale/clientIsStale.

async function openInfoTab(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Info' }).click();
  return dialog;
}

function setClientVersion(page: import('@playwright/test').Page, version: string) {
  return page.evaluate((v) => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'workspaceInfo', path: '/tmp/scub-workspace', version: v } }));
  }, version);
}

function setServerVersion(page: import('@playwright/test').Page, serverVersion: string) {
  return page.evaluate((v) => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'serverInfo', port: 3001, cliLaunchCount: 1, sessionId: '', sessionPath: null, serverVersion: v } }));
  }, serverVersion);
}

test.describe('Client/Server version skew direction', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('flags the Client row when the daemon is newer, not the Server row', async ({ page }) => {
    await setClientVersion(page, '0.0.79');
    const dialog = await openInfoTab(page);
    await setServerVersion(page, '0.0.80');

    await expect(dialog.getByTestId('client-version')).toHaveText('0.0.79 (stale)');
    await expect(dialog.getByTestId('server-version')).toHaveText('0.0.80');
    await expect(dialog.getByTestId('server-version')).not.toContainText('stale');
  });

  test('flags the Server row when the daemon is older, not the Client row', async ({ page }) => {
    await setClientVersion(page, '0.0.80');
    const dialog = await openInfoTab(page);
    await setServerVersion(page, '0.0.79');

    await expect(dialog.getByTestId('server-version')).toHaveText('0.0.79 (stale)');
    await expect(dialog.getByTestId('client-version')).toHaveText('0.0.80');
    await expect(dialog.getByTestId('client-version')).not.toContainText('stale');
  });

  test('compares version segments numerically, not lexicographically', async ({ page }) => {
    // A string compare puts "0.0.9" after "0.0.10" (since '9' > '1'), which would
    // wrongly flag the newer 0.0.10 client as stale.
    await setClientVersion(page, '0.0.10');
    const dialog = await openInfoTab(page);
    await setServerVersion(page, '0.0.9');

    await expect(dialog.getByTestId('server-version')).toHaveText('0.0.9 (stale)');
    await expect(dialog.getByTestId('client-version')).toHaveText('0.0.10');
    await expect(dialog.getByTestId('client-version')).not.toContainText('stale');
  });

  test('matching versions are never flagged on either side', async ({ page }) => {
    await setClientVersion(page, '0.0.80');
    const dialog = await openInfoTab(page);
    await setServerVersion(page, '0.0.80');

    await expect(dialog.getByTestId('client-version')).toHaveText('0.0.80');
    await expect(dialog.getByTestId('server-version')).toHaveText('0.0.80');
  });
});
