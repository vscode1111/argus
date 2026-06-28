import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

function sendSkills(page: Page, skills: { name: string; scope: string; kind?: string; description?: string }[]) {
  return send(page, { type: 'skills', skills });
}

const NOW = Math.floor(Date.now() / 1000);

const ACCOUNT = {
  loggedIn: true,
  authMethod: 'claude.ai',
  email: 'scub@example.com',
  orgName: "scub's Organization",
  subscriptionType: 'max',
};

const RATE_LIMITS = [
  // Intentionally out of display order to verify sorting (seven_day before five_hour here).
  { rateLimitType: 'seven_day', utilization: 0.17, resetsAt: NOW + 4 * 86_400, status: 'allowed' },
  { rateLimitType: 'five_hour', utilization: 0.88, resetsAt: NOW + 18 * 60, status: 'allowed_warning' },
  { rateLimitType: 'seven_day_sonnet', utilization: 0, resetsAt: NOW + 4 * 86_400, status: 'allowed' },
];

// Open the modal via the slash menu, then wait for the real (server) response to
// land so a later mock dispatch is the final write that wins.
async function openModal(page: Page) {
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.focus();
  await textarea.pressSequentially('/usage');
  const action = page.locator('[class*="slashMenuItem"]', { hasText: 'Account & usage' });
  await expect(action).toBeVisible();
  await action.click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 15_000 });
}

test.describe('account & usage', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('"Account & usage..." action appears under a Model header when typing /usage', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/usage');
    await sendSkills(page, []);

    const headers = page.locator('[class*="slashMenuHeader"]');
    await expect(headers.filter({ hasText: 'Model' })).toBeVisible();

    const action = page.locator('[class*="slashMenuItem"]', { hasText: 'Account & usage' });
    await expect(action).toBeVisible();
    // It is the only item, so it is highlighted by default.
    await expect(action).toHaveClass(/slashMenuItemActive/);
  });

  test('Enter selects the highlighted account action and opens the modal', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/usage');
    await sendSkills(page, []);

    await expect(page.locator('[class*="slashMenuItem"]', { hasText: 'Account & usage' })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
    // The "/usage" token is removed from the textarea.
    await expect(textarea).toHaveValue('');
  });

  test('renders account rows from the accountUsage message', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'accountUsage', account: ACCOUNT, rateLimits: [] });

    const dialog = page.getByRole('dialog', { name: 'Account' });
    await expect(dialog).toContainText('Account');
    await expect(dialog).toContainText('Auth method');
    await expect(dialog).toContainText('Claude AI');
    await expect(dialog).toContainText('scub@example.com');
    await expect(dialog).toContainText("scub's Organization");
    // 'max' is mapped to a friendly label.
    await expect(dialog).toContainText('Claude Max');
  });

  test('renders usage bars sorted, with percent, color tier, and reset labels', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'accountUsage', account: ACCOUNT, rateLimits: RATE_LIMITS });

    const rows = page.locator('[class*="usageRow"]');
    await expect(rows).toHaveCount(3);

    // Sorted: five_hour (Session) first, then seven_day, then seven_day_sonnet.
    await expect(rows.nth(0).locator('[class*="usageName"]')).toHaveText('Session (5hr)');
    await expect(rows.nth(1).locator('[class*="usageName"]')).toHaveText('Weekly (7 day)');
    await expect(rows.nth(2).locator('[class*="usageName"]')).toHaveText('Weekly Sonnet');

    // Percent text (round of utilization).
    await expect(rows.nth(0).locator('[class*="usagePercent"]')).toHaveText('88%');
    await expect(rows.nth(1).locator('[class*="usagePercent"]')).toHaveText('17%');
    await expect(rows.nth(2).locator('[class*="usagePercent"]')).toHaveText('0%');

    // 88% -> medium tier; 17% -> base tier (no tier class).
    await expect(rows.nth(0).locator('[class*="progressBar"]')).toHaveClass(/progressMedium/);
    await expect(rows.nth(1).locator('[class*="progressBar"]')).not.toHaveClass(/progressMedium|progressHigh/);

    // Reset labels: relative countdown (minutes for the 5hr window, days for the
    // weekly window) followed by the absolute reset time (e.g. "· Sun 9:00 PM").
    await expect(rows.nth(0).locator('[class*="resetLabel"]')).toHaveText(/Resets in \d+m/);
    await expect(rows.nth(1).locator('[class*="resetLabel"]')).toHaveText(/Resets in \d+d/);
    await expect(rows.nth(0).locator('[class*="resetLabel"]'))
      .toHaveText(/· (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2} (AM|PM)/);
  });

  test('high utilization uses the high (red) color tier', async ({ page }) => {
    await openModal(page);
    await send(page, {
      type: 'accountUsage',
      account: ACCOUNT,
      rateLimits: [{ rateLimitType: 'five_hour', utilization: 0.97, resetsAt: NOW + 600 }],
    });

    const bar = page.locator('[class*="usageRow"]').first().locator('[class*="progressBar"]');
    await expect(bar).toHaveClass(/progressHigh/);
  });

  test('refresh button re-requests usage and updates the bars', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'accountUsage', account: ACCOUNT, rateLimits: RATE_LIMITS });
    await expect(page.locator('[class*="usageRow"]')).toHaveCount(3);

    const refresh = page.getByRole('button', { name: 'Refresh usage' });
    await expect(refresh).toBeVisible();
    await refresh.click();

    // A fresh response replaces the bars and clears the spinner (this mock
    // dispatch is the final write, so it wins over the real server reply).
    await send(page, {
      type: 'accountUsage',
      account: ACCOUNT,
      rateLimits: [{ rateLimitType: 'five_hour', utilization: 0.42, resetsAt: NOW + 600 }],
    });
    await expect(page.locator('[class*="usageRow"]')).toHaveCount(1);
    await expect(page.locator('[class*="usagePercent"]').first()).toHaveText('42%');
    await expect(refresh).not.toHaveClass(/refreshing/);
  });

  test('shows a hint when no usage windows are available', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'accountUsage', account: ACCOUNT, rateLimits: [] });

    const dialog = page.getByRole('dialog', { name: 'Account' });
    await expect(dialog).toContainText('Usage data is unavailable');
    await expect(page.locator('[class*="usageRow"]')).toHaveCount(0);
  });

  test('surfaces the fetch failure reason (e.g. HTTP 429) in the hint', async ({ page }) => {
    await openModal(page);
    await send(page, {
      type: 'accountUsage',
      account: ACCOUNT,
      rateLimits: [],
      usageError: 'rate limited (HTTP 429)',
    });

    const dialog = page.getByRole('dialog', { name: 'Account' });
    await expect(dialog).toContainText('Usage data is unavailable: rate limited (HTTP 429).');
    await expect(page.locator('[class*="usageRow"]')).toHaveCount(0);
  });

  test('shows "Not logged in" when the account is logged out', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'accountUsage', account: { loggedIn: false }, rateLimits: [] });

    const dialog = page.getByRole('dialog', { name: 'Account' });
    await expect(dialog).toContainText('Not logged in');
    await expect(dialog).not.toContainText('Auth method');
  });

  test('Escape closes the modal', async ({ page }) => {
    await openModal(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Account' })).toHaveCount(0);
  });

  test('footer link is present', async ({ page }) => {
    await openModal(page);
    await expect(page.getByRole('button', { name: 'Manage usage on claude.ai' })).toBeVisible();
  });
});
