import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Integration: the "What's contributing to your limits usage?" section against
// the real backend, which scans this machine's ~/.claude/projects transcripts.
// The data depends on the machine's history, so assertions are structural: the
// real reply must land, both range tabs must work, and whatever renders must be
// well-formed (behavior lines at or above the 10% floor, tables or the explicit
// no-attribution state).

async function openModal(page: Page) {
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.focus();
  await textarea.pressSequentially('/usage');
  const action = page.locator('[class*="slashMenuItem"]', { hasText: 'Account & usage' });
  await expect(action).toBeVisible();
  await action.click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
}

test.describe('usage insights (integration)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('real transcript scan renders the section with well-formed data', async ({ page }) => {
    await openModal(page);
    await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });

    const dialog = page.getByRole('dialog', { name: 'Account' });
    await expect(dialog).toContainText("What's contributing to your limits usage?");

    // The real reply replaces the loading hint (transcript scan takes seconds).
    await expect(dialog.getByText('Analyzing local sessions...')).toHaveCount(0, { timeout: 20_000 });
    await expect(dialog).not.toContainText('Usage insights are unavailable');
    await expect(dialog).toContainText('Approximate, based on local sessions on this machine');
    await expect(dialog).toContainText('Last 24h · these are independent characteristics');

    // Behavior lines are data-dependent; each rendered one must carry a percent
    // between the 10% display floor and 100. (The headline class is shared with
    // the no-attribution title, hence the content guard.)
    const headlines = dialog.locator('[class*="behaviorHeadline"]');
    const count = await headlines.count();
    for (let i = 0; i < count; i++) {
      const text = await headlines.nth(i).innerText();
      if (!text.includes('% of your usage')) continue;
      const pct = Number(text.match(/^(\d+)%/)?.[1]);
      expect(pct, text).toBeGreaterThanOrEqual(10);
      expect(pct, text).toBeLessThanOrEqual(100);
    }

    // Attribution: either at least one table with valid rows, or the empty state.
    const tables = dialog.locator('[class*="insightTable_"]');
    if (await tables.count() === 0) {
      await expect(dialog).toContainText('No attribution data yet');
    } else {
      await expect(tables.first()).toContainText('% of usage');
      const firstPct = await tables.first().locator('[class*="insightTablePct"]').nth(1).innerText();
      expect(firstPct).toMatch(/^\d+%$/);
    }
  });

  test('Week tab switches the range note against real data', async ({ page }) => {
    await openModal(page);
    await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });

    const dialog = page.getByRole('dialog', { name: 'Account' });
    await expect(dialog.getByText('Analyzing local sessions...')).toHaveCount(0, { timeout: 20_000 });

    await dialog.getByRole('tab', { name: 'Week' }).click();
    await expect(dialog).toContainText('Last 7d · these are independent characteristics');
    await expect(dialog).not.toContainText('Usage insights are unavailable');

    await dialog.getByRole('tab', { name: 'Day' }).click();
    await expect(dialog).toContainText('Last 24h · these are independent characteristics');
  });
});
