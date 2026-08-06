import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Model picker (Account modal "Models" tab + InputArea quick picker): family-based
// description fallback, server-resolved descriptions, and the active-row highlight
// matching a dated snapshot id against its dateless alias in either direction.

const OPUS_DESC = 'Best for everyday, complex tasks';
const HAIKU_DESC = 'Fastest for quick answers';
const TOP_TIER_DESC = 'Most capable for your hardest and longest-running tasks';

function sendModelList(
  page: Page,
  models: Array<{ id: string; displayName: string; description?: string }>,
  runtimeDefaultModel = '',
) {
  return page.evaluate((data) => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'modelList', ...data } }));
  }, { models, runtimeDefaultModel });
}

// The modal registers its message listener in an effect (after paint), so a dispatch
// racing the mount can be lost under parallel-worker load - re-send until the first
// row renders (same toPass pattern as clickAndWaitForModal in file-path-links).
async function deliverModelList(
  page: Page,
  rowLocator: (page: Page, name: string) => ReturnType<Page['locator']>,
  models: Array<{ id: string; displayName: string; description?: string }>,
) {
  await expect(async () => {
    await sendModelList(page, models);
    await expect(rowLocator(page, models[0].displayName).first()).toBeVisible({ timeout: 300 });
  }).toPass({ timeout: 5000 });
}

function sendModelChanged(page: Page, model: string) {
  return page.evaluate((m) => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'modelChanged', model: m } }));
  }, model);
}

// Opens the Account modal via the slash menu and switches to the Models tab.
async function openModelsTab(page: Page) {
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.focus();
  await textarea.pressSequentially('/account');
  await page.locator('[class*="slashMenuItem"]', { hasText: 'Account & usage...' }).click();
  await page.getByRole('button', { name: 'Models' }).click();
  await expect(page.locator('[class*="placeholder"]', { hasText: 'Loading models...' })).toBeVisible();
}

function modelRow(page: Page, name: string) {
  return page.locator('[class*="modelRow"]', { hasText: name });
}

test.describe('model picker', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('models without an explicit description fall back to their family wording', async ({ page }) => {
    await openModelsTab(page);
    await deliverModelList(page, modelRow, [
      { id: 'claude-opus-5', displayName: 'Claude Opus 5' },
      { id: 'claude-fable-5', displayName: 'Claude Fable 5' },
      { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
    ]);

    await expect(modelRow(page, 'Claude Opus 5').locator('[class*="modelDesc"]')).toHaveText(OPUS_DESC);
    await expect(modelRow(page, 'Claude Fable 5').locator('[class*="modelDesc"]')).toHaveText(TOP_TIER_DESC);
    await expect(modelRow(page, 'Claude Haiku 4.5').locator('[class*="modelDesc"]')).toHaveText(HAIKU_DESC);
  });

  test('a server-provided description wins; an unknown family without one renders none', async ({ page }) => {
    await openModelsTab(page);
    await deliverModelList(page, modelRow, [
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', description: 'From the server' },
      { id: 'claude-zeta-1', displayName: 'Claude Zeta' },
    ]);

    await expect(modelRow(page, 'Claude Opus 5').locator('[class*="modelDesc"]')).toHaveText('From the server');
    await expect(modelRow(page, 'Claude Zeta').locator('[class*="modelDesc"]')).toHaveCount(0);
  });

  test('a dated list id highlights when the active model is the dateless alias', async ({ page }) => {
    await openModelsTab(page);
    await deliverModelList(page, modelRow, [
      { id: 'claude-fable-5-20260115', displayName: 'Claude Fable 5' },
      { id: 'claude-opus-5', displayName: 'Claude Opus 5' },
    ]);

    // No override yet: the Default (CLI) row is the active one.
    await expect(modelRow(page, 'Default (CLI)').locator('[class*="modelCheck"]')).toHaveText('✓');

    await sendModelChanged(page, 'claude-fable-5');
    await expect(modelRow(page, 'Claude Fable 5').locator('[class*="modelCheck"]')).toHaveText('✓');
    await expect(modelRow(page, 'Default (CLI)').locator('[class*="modelCheck"]')).toHaveText('');
    await expect(modelRow(page, 'Claude Opus 5').locator('[class*="modelCheck"]')).toHaveText('');
  });

  test('a dateless list id highlights when the active model is a dated snapshot', async ({ page }) => {
    await openModelsTab(page);
    await deliverModelList(page, modelRow, [
      { id: 'claude-fable-5', displayName: 'Claude Fable 5' },
    ]);

    await sendModelChanged(page, 'claude-fable-5-20260115');
    await expect(modelRow(page, 'Claude Fable 5').locator('[class*="modelCheck"]')).toHaveText('✓');
  });

  test('quick picker in the slash menu checks the active model across date suffixes', async ({ page }) => {
    const textarea = page.getByPlaceholder('Ask Argus');
    await textarea.focus();
    await textarea.pressSequentially('/');
    await page.locator('[class*="slashMenuItem"]', { hasText: 'Switch model...' }).click();
    const slashItem = (p: Page, name: string) => p.locator('[class*="slashMenuItem"]', { hasText: name });
    await deliverModelList(page, slashItem, [
      { id: 'claude-fable-5', displayName: 'Claude Fable 5' },
    ]);
    await sendModelChanged(page, 'claude-fable-5-20260115');

    const fableItem = slashItem(page, 'Claude Fable 5');
    await expect(fableItem.locator('[class*="slashMenuCheck"]')).toHaveText('✓');
    // The "Switch model..." hint resolves the display name through the same matching.
    await expect(page.locator('[class*="slashMenuHint"]')).toHaveText('Fable 5');
  });
});
