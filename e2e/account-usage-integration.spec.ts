import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { waitForApp } from './helpers';

// Known windows + labels, mirroring src/backend/accountUsage.ts and the modal.
// Kept in display order so live[i] lines up with the i-th rendered row.
const USAGE_WINDOWS: { key: string; label: string }[] = [
  { key: 'five_hour', label: 'Session (5hr)' },
  { key: 'seven_day', label: 'Weekly (7 day)' },
  { key: 'seven_day_opus', label: 'Weekly Opus' },
  { key: 'seven_day_sonnet', label: 'Weekly Sonnet' },
];

// Fetch live usage the same way the backend does, so the test can compare the
// rendered modal against ground truth instead of hardcoded (drifting) numbers.
// Returns null when unavailable (no token, rate limited, offline) so the caller
// can skip rather than flake.
async function fetchLiveUsage(): Promise<{ label: string; percent: number }[] | null> {
  let token: string | null = null;
  try {
    const p = path.join(os.homedir(), '.claude', '.credentials.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    token = j?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
  if (!token) return null;
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, { utilization?: number } | null>;
    const out: { label: string; percent: number }[] = [];
    for (const { key, label } of USAGE_WINDOWS) {
      const w = data[key];
      if (!w || typeof w !== 'object') continue; // null/absent windows are not rendered
      const pct = Number(w.utilization);
      if (isNaN(pct)) continue;
      // The modal computes round(utilization*100); backend stores utilization as pct/100,
      // so round(pct) is the same value the UI shows.
      out.push({ label, percent: Math.round(pct) });
    }
    return out;
  } catch {
    return null;
  }
}

// Opens the Account & Usage modal through the slash menu (same path a user takes).
async function openModal(page: Page) {
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.focus();
  await textarea.pressSequentially('/usage');
  const action = page.locator('[class*="slashMenuItem"]', { hasText: 'Account & usage' });
  await expect(action).toBeVisible();
  await action.click();
  await expect(page.getByRole('dialog', { name: 'Account & Usage' })).toBeVisible();
}

test.describe('account & usage (integration)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('fetches real account info from `claude auth status`', async ({ page }) => {
    await openModal(page);

    const dialog = page.getByRole('dialog', { name: 'Account & Usage' });

    // Wait for the server to answer getAccountUsage (spawns the CLI).
    await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });

    // The test machine is logged in, so the Account section must render.
    await expect(dialog).toContainText('Account', { timeout: 20_000 });
    await expect(dialog).not.toContainText('Not logged in');

    // Email row shows a real address (structural assertion, account-agnostic).
    const emailRow = dialog.locator('[class*="row"]', { hasText: 'Email' });
    await expect(emailRow).toBeVisible();
    await expect(emailRow.locator('[class*="value"]')).toContainText('@');

    // Auth method and Plan rows are present.
    await expect(dialog.locator('[class*="row"]', { hasText: 'Auth method' })).toBeVisible();
    await expect(dialog.locator('[class*="row"]', { hasText: 'Plan' })).toBeVisible();
  });

  test('renders the Usage section up front (live API, or graceful fallback)', async ({ page }) => {
    await openModal(page);
    await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });

    const dialog = page.getByRole('dialog', { name: 'Account & Usage' });
    await expect(dialog).toContainText('Usage');

    // The live /oauth/usage endpoint returns all windows immediately (no message
    // needed). The endpoint rate-limits aggressively, so if it is transiently
    // unavailable the modal shows the "unavailable" hint instead - accept either,
    // and when windows render, the 5hr session window sorts first.
    await expect(async () => {
      const rows = page.locator('[class*="usageRow"]');
      const count = await rows.count();
      if (count > 0) {
        await expect(rows.first().locator('[class*="usageName"]')).toHaveText('Session (5hr)');
        await expect(rows.first().locator('[class*="usagePercent"]')).toHaveText(/^\d+%$/);
      } else {
        await expect(dialog.getByText('Usage data is unavailable')).toBeVisible();
      }
    }).toPass({ timeout: 12_000 });
  });

  test('rendered usage values match the live /oauth/usage API', async ({ page }) => {
    // Ground truth, fetched the same way the backend does. Skip (do not fail) if
    // the endpoint is unavailable - it rate-limits aggressively.
    const live = await fetchLiveUsage();
    test.skip(live === null, 'live usage API unavailable (rate limited / offline)');
    test.skip(live!.length === 0, 'no usage windows returned by the live API');

    await openModal(page);
    await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });

    const dialog = page.getByRole('dialog', { name: 'Account & Usage' });

    // Only the known windows the API returned are rendered (codename windows like
    // `tangelo`/`iguana_necktie` and null windows like Opus must be filtered out).
    await expect(page.locator('[class*="usageRow"]')).toHaveCount(live!.length);

    for (const { label, percent } of live!) {
      const row = dialog.locator('[class*="usageRow"]', { hasText: label });
      await expect(row).toBeVisible();
      const shownText = await row.locator('[class*="usagePercent"]').innerText();
      const shown = Number(shownText.replace('%', ''));
      // Allow ±2% for drift between this fetch and the server's (60s-cached) fetch.
      expect(Math.abs(shown - percent), `${label}: UI ${shown}% vs live ${percent}%`).toBeLessThanOrEqual(2);
    }
  });
});
