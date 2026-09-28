import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('provider selection filters models and parameters and preserves the draft', async ({ page }) => {
  await waitForApp(page);
  await page.getByPlaceholder('Ask Argus').fill('scub-draft');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true } })));
  const modelButton = page.locator('.topRightActions').getByRole('button', { name: 'Choose provider and model' });
  await expect(modelButton).toBeVisible();
  await expect(modelButton).toHaveText('scub-model');
  await expect(page.getByRole('button', { name: 'Choose provider and model' })).toHaveCount(1);
  await modelButton.click();
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'modelList', providerId: 'codex', runtimeDefaultModel: 'scub-model', models: [{ id: 'scub-model', displayName: 'scub-model', efforts: ['low', 'high'] }] } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'modelList', providerId: 'claude', models: [{ id: 'scub-stale', displayName: 'scub-stale' }] } }));
  });
  await expect(page.getByText('scub-model', { exact: true })).toBeVisible();
  await expect(page.getByText('scub-stale', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Thinking', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Effort low' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Effort max' })).toHaveCount(0);
  await expect(page.getByPlaceholder('Ask Argus')).toHaveValue('scub-draft');
  const permissions = page.getByRole('button', { name: 'Codex permissions' });
  await expect(permissions).toHaveText('Ask');
  await permissions.click();
  const permissionMenu = page.getByRole('listbox', { name: 'Codex permissions' });
  await expect(permissionMenu).toBeVisible();
  await expect(permissionMenu.getByText('Edit workspace files; ask before actions needing broader access.')).toBeVisible();
  await expect(permissionMenu.getByText('Read files and propose changes without editing them.')).toBeVisible();
  await expect(permissionMenu.getByText('Edit files and run commands without approval prompts.')).toBeVisible();
  await permissionMenu.getByRole('option', { name: /Full/ }).click();
  await expect(permissions).toHaveText('Full');
  await expect(permissionMenu).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'providerSelection', providerId: 'claude', model: 'scub-model', effort: '', thinking: true } })));
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true } })));
  await expect(permissions).toHaveText('Ask');
});
