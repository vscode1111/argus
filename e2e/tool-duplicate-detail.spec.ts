import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('tool details repeat only when they differ from the name', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const calls = [
      { id: 'scub-agent', name: 'subAgentActivity', detail: 'subAgentActivity' },
      { id: 'scub-search', name: 'webSearch', detail: 'webSearch' },
      { id: 'scub-distinct', name: 'webSearch', detail: 'scub-query' },
    ];
    for (const data of [
      { type: 'thinking_start' },
      ...calls.map(call => ({ type: 'tool_start', call: {
        id: call.id, name: call.name, kind: 'generic', input: { detail: call.detail },
      } })),
      { type: 'done' },
    ]) window.dispatchEvent(new MessageEvent('message', { data }));
  });

  const rows = page.locator('[class*="toolHeader"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator('[class*="toolSummary"]')).toHaveCount(0);
  await expect(rows.nth(1).locator('[class*="toolSummary"]')).toHaveCount(0);
  await expect(rows.nth(2).locator('[class*="toolSummary"]')).toHaveText('scub-query');
});
