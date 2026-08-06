import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Mock coverage for the "What's contributing to your limits usage?" section of
// the Account & Usage modal: behavior insights (official copy, <10% hidden),
// Day/Week toggle, attribution tables (top-8 cap, /skill prefix), empty and
// error states. `getUsageInsights` is in MOCK_SUPPRESSED, so the injected
// `usageInsights` message is the only reply the modal ever sees.

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

const ACCOUNT = {
  loggedIn: true,
  authMethod: 'claude.ai',
  email: 'scub@example.com',
  subscriptionType: 'max',
};

const EMPTY_REPORT = {
  totalCost: 0,
  requestCount: 0,
  sessionCount: 0,
  behaviors: [],
  skills: [],
  agents: [],
  plugins: [],
  mcpServers: [],
};

const DAY_REPORT = {
  totalCost: 1000,
  requestCount: 100,
  sessionCount: 5,
  behaviors: [
    { key: 'long_context', pct: 70, count: 40 },
    { key: 'cron', pct: 47, count: 2 },
    { key: 'high_parallel', pct: 5, count: 9 }, // below the 10% floor - hidden
    { key: 'cache_miss', pct: 0, count: 0 },
    { key: 'subagent_heavy', pct: 0, count: 0 },
  ],
  skills: [
    { name: 'update-notes', pct: 9 },
    { name: 'review', pct: 5 },
  ],
  agents: [],
  plugins: [],
  mcpServers: [
    { name: 'windows-mcp', pct: 6 },
    { name: 'chrome-devtools', pct: 4 },
  ],
};

const WEEK_REPORT = {
  ...DAY_REPORT,
  behaviors: [
    { key: 'long_context', pct: 61, count: 400 },
    { key: 'high_parallel', pct: 24, count: 200 },
    { key: 'cron', pct: 18, count: 4 },
    { key: 'cache_miss', pct: 0, count: 0 },
    { key: 'subagent_heavy', pct: 0, count: 0 },
  ],
  skills: [{ name: 'chat', pct: 1 }],
};

// Open the modal via the slash menu, then wait for the account phase to settle
// so later mock dispatches are the final writes.
async function openModal(page: Page) {
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.focus();
  await textarea.pressSequentially('/usage');
  const action = page.locator('[class*="slashMenuItem"]', { hasText: 'Account & usage' });
  await expect(action).toBeVisible();
  await action.click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 15_000 });
  await send(page, { type: 'accountUsage', account: ACCOUNT, rateLimits: [] });
}

test.describe('usage insights', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('renders header, disclaimers, and behaviors at or above the 10% floor with official copy', async ({ page }) => {
    await openModal(page);
    const dialog = page.getByRole('dialog', { name: 'Account' });
    await expect(dialog).toContainText("What's contributing to your limits usage?");
    // Suppressed in mock mode, so the loading hint stays until the mock reply -
    // and while loading, the toggle/disclaimers scaffolding must not render.
    await expect(dialog).toContainText('Analyzing local sessions...');
    await expect(dialog.getByRole('tab', { name: 'Day' })).toHaveCount(0);
    await expect(dialog).not.toContainText('Approximate, based on local sessions');

    await send(page, { type: 'usageInsights', day: DAY_REPORT, week: WEEK_REPORT });

    await expect(dialog).toContainText('Approximate, based on local sessions on this machine');
    await expect(dialog).toContainText('Last 24h · these are independent characteristics of your usage, not a breakdown');
    await expect(dialog).toContainText('70% of your usage was at >150k context');
    await expect(dialog).toContainText('Longer sessions are more expensive even when cached. /compact mid-task, /clear when switching to new tasks.');
    await expect(dialog).toContainText('47% of your usage came from sessions active for 8+ hours');
    // 5% high_parallel is below the floor and must not render.
    await expect(dialog).not.toContainText('ran in parallel');
    await expect(dialog).not.toContainText('Analyzing local sessions...');
  });

  test('Day/Week toggle switches the report and the range note', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'usageInsights', day: DAY_REPORT, week: WEEK_REPORT });

    const dialog = page.getByRole('dialog', { name: 'Account' });
    const dayTab = dialog.getByRole('tab', { name: 'Day' });
    const weekTab = dialog.getByRole('tab', { name: 'Week' });
    await expect(dayTab).toHaveAttribute('aria-selected', 'true');
    await expect(dialog).toContainText('70% of your usage was at >150k context');

    await weekTab.click();
    await expect(weekTab).toHaveAttribute('aria-selected', 'true');
    await expect(dayTab).toHaveAttribute('aria-selected', 'false');
    await expect(dialog).toContainText('Last 7d · these are independent characteristics');
    await expect(dialog).toContainText('61% of your usage was at >150k context');
    await expect(dialog).toContainText('24% of your usage was while 4+ sessions ran in parallel');
    await expect(dialog).toContainText('/chat');

    await dayTab.click();
    await expect(dialog).toContainText('Last 24h · these are independent characteristics');
    await expect(dialog).toContainText('70% of your usage was at >150k context');
  });

  test('attribution tables render skills with a / prefix and MCP servers plain', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'usageInsights', day: DAY_REPORT, week: WEEK_REPORT });

    const dialog = page.getByRole('dialog', { name: 'Account' });
    const tables = dialog.locator('[class*="insightTable_"]');
    // Only non-empty tables render: Skills and MCP servers.
    await expect(tables).toHaveCount(2);
    await expect(tables.nth(0)).toContainText('Skills');
    await expect(tables.nth(0)).toContainText('% of usage');
    await expect(tables.nth(0)).toContainText('/update-notes');
    await expect(tables.nth(0)).toContainText('9%');
    await expect(tables.nth(1)).toContainText('MCP servers');
    await expect(tables.nth(1)).toContainText('windows-mcp');
    await expect(dialog).not.toContainText('Subagents');
    await expect(dialog).not.toContainText('Plugins');
  });

  test('tables cap at 8 rows with an overflow line', async ({ page }) => {
    await openModal(page);
    const manySkills = Array.from({ length: 11 }, (_, i) => ({ name: `scub-skill-${i + 1}`, pct: 11 - i }));
    await send(page, {
      type: 'usageInsights',
      day: { ...DAY_REPORT, skills: manySkills },
      week: WEEK_REPORT,
    });

    const dialog = page.getByRole('dialog', { name: 'Account' });
    await expect(dialog).toContainText('/scub-skill-8');
    await expect(dialog).not.toContainText('/scub-skill-9');
    await expect(dialog).toContainText('… 3 more');
  });

  test('shows the no-attribution empty state when all tables are empty', async ({ page }) => {
    await openModal(page);
    await send(page, {
      type: 'usageInsights',
      day: { ...DAY_REPORT, skills: [], mcpServers: [] },
      week: WEEK_REPORT,
    });

    const dialog = page.getByRole('dialog', { name: 'Account' });
    await expect(dialog).toContainText('Skills, subagents, plugins, and MCP servers');
    await expect(dialog).toContainText('No attribution data yet · accumulates as you use Claude');
    // Behaviors still render above the empty state.
    await expect(dialog).toContainText('70% of your usage was at >150k context');
  });

  test('surfaces a collection error in the hint', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'usageInsights', error: 'boom' });

    const dialog = page.getByRole('dialog', { name: 'Account' });
    await expect(dialog).toContainText('Usage insights are unavailable: boom.');
    await expect(dialog).not.toContainText('Analyzing local sessions...');
    // No data - the header + hint stand alone, no toggle/disclaimer scaffolding.
    await expect(dialog.getByRole('tab', { name: 'Day' })).toHaveCount(0);
    await expect(dialog).not.toContainText('Approximate, based on local sessions');
  });

  test('empty reports render disclaimers plus the empty attribution state', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'usageInsights', day: EMPTY_REPORT, week: EMPTY_REPORT });

    const dialog = page.getByRole('dialog', { name: 'Account' });
    await expect(dialog).toContainText('Approximate, based on local sessions');
    await expect(dialog).toContainText('No attribution data yet');
    await expect(dialog).not.toContainText('% of your usage was');
  });
});
