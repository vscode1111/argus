import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('company goals show named workers and open their conversations', async ({ page }) => {
  await waitForApp(page);
  await page.getByRole('button', { name: 'Company goals' }).click();
  const dialog = page.getByRole('dialog', { name: 'Company goals' });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'orchestratorGoals', goals: [{ company: 'scub-company', goal: 'scub-goal', title: 'scub-goal-title', status: 'active', workers: [
      { key: 'scub-issue-1', title: 'scub-issue-1 · Review', status: 'done', sessionId: 'scub-session-1', workspace: 'D:/scub-workspace' },
      { key: 'scub-issue-2', title: 'scub-issue-2 · Repair', status: 'starting', workspace: 'D:/scub-workspace' },
    ] }],
  } })));
  await expect(dialog.getByText('scub-goal-title')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /scub-issue-1/ })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: /scub-issue-2/ })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.setViewportSize({ width: 375, height: 700 });
  await page.getByRole('button', { name: 'Company goals' }).click();
  await expect(page.getByRole('dialog', { name: 'Company goals' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'orchestratorGoals', goals: [{ company: 'scub-company', goal: 'scub-goal', title: 'scub-goal-title', status: 'active', workers: [
      { key: 'scub-issue-1', title: 'scub-issue-1 · Review', status: 'done', sessionId: 'scub-session-1', workspace: 'D:/scub-workspace' },
    ] }],
  } })));
  await dialog.getByRole('button', { name: /scub-issue-1/ }).click();
  await expect(dialog).toHaveCount(0);
});
