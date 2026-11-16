import { test, expect } from '@playwright/test';
import { setup, sync, snapshot, requests } from './fixtures/agent-graph-ui';
test('company goals retain worker opening and pending-worker state on a narrow viewport', async ({ page }) => {
  await setup(page);
  const data = snapshot();
  Object.assign(data.scopes[0].data.workers, { pending: { title: 'Order worker', sessionId: null, workspace: 'D:/inventory', role: 'review' } });
  await sync(page, data); await page.setViewportSize({ width: 375, height: 700 });
  await page.getByRole('button', { name: 'Company goals' }).click();
  const dialog = page.getByRole('dialog', { name: 'Company goals' });
  await expect(dialog.getByRole('button', { name: /Stock worker/ })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: /Order worker/ })).toBeDisabled();
  await dialog.getByRole('button', { name: /Stock worker/ }).click();
  await expect.poll(async () => (await requests(page)).filter(m => m.type === 'resumeSession').at(-1)?.id).toBe('child');
  await expect(dialog).toBeHidden();
});
