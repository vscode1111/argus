import { test, expect, type Page } from '@playwright/test';
import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { waitForApp } from './helpers';

// getInfo -> workspaceInfo must carry model/effort/thinking fresh from argus.json, so a
// freshly loaded page restores the config-global picker state instead of keeping the
// reducer's initial "Default (CLI)"/high. Both getInfo responders (the WS server in
// session.ts and the VS_ONLY extension path in ChatPanel.ts) reply via
// buildWorkspaceInfo(); the builder is exercised directly against real config files in
// a child process (the extension host cannot be driven from this suite), the server
// path end-to-end through the UI: write the config, load the page, open the picker.

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'e2e', 'argus.json');
const BUILDER_JS = path.join(ROOT, 'out', 'backend', 'workspaceInfo.js');

test.describe.configure({ mode: 'serial' });

let originalConfig: string;
const tmpConfigs: string[] = [];

test.beforeAll(() => {
  originalConfig = fs.readFileSync(CONFIG_PATH, 'utf-8');
});

test.afterAll(() => {
  fs.writeFileSync(CONFIG_PATH, originalConfig);
  for (const f of tmpConfigs) { try { fs.unlinkSync(f); } catch {} }
});

function patchConfig(patch: Record<string, unknown>): void {
  const cfg = { ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

// daemonHelpers.ensureCompiled only checks for daemon.js; this spec needs the builder.
function ensureBuilderCompiled(): void {
  if (!fs.existsSync(BUILDER_JS)) execSync('yarn compile', { cwd: ROOT, stdio: 'ignore' });
}

function tmpConfig(cfg: Record<string, unknown>): string {
  const file = path.join(os.tmpdir(), `argus-scub-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg));
  tmpConfigs.push(file);
  return file;
}

// Runs the compiled builder in a child process: config.ts resolves ARGUS_CONFIG once at
// import time, so the env must be set before the module loads - impossible to guarantee
// in-process with Playwright's worker reuse.
function runBuilder(configFile: string, wsPath: string, version: string, fallbackModel?: string): Record<string, unknown> {
  const args = fallbackModel === undefined ? [wsPath, version] : [wsPath, version, fallbackModel];
  const script = `const { buildWorkspaceInfo } = require(${JSON.stringify(BUILDER_JS)});` +
    `console.log(JSON.stringify(buildWorkspaceInfo(...${JSON.stringify(args)})));`;
  const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, ARGUS_CONFIG: configFile } });
  return JSON.parse(out.toString().trim());
}

function modelRow(page: Page, name: string) {
  return page.locator('[class*="modelRow"]', { hasText: name });
}

// Same surface as model-picker.spec.ts (mock), but the modelList reply is real: wait
// for the rows instead of the transient "Loading models..." placeholder.
async function openModelsTab(page: Page): Promise<void> {
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.focus();
  await textarea.pressSequentially('/account');
  await page.locator('[class*="slashMenuItem"]', { hasText: 'Account & usage...' }).click();
  await page.getByRole('button', { name: 'Models' }).click();
  await expect(modelRow(page, 'Default (CLI)')).toBeVisible({ timeout: 15_000 });
}

test.describe('workspaceInfo config restore', () => {
  test('buildWorkspaceInfo reads model/effort/thinking from the config file', () => {
    ensureBuilderCompiled();
    const msg = runBuilder(tmpConfig({ model: 'scub-model-1', effort: 'max', thinking: false }), 'scub-ws-path', '1.2.3');
    expect(msg).toEqual({
      type: 'workspaceInfo',
      path: 'scub-ws-path',
      version: '1.2.3',
      model: 'scub-model-1',
      effort: 'max',
      thinking: false,
    });
  });

  test('empty configured model uses the fallback; a set model wins; no fallback stays empty', () => {
    ensureBuilderCompiled();
    expect(runBuilder(tmpConfig({ model: '' }), 'p', 'v', 'scub-fallback-model').model).toBe('scub-fallback-model');
    expect(runBuilder(tmpConfig({ model: 'scub-model-1' }), 'p', 'v', 'scub-fallback-model').model).toBe('scub-model-1');
    // The extension path passes no fallback: an empty model must stay empty (Default row).
    expect(runBuilder(tmpConfig({ model: '' }), 'p', 'v').model).toBe('');
  });

  test('a fresh page load restores the configured model, effort and thinking into the picker', async ({ page }) => {
    // claude-opus-4-8 is in the webview's FALLBACK_MODELS trio and in the live
    // /v1/models list, so its row renders whichever way the model fetch goes.
    patchConfig({ model: 'claude-opus-4-8', effort: 'max', thinking: false });
    await waitForApp(page);
    await openModelsTab(page);

    await expect(modelRow(page, 'Claude Opus 4.8').locator('[class*="modelCheck"]')).toHaveText('✓');
    await expect(modelRow(page, 'Default (CLI)').locator('[class*="modelCheck"]')).toHaveText('');
    await expect(page.locator('[class*="optionLabel"]', { hasText: 'Effort' })).toHaveText('Effort (Max)');
    await expect(page.locator('[class*="toggleTrackOn"]')).toHaveCount(0);
  });

  test('an empty configured model highlights the Default (CLI) row', async ({ page }) => {
    patchConfig({ model: '', effort: 'low', thinking: true });
    await waitForApp(page);
    await openModelsTab(page);

    await expect(modelRow(page, 'Default (CLI)').locator('[class*="modelCheck"]')).toHaveText('✓');
    await expect(page.locator('[class*="optionLabel"]', { hasText: 'Effort' })).toHaveText('Effort (Low)');
    await expect(page.locator('[class*="toggleTrackOn"]')).toHaveCount(1);
  });
});
