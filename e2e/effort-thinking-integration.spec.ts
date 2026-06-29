import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { waitForApp } from './helpers';

// These tests mutate e2e/argus.json (effort and thinking fields) via the UI
// and verify config persistence, UI state, and the CLI spawn flags.
// They share the dev backend on :3001, so they run serially and restore config.
test.describe.configure({ mode: 'serial' });

const CONFIG_PATH = path.resolve(__dirname, 'argus.json');
const LOG_LIST = '[data-testid="log-list"]';

function readConfig(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}

function writeConfig(patch: Record<string, unknown>) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...readConfig(), ...patch }, null, 2) + '\n');
}

// Open the Account modal via the slash menu and switch to the Models tab.
// Returns the dialog locator.
async function openModelsTab(page: Page) {
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.focus();
  await textarea.pressSequentially('/usage');
  await page.locator('[class*="slashMenuItem"]', { hasText: 'Account & usage' }).click();
  const dialog = page.getByRole('dialog', { name: 'Account' });
  await expect(dialog).toBeVisible({ timeout: 8_000 });
  await dialog.getByRole('button', { name: 'Models' }).click();
  // getByText matches multiple elements (the span + parent divs); use the
  // optionsSection class locator to avoid a Playwright 1.46+ multi-element error.
  await expect(dialog.locator('[class*="optionsSection"]')).toBeVisible({ timeout: 5_000 });
  return dialog;
}

// Open the slash menu and wait for the Model section to appear.
async function openSlashMenu(page: Page) {
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.focus();
  await textarea.pressSequentially('/');
  await expect(page.locator('[class*="slashMenuHeader"]', { hasText: 'Model' })).toBeVisible({ timeout: 5_000 });
}

async function closeSlashMenu(page: Page) {
  await page.keyboard.press('Escape');
}

// Reload the page and wait for the app to mount (backend reconnects and sends workspaceInfo).
async function reloadAndWait(page: Page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByPlaceholder('Ask Argus')).toBeVisible({ timeout: 15_000 });
}

// Send a message and wait for streaming to finish.
async function sendAndWait(page: Page, text: string) {
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  const stopBtn = page.getByRole('button', { name: 'Stop' });
  await expect(stopBtn).toBeVisible({ timeout: 15_000 });
  await expect(stopBtn).toHaveCount(0, { timeout: 60_000 });
}

test.describe('effort and thinking (integration)', () => {
  let original: string;

  test.beforeEach(async ({ page }) => {
    original = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf-8') : '{}';
    await waitForApp(page);
  });

  test.afterEach(() => {
    fs.writeFileSync(CONFIG_PATH, original);
  });

  // ── presence ────────────────────────────────────────────────────────────────

  test('Models tab shows Effort and Thinking controls', async ({ page }) => {
    const dialog = await openModelsTab(page);

    // Effort label and 4 dots (low / medium / high / max).
    // Use class-based locators: getByText matches parent divs too (multi-element error in Playwright 1.46+).
    await expect(dialog.locator('[class*="optionLabel"]').first()).toBeVisible();
    // Use span[class*] to exclude the effortDots container div whose CSS-module
    // class name "effortDots_HASH" also contains "effortDot" as a substring.
    const dots = dialog.locator('span[class*="effortDot"]');
    await expect(dots).toHaveCount(4);

    // Thinking toggle track
    await expect(dialog.locator('[class*="optionLabel"]').nth(1)).toBeVisible();
    await expect(dialog.locator('[class*="toggleTrack"]')).toBeVisible();
  });

  test('slash menu shows Effort dots and Thinking toggle', async ({ page }) => {
    await openSlashMenu(page);

    // Effort row with dots (use class locator to avoid multi-element match on parent divs)
    await expect(page.locator('[class*="slashMenuName"]', { hasText: /Effort \(/ })).toBeVisible();
    // span[class*] excludes the slashMenuDots container whose CSS-module name also contains "slashMenuDot"
    await expect(page.locator('span[class*="slashMenuDot"]')).toHaveCount(4);

    // Thinking toggle
    await expect(page.locator('[class*="slashMenuName"]', { hasText: 'Thinking' })).toBeVisible();
    await expect(page.locator('[class*="slashMenuToggleTrack"]')).toBeVisible();

    await closeSlashMenu(page);
  });

  // ── effort changes ───────────────────────────────────────────────────────────

  test('clicking effort dot in modal updates label and persists to config', async ({ page }) => {
    const dialog = await openModelsTab(page);

    // Click the first dot (Low) - use span prefix to exclude the effortDots container div
    await dialog.locator('span[class*="effortDot"]').first().click();

    // Label updates (use class locator to avoid multi-element match on parent divs)
    await expect(dialog.locator('[class*="optionLabel"]', { hasText: /Effort \(Low\)/i })).toBeVisible({ timeout: 8_000 });

    // Config persisted
    await expect.poll(() => readConfig().effort, { timeout: 8_000 }).toBe('low');
  });

  test('clicking effort dot in slash menu persists to config', async ({ page }) => {
    await openSlashMenu(page);

    // Click the last dot (Max)
    await page.locator('[class*="slashMenuDot"]').last().click();

    await expect.poll(() => readConfig().effort, { timeout: 8_000 }).toBe('max');

    await closeSlashMenu(page);
  });

  // ── thinking toggle ──────────────────────────────────────────────────────────

  test('clicking thinking toggle in modal flips its state and persists to config', async ({ page }) => {
    const dialog = await openModelsTab(page);

    const track = dialog.locator('[class*="toggleTrack"]');
    const initialOn = await track.evaluate((el: Element) => el.className.includes('TrackOn'));

    await track.click();

    // Visual state flipped
    await expect.poll(
      async () => {
        const cls = await track.evaluate((el: Element) => el.className);
        return cls.includes('TrackOn');
      },
      { timeout: 8_000 },
    ).toBe(!initialOn);

    // Config persisted
    await expect.poll(() => readConfig().thinking, { timeout: 8_000 }).toBe(!initialOn);
  });

  test('clicking thinking toggle in slash menu persists to config', async ({ page }) => {
    await openSlashMenu(page);

    const track = page.locator('[class*="slashMenuToggleTrack"]');
    const initialOn = await track.evaluate((el: Element) => el.className.includes('TrackOn'));

    await track.click();

    await expect.poll(() => readConfig().thinking, { timeout: 8_000 }).toBe(!initialOn);

    await closeSlashMenu(page);
  });

  // ── persistence across reconnect ─────────────────────────────────────────────

  test('effort and thinking are restored from config on reconnect', async ({ page }) => {
    writeConfig({ effort: 'low', thinking: false });

    await reloadAndWait(page);

    // Slash menu reflects the stored values after the new connection's workspaceInfo
    await openSlashMenu(page);

    await expect(page.locator('[class*="slashMenuName"]', { hasText: /Effort \(Low\)/i })).toBeVisible({ timeout: 8_000 });

    const track = page.locator('[class*="slashMenuToggleTrack"]');
    await expect(track).toBeVisible();
    const isOn = await track.evaluate((el: Element) => el.className.includes('TrackOn'));
    expect(isOn).toBe(false);

    await closeSlashMenu(page);
  });

  test('modal shows restored effort after reconnect', async ({ page }) => {
    writeConfig({ effort: 'medium', thinking: true });

    await reloadAndWait(page);

    const dialog = await openModelsTab(page);
    await expect(dialog.locator('[class*="optionLabel"]', { hasText: /Effort \(Medium\)/i })).toBeVisible({ timeout: 8_000 });

    // Active dot: the "medium" dot (index 1) should have the active class
    // span prefix excludes the effortDots container div whose CSS-module class also contains "effortDot"
    const dots = dialog.locator('span[class*="effortDot"]');
    const mediumDot = dots.nth(1);
    const cls = await mediumDot.evaluate((el: Element) => el.className);
    expect(cls).toContain('Active');
  });

  // ── CLI flag ─────────────────────────────────────────────────────────────────

  test('thinking=false forces --effort low in the CLI spawn log', async ({ page }) => {
    // Pre-configure: effort=high, thinking=false → CLI should receive --effort low
    writeConfig({ effort: 'high', thinking: false });

    await reloadAndWait(page);

    const logList = page.locator(LOG_LIST);
    await expect(logList).toBeVisible({ timeout: 5_000 });

    await sendAndWait(page, 'Reply with just "ok".');

    // The spawn log line is emitted at info level with the full args string (no truncation).
    await expect.poll(
      async () => { const t = await logList.innerText(); return t; },
      { timeout: 20_000 },
    ).toContain('--effort low');
  });

  test('selected effort level is forwarded to the CLI spawn log', async ({ page }) => {
    // Set thinking=true, effort=medium so the effort flag is passed as-is
    writeConfig({ effort: 'medium', thinking: true });

    await reloadAndWait(page);

    const logList = page.locator(LOG_LIST);
    await expect(logList).toBeVisible({ timeout: 5_000 });

    await sendAndWait(page, 'Reply with just "ok".');

    await expect.poll(
      async () => { const t = await logList.innerText(); return t; },
      { timeout: 20_000 },
    ).toContain('--effort medium');
  });

  // ── model selection ──────────────────────────────────────────────────────────

  test('clicking a model row in the modal persists to config', async ({ page }) => {
    const dialog = await openModelsTab(page);
    // Wait for model rows (API fetch resolves; falls back only when the API returns no error)
    await expect(dialog.locator('[class*="modelRow"]').first()).toBeVisible({ timeout: 10_000 });

    // Skip the first row ("Default (CLI)") and click the first real model
    const rows = dialog.locator('[class*="modelRow"]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(1);
    await rows.nth(1).click();

    await expect.poll(() => readConfig().model, { timeout: 8_000 }).not.toBe('');
  });

  test('selecting Default (CLI) in the modal clears the stored model', async ({ page }) => {
    writeConfig({ model: 'claude-haiku-4-5' });
    await reloadAndWait(page);

    const dialog = await openModelsTab(page);
    await expect(dialog.locator('[class*="modelRow"]').first()).toBeVisible({ timeout: 10_000 });
    await dialog.locator('[class*="modelRow"]').filter({ hasText: 'Default (CLI)' }).click();

    await expect.poll(() => readConfig().model, { timeout: 8_000 }).toBe('');
  });

  test('selecting a model in the slash menu persists to config', async ({ page }) => {
    await openSlashMenu(page);

    // Expand the model picker
    await page.locator('[class*="slashMenuItem"]').filter({ hasText: 'Switch model...' }).click();

    // Wait for model list to load (falls back to FALLBACK_MODELS when API returns no error)
    await expect(page.locator('[class*="slashMenuModelInfo"]').first()).toBeVisible({ timeout: 10_000 });

    // Click the first real model (index 1 is the first after Default (CLI))
    await page.locator('[class*="slashMenuModelInfo"]').nth(1).click();

    await expect.poll(() => readConfig().model, { timeout: 8_000 }).not.toBe('');
  });

  test('model persists across reconnect - slash menu hint shows model name', async ({ page }) => {
    writeConfig({ model: 'claude-haiku-4-5' });
    await reloadAndWait(page);

    await openSlashMenu(page);
    // The hint next to "Switch model..." shows the display name without "Claude " prefix
    await expect(page.locator('[class*="slashMenuHint"]')).toHaveText(/Haiku 4\.5/i, { timeout: 8_000 });
    await closeSlashMenu(page);
  });

  test('model search in the modal filters the list', async ({ page }) => {
    const dialog = await openModelsTab(page);
    await expect(dialog.locator('[class*="modelRow"]').first()).toBeVisible({ timeout: 10_000 });

    await dialog.getByPlaceholder('Search models...').fill('haiku');

    await expect(dialog.locator('[class*="modelRow"]').filter({ hasText: /haiku/i })).toBeVisible();
    await expect(dialog.locator('[class*="modelRow"]').filter({ hasText: /sonnet/i })).toHaveCount(0);
  });

  test('selected model is forwarded to the CLI spawn log', async ({ page }) => {
    writeConfig({ model: 'claude-sonnet-4-6', effort: 'high', thinking: true });
    await reloadAndWait(page);

    const logList = page.locator(LOG_LIST);
    await expect(logList).toBeVisible({ timeout: 5_000 });

    await sendAndWait(page, 'Reply with just "ok".');

    await expect.poll(
      async () => { const t = await logList.innerText(); return t; },
      { timeout: 20_000 },
    ).toContain('--model claude-sonnet-4-6');
  });
});
