import { test, expect } from './provider-fixtures';
import { waitForApp } from './helpers';

test('workspace, usage and model tiles open their matching views in order', { tag: ['@codex'] }, async ({ page }) => {
  await waitForApp(page);
  const model = page.getByRole('button', { name: 'Choose provider and model' });
  const workspace = page.getByRole('button', { name: 'Switch workspace' });
  await expect(model).toBeVisible();
  await expect(workspace).toBeVisible();
  expect(await page.locator('.topRightActions button').evaluateAll(buttons => {
    const labels = buttons.map(button => button.getAttribute('aria-label'));
    const workspaceIndex = labels.indexOf('Switch workspace');
    const usageIndex = buttons.findIndex(button => button.hasAttribute('data-testid') && button.getAttribute('data-testid') === 'usage-indicator');
    const modelIndex = labels.indexOf('Choose provider and model');
    return workspaceIndex >= 0 && workspaceIndex < usageIndex && usageIndex < modelIndex;
  })).toBe(true);

  await workspace.click();
  await expect(page.getByRole('dialog', { name: 'Workspace History' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Workspace History' }).getByRole('button', { name: 'Close' }).click();

  await page.getByTestId('usage-indicator').click();
  const account = page.getByRole('dialog', { name: 'Account' });
  await expect(account.getByRole('button', { name: 'Account & Usage' })).toHaveClass(/tabActive/);
  await account.getByRole('button', { name: 'Models', exact: true }).click();
  await account.getByRole('button', { name: 'Close' }).click();

  await page.getByTestId('usage-indicator').click();
  await expect(account.getByRole('button', { name: 'Account & Usage' })).toHaveClass(/tabActive/);
  await account.getByRole('button', { name: 'Close' }).click();

  await model.click();
  await expect(account.getByRole('button', { name: 'Models', exact: true })).toHaveClass(/tabActive/);
});
