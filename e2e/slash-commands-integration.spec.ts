import { test, expect } from './provider-fixtures';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureBuilt, ensureCompiled } from './daemonHelpers';
import type { ArgusServer } from '../src/backend';

test.describe('slash commands (integration)', () => {
  let workspace: string;
  let fixtureHome: string;
  let server: ArgusServer;
  const homeVariable = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const priorHome = process.env[homeVariable];
  const priorUsagePoll = process.env.ARGUS_USAGE_POLL;

  test.beforeAll(async () => {
    fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-slash-home-'));
    const commands = path.join(fixtureHome, '.claude', 'commands');
    const skill = path.join(fixtureHome, '.claude', 'skills', 'quality-check');
    fs.mkdirSync(commands, { recursive: true });
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(commands, 'release-guide.md'), '---\ndescription: Prepare release instructions\n---\n');
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: quality-check\ndescription: Check release quality\n---\n');
    // The private backend discovers global fixtures through its temporary home.
    process.env[homeVariable] = fixtureHome;
    process.env.ARGUS_USAGE_POLL = '0';
    ensureCompiled();
    ensureBuilt();
    const { startServer } = require('../out/backend') as typeof import('../src/backend');
    server = await startServer({ port: 0 });
  });

  test.afterAll(() => {
    server?.close();
    if (priorHome === undefined) delete process.env[homeVariable]; else process.env[homeVariable] = priorHome;
    if (priorUsagePoll === undefined) delete process.env.ARGUS_USAGE_POLL; else process.env.ARGUS_USAGE_POLL = priorUsagePoll;
    if (fixtureHome) fs.rmSync(fixtureHome, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-slash-'));
    const commands = path.join(workspace, '.claude', 'commands');
    const skill = path.join(workspace, '.claude', 'skills', 'frontend');
    fs.mkdirSync(commands, { recursive: true });
    fs.mkdirSync(skill, { recursive: true });
    for (const [name, description] of [
      ['bump', 'Bump the version in package.json'],
      ['dev', 'Control the dev environment'],
      ['e2e', 'Run Playwright e2e tests'],
    ]) {
      fs.writeFileSync(path.join(commands, `${name}.md`), `---\ndescription: ${description}\n---\n`);
    }
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\ndescription: Frontend development skill\n---\n');
    await page.goto(`http://localhost:${server.port}/?dir=` + encodeURIComponent(workspace), { waitUntil: 'domcontentloaded' });
    await expect(page.getByPlaceholder('Ask Argus')).toBeVisible();
  });

  test.afterEach(() => {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('typing "/" loads real skills from server', { tag: ["@claude"] }, async ({ page }) => {
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

  test('builtin commands are present with descriptions', { tag: ["@claude"] }, async ({ page }) => {
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

  test('project commands show description from frontmatter', { tag: ["@claude"] }, async ({ page }) => {
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

  test('project skill shows description and "project" badge', { tag: ["@claude"] }, async ({ page }) => {
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

  test('global command shows "global" badge', { tag: ["@claude"] }, async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/release-guide');

    const items = page.locator('[class*="slashMenuItem"]');
    await expect(async () => {
      const count = await items.count();
      expect(count).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 5_000 });

    const item = items.first();
    await expect(item.locator('[class*="slashMenuName"]')).toHaveText('/release-guide');
    await expect(item.locator('[class*="slashMenuScope"]')).toHaveText('global');
  });

  test('global skills show "global" badge', { tag: ["@claude"] }, async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/quality-check');

    const items = page.locator('[class*="slashMenuItem"]');
    await expect(async () => {
      const count = await items.count();
      expect(count).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 5_000 });

    const item = items.first();
    await expect(item.locator('[class*="slashMenuName"]')).toHaveText('/quality-check');
    await expect(item.locator('[class*="slashMenuScope"]')).toHaveText('global');
  });

  test('selecting a real command inserts it into textarea', { tag: ["@claude"] }, async ({ page }) => {
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

  test('command names are yellow, skill names are white', { tag: ["@claude"] }, async ({ page }) => {
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

  test('command stays yellow when highlighted via keyboard', { tag: ["@claude"] }, async ({ page }) => {
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

  test('all three project commands appear when filtering by "d"', { tag: ["@claude"] }, async ({ page }) => {
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
