import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function sendSkills(page: Page, skills: { name: string; scope: string; kind?: string; description?: string }[]) {
  return page.evaluate((s) => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'skills', skills: s } }));
  }, skills);
}

const SKILLS = [
  { name: 'clear', scope: 'builtin', description: 'Clear conversation history' },
  { name: 'compact', scope: 'builtin', description: 'Compact conversation to save context' },
  { name: 'help', scope: 'builtin', description: 'Show available commands' },
  { name: 'bump', scope: 'project', kind: 'command', description: 'Bump the version in package.json' },
  { name: 'e2e', scope: 'project', kind: 'command', description: 'Run Playwright e2e tests' },
  { name: 'dev', scope: 'project', kind: 'command', description: 'Control the dev environment' },
  { name: 'frontend', scope: 'project', kind: 'skill' },
  { name: 'vpn', scope: 'global', kind: 'command', description: 'Switch VPN mode on remote host' },
  { name: 'deploy', scope: 'global', kind: 'skill' },
];

test.describe('slash commands', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('typing "/" opens the slash menu', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/');

    const menu = page.locator('[class*="slashMenuHeader"]');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveText('Slash Commands');
  });

  test('skills message populates the menu with names and descriptions', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/');
    await sendSkills(page, SKILLS);

    const items = page.locator('[class*="slashMenuItem"]');
    await expect(items).toHaveCount(SKILLS.length);

    // First item should be "clear" with its description
    const first = items.nth(0);
    await expect(first.locator('[class*="slashMenuName"]')).toHaveText('/clear');
    await expect(first.locator('[class*="slashMenuDesc"]')).toHaveText('Clear conversation history');
  });

  test('builtin commands have no scope badge', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/cl');
    await sendSkills(page, SKILLS);

    const item = page.locator('[class*="slashMenuItem"]').first();
    await expect(item.locator('[class*="slashMenuName"]')).toHaveText('/clear');
    await expect(item.locator('[class*="slashMenuScope"]')).toHaveCount(0);
  });

  test('project commands show "project" scope badge', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/bump');
    await sendSkills(page, SKILLS);

    const item = page.locator('[class*="slashMenuItem"]').first();
    await expect(item.locator('[class*="slashMenuName"]')).toHaveText('/bump');
    await expect(item.locator('[class*="slashMenuScope"]')).toHaveText('project');
    await expect(item.locator('[class*="slashMenuDesc"]')).toHaveText('Bump the version in package.json');
  });

  test('global commands show "global" scope badge', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/vpn');
    await sendSkills(page, SKILLS);

    const item = page.locator('[class*="slashMenuItem"]').first();
    await expect(item.locator('[class*="slashMenuName"]')).toHaveText('/vpn');
    await expect(item.locator('[class*="slashMenuScope"]')).toHaveText('global');
  });

  test('commands without description show name only', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/deploy');
    await sendSkills(page, SKILLS);

    const item = page.locator('[class*="slashMenuItem"]').first();
    await expect(item.locator('[class*="slashMenuName"]')).toHaveText('/deploy');
    await expect(item.locator('[class*="slashMenuDesc"]')).toHaveCount(0);
    await expect(item.locator('[class*="slashMenuScope"]')).toHaveText('global');
  });

  test('filtering narrows the list by query', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/');
    await sendSkills(page, SKILLS);
    await expect(page.locator('[class*="slashMenuItem"]')).toHaveCount(SKILLS.length);

    await textarea.pressSequentially('de');
    const items = page.locator('[class*="slashMenuItem"]');
    await expect(items).toHaveCount(2); // dev, deploy
    const names = await items.locator('[class*="slashMenuName"]').allTextContents();
    expect(names).toEqual(['/dev', '/deploy']);
  });

  test('no match shows "No matching commands"', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/');
    await sendSkills(page, SKILLS);
    await textarea.pressSequentially('zzz');

    await expect(page.locator('[class*="slashMenuEmpty"]')).toHaveText('No matching commands');
  });

  test('Enter selects the highlighted command and inserts it', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/bu');
    await sendSkills(page, SKILLS);

    const item = page.locator('[class*="slashMenuItem"]').first();
    await expect(item.locator('[class*="slashMenuName"]')).toHaveText('/bump');

    await page.keyboard.press('Enter');

    // Menu should close
    await expect(page.locator('[class*="slashMenuHeader"]')).not.toBeVisible();
    // Textarea should have the command inserted
    await expect(textarea).toHaveValue('/bump ');
  });

  test('Tab selects the highlighted command', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/e2');
    await sendSkills(page, SKILLS);
    await page.keyboard.press('Tab');

    await expect(page.locator('[class*="slashMenuHeader"]')).not.toBeVisible();
    await expect(textarea).toHaveValue('/e2e ');
  });

  test('clicking a command selects it', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/');
    await sendSkills(page, SKILLS);

    await page.locator('[class*="slashMenuItem"]').filter({ hasText: '/dev' }).click();

    await expect(page.locator('[class*="slashMenuHeader"]')).not.toBeVisible();
    await expect(textarea).toHaveValue('/dev ');
  });

  test('ArrowDown/ArrowUp navigates the highlighted item', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/de');
    await sendSkills(page, SKILLS);

    const items = page.locator('[class*="slashMenuItem"]');
    await expect(items).toHaveCount(2);

    // First item is highlighted by default
    await expect(items.nth(0)).toHaveClass(/slashMenuItemActive/);
    await expect(items.nth(1)).not.toHaveClass(/slashMenuItemActive/);

    await page.keyboard.press('ArrowDown');
    await expect(items.nth(0)).not.toHaveClass(/slashMenuItemActive/);
    await expect(items.nth(1)).toHaveClass(/slashMenuItemActive/);

    await page.keyboard.press('ArrowUp');
    await expect(items.nth(0)).toHaveClass(/slashMenuItemActive/);
    await expect(items.nth(1)).not.toHaveClass(/slashMenuItemActive/);
  });

  test('Escape closes the menu without inserting', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/bu');
    await sendSkills(page, SKILLS);

    await expect(page.locator('[class*="slashMenuHeader"]')).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(page.locator('[class*="slashMenuHeader"]')).not.toBeVisible();
    await expect(textarea).toHaveValue('/bu');
  });

  test('long description is truncated to 100 characters', async ({ page }) => {
    const longDesc = 'A'.repeat(120);
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/long');
    await sendSkills(page, [{ name: 'longcmd', scope: 'project', description: longDesc }]);

    const desc = page.locator('[class*="slashMenuDesc"]');
    const text = await desc.textContent();
    expect(text).toBe('A'.repeat(100) + '...');
  });

  test('case-insensitive filtering', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/BUMP');
    await sendSkills(page, SKILLS);

    const items = page.locator('[class*="slashMenuItem"]');
    await expect(items).toHaveCount(1);
    await expect(items.first().locator('[class*="slashMenuName"]')).toHaveText('/bump');
  });
});
