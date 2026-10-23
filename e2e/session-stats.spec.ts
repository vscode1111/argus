import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('Session History shows stored request totals and each request', async ({ page }) => {
  await waitForApp(page);
  await page.getByRole('button', { name: 'Session history' }).click();
  const sessionId = '11111111-1111-1111-1111-111111111111';
  await page.evaluate(id => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'sessionList', sessions: [{ id, title: 'Planning session', lastPrompt: 'Plan the route', updatedAt: Date.now(), lines: 3 }],
  } })), sessionId);
  const history = page.getByRole('dialog', { name: 'Session History' });
  await history.getByRole('button', { name: 'Session statistics' }).click();
  const stats = page.getByRole('dialog', { name: 'Session statistics' });
  await page.evaluate(id => window.dispatchEvent(new MessageEvent('message', { data: { type: 'sessionStats', id, requests: [] } })), sessionId);
  await expect(stats).toContainText('No completed requests have been recorded');

  const startedAt = Date.now() - 20_000;
  await page.evaluate(({ id, started }) => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'sessionStats', id, requests: [
      { id: 'request-one', sessionId: id, workspacePath: 'D:/Projects/maps', providerId: 'provider-one', model: 'sample-model',
        startedAt: started, endedAt: started + 1300, durationMs: 1300, inputTokens: 250, outputTokens: 40, outcome: 'success' },
      { id: 'request-two', sessionId: id, workspacePath: 'D:/Projects/maps', providerId: 'provider-one', model: 'sample-model',
        startedAt: started + 5000, endedAt: started + 7100, durationMs: 2100, inputTokens: 100, outputTokens: 20, outcome: 'stopped' },
    ],
  } })), { id: sessionId, started: startedAt });
  await expect(stats).toContainText('2');
  await expect(stats).toContainText('350');
  await expect(stats).toContainText('60');
  await expect(stats.getByRole('row')).toHaveCount(3);
  await expect(stats.getByRole('row').nth(1)).toContainText('stopped');
  await expect(stats).toContainText('D:/Projects/maps');
  await page.evaluate(id => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'sessionStats', id, requests: [{ id: 'request-without-usage', sessionId: id, workspacePath: 'D:/Projects/maps',
      providerId: 'provider-one', model: 'sample-model', startedAt: Date.now(), endedAt: Date.now(), durationMs: 0,
      inputTokens: null, outputTokens: null, outcome: 'error' }],
  } })), sessionId);
  await expect(stats.getByText('Input tokens').locator('..')).toContainText('-');
  await expect(stats.getByText('Output tokens').locator('..')).toContainText('-');
  await page.setViewportSize({ width: 320, height: 600 });
  const box = await stats.boundingBox();
  if (!box) throw new Error('Statistics dialog is not visible');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(321);
});

test('Session History filters related sessions by issue key across workspaces', async ({ page }) => {
  await waitForApp(page);
  await page.getByRole('button', { name: 'Session history' }).click();
  const history = page.getByRole('dialog', { name: 'Session History' });
  await history.getByRole('tab', { name: 'All workspaces' }).click();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'allSessionList', sessions: [
      { id: 'session-work', title: 'Implement validation', taskKey: 'SCSOL-29', lastPrompt: '', workspacePath: 'D:/Projects/service', workspaceName: 'service', updatedAt: Date.now(), lines: 4 },
      { id: 'session-review', title: 'Review validation', taskKey: 'SCSOL-29', lastPrompt: '', workspacePath: 'D:/Projects/client', workspaceName: 'client', updatedAt: Date.now(), lines: 2 },
      { id: 'session-other', title: 'Investigate timeout', taskKey: null, lastPrompt: '', workspacePath: 'D:/Projects/client', workspaceName: 'client', updatedAt: Date.now(), lines: 3 },
    ],
  } })));
  await history.getByRole('textbox', { name: 'Search all sessions' }).fill('scsol-29');
  await expect(history.locator('[data-session-id]')).toHaveCount(2);
  await expect(history.locator('[data-session-id="session-work"]')).toBeVisible();
  await expect(history.locator('[data-session-id="session-review"]')).toBeVisible();
});
