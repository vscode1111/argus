import { test, expect } from './provider-fixtures';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('provider switch, real reply and reload preserve the conversation', { tag: ["@claude"] }, async ({ page, context }) => {
  test.setTimeout(120_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-provider-ui-'));
  try {
    await page.goto('/?dir=' + encodeURIComponent(dir));
    const input = page.getByPlaceholder('Ask Argus');
    await expect(input).toBeVisible();
    await input.fill('scub-draft');
    await page.getByRole('button', { name: 'Choose provider and model' }).click();
    const picker = page.getByRole('button', { name: 'Provider', exact: true });
    await picker.click();
    const options = page.getByRole('listbox', { name: 'Providers' }).getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(options.locator('[data-provider-icon]')).toHaveCount(2);
    const alternative = page.getByRole('listbox', { name: 'Providers' }).getByRole('option', { selected: false });
    const alternativeLabel = await alternative.textContent();
    await alternative.click();
    await expect(picker).toContainText(alternativeLabel!);
    await expect(input).toHaveValue('scub-draft');
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    await expect(page.locator('[class*="modelRow"]')).not.toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText('Thinking', { exact: true })).toHaveCount(0);
    const other = await context.newPage();
    await other.goto('/?dir=' + encodeURIComponent(dir));
    await other.getByRole('button', { name: 'Choose provider and model' }).click();
    await expect(other.getByRole('button', { name: 'Provider', exact: true })).toContainText(alternativeLabel!);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await input.fill('Reply only scub-ready. Do not use tools.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 70_000 });
    await expect(page.getByText('scub-ready', { exact: true }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText('scub-ready', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Choose provider and model' }).click();
    await expect(page.getByRole('button', { name: 'Provider', exact: true })).toContainText(alternativeLabel!);
    await other.close();
    const id = new URL(page.url()).searchParams.get('session');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await input.fill('/clear');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('scub-ready', { exact: true })).toHaveCount(0);
    if (id) await require('../out/backend/providers/codex').codexProvider.remove(id, dir);
  } finally {
    // Only this test's freshly created workspace, never the project or a user folder.
    await page.close();
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
