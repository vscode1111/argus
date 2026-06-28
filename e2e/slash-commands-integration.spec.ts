import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('slash commands (integration)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('typing "/" loads real skills from server', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/');

    // Two headers exist ("Slash Commands" + "Model"); use .first() so toBeVisible
    // doesn't throw on the multi-element locator.
    const header = page.locator('[class*="slashMenuHeader"]').first();
    await expect(header).toBeVisible();

    // Wait for real skills to load (not "Loading...")
    const items = page.locator('[class*="slashMenuItem"]');
    await expect(async () => {
      const count = await items.count();
      expect(count).toBeGreaterThanOrEqual(10);
    }).toPass({ timeout: 5_000 });
  });

  test('builtin commands are present with descriptions', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/clear');

    const items = page.locator('[class*="slashMenuItem"]');
    await expect(items).toHaveCount(1);

    const item = items.first();
    await expect(item.locator('[class*="slashMenuName"]')).toHaveText('/clear');
    await expect(item.locator('[class*="slashMenuDesc"]')).toHaveText('Clear conversation history');
    // Builtin commands have no scope badge
    await expect(item.locator('[class*="slashMenuScope"]')).toHaveCount(0);
  });

  test('project commands show description from frontmatter', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/bump');

    const items = page.locator('[class*="slashMenuItem"]');
    await expect(items).toHaveCount(1);

    const item = items.first();
    await expect(item.locator('[class*="slashMenuName"]')).toHaveText('/bump');
    await expect(item.locator('[class*="slashMenuDesc"]')).toContainText('Bump the version in package.json');
    await expect(item.locator('[class*="slashMenuScope"]')).toHaveText('project');
  });

  test('project skill shows description and "project" badge', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/frontend');

    const items = page.locator('[class*="slashMenuItem"]');
    await expect(items).toHaveCount(1);

    const item = items.first();
    await expect(item.locator('[class*="slashMenuName"]')).toHaveText('/frontend');
    await expect(item.locator('[class*="slashMenuDesc"]')).toContainText('Frontend development skill');
    await expect(item.locator('[class*="slashMenuScope"]')).toHaveText('project');
  });

  test('global command shows "global" badge', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/company');

    const items = page.locator('[class*="slashMenuItem"]');
    await expect(async () => {
      const count = await items.count();
      expect(count).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 5_000 });

    const item = items.first();
    await expect(item.locator('[class*="slashMenuName"]')).toHaveText('/company');
    await expect(item.locator('[class*="slashMenuScope"]')).toHaveText('global');
  });

  test('global skills show "global" badge', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/git-commit');

    const items = page.locator('[class*="slashMenuItem"]');
    await expect(async () => {
      const count = await items.count();
      expect(count).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 5_000 });

    const item = items.first();
    await expect(item.locator('[class*="slashMenuName"]')).toHaveText('/git-commit');
    await expect(item.locator('[class*="slashMenuScope"]')).toHaveText('global');
  });

  test('selecting a real command inserts it into textarea', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/e2');

    const items = page.locator('[class*="slashMenuItem"]');
    await expect(async () => {
      const count = await items.count();
      expect(count).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 5_000 });

    await page.keyboard.press('Enter');
    await expect(page.locator('[class*="slashMenuHeader"]')).not.toBeVisible();
    await expect(textarea).toHaveValue('/e2e ');
  });

  test('command names are yellow, skill names are white', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/');

    const items = page.locator('[class*="slashMenuItem"]');
    await expect(async () => {
      const count = await items.count();
      expect(count).toBeGreaterThanOrEqual(10);
    }).toPass({ timeout: 5_000 });

    // /bump is a command - should have the custom (yellow) class
    const bumpName = items.filter({ hasText: '/bump' }).locator('[class*="slashMenuName"]');
    await expect(bumpName).toHaveClass(/slashMenuNameCustom/);

    // /frontend is a skill - should NOT have the custom class
    const frontendName = items.filter({ hasText: '/frontend' }).locator('[class*="slashMenuName"]');
    await expect(frontendName).not.toHaveClass(/slashMenuNameCustom/);
  });

  test('command stays yellow when highlighted via keyboard', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/bu');

    const items = page.locator('[class*="slashMenuItem"]');
    await expect(async () => {
      const count = await items.count();
      expect(count).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 5_000 });

    // /bump is highlighted (first match) - should still have yellow class
    const name = items.first().locator('[class*="slashMenuName"]');
    await expect(name).toHaveText('/bump');
    await expect(name).toHaveClass(/slashMenuNameCustom/);
    await expect(items.first()).toHaveClass(/slashMenuItemActive/);
  });

  test('all three project commands appear when filtering by "d"', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/');

    // Wait for skills to load
    const items = page.locator('[class*="slashMenuItem"]');
    await expect(async () => {
      const count = await items.count();
      expect(count).toBeGreaterThanOrEqual(10);
    }).toPass({ timeout: 5_000 });

    // Filter to show items containing "de" - should include "dev" and "deploy" (global skill) or similar
    await textarea.pressSequentially('de');
    const names = await items.locator('[class*="slashMenuName"]').allTextContents();
    expect(names).toContain('/dev');
  });
});
