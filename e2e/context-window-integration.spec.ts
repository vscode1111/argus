import { test, expect, type Page } from '@playwright/test';
import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { waitForApp } from './helpers';

// The context-usage pill is a percentage of the model's own window, not a fixed 200k:
// the 4.x line is 200k while opus-4-6 / sonnet-5 and later are 1M, so a hardcoded
// denominator pegged every 1M model at 100% four times too early. The window comes
// from the cached /v1/models list (max_input_tokens) via contextWindowFor(), which is
// exercised directly against real config files in a child process, and end-to-end
// through the UI: seed a window for a pinned model, run a turn, read the pill.

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'e2e', 'argus.json');
const MODEL_DATA_JS = path.join(ROOT, 'out', 'backend', 'modelData.js');

// Deliberately not a real window: a value nothing could produce by accident proves the
// number was resolved from the cache rather than from a default or the CLI's own report.
const SEEDED_WINDOW = 400_000;
const PINNED_MODEL = 'claude-haiku-4-5';

test.describe.configure({ mode: 'serial' });

let originalConfig: string;
const tmpConfigs: string[] = [];

test.beforeAll(() => {
  originalConfig = fs.readFileSync(CONFIG_PATH, 'utf-8');
  if (!fs.existsSync(MODEL_DATA_JS)) execSync('yarn compile', { cwd: ROOT, stdio: 'ignore' });
});

test.afterAll(() => {
  fs.writeFileSync(CONFIG_PATH, originalConfig);
  for (const f of tmpConfigs) { try { fs.unlinkSync(f); } catch {} }
});

function patchConfig(patch: Record<string, unknown>): void {
  const cfg = { ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

function tmpConfig(cfg: Record<string, unknown>): string {
  const file = path.join(os.tmpdir(), `argus-scub-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg));
  tmpConfigs.push(file);
  return file;
}

// Child process for the same reason as workspace-info-config: config.ts resolves
// ARGUS_CONFIG at import time, so the env must be set before the module loads.
function resolveWindow(modelListCache: unknown, id: string): number {
  const file = tmpConfig({ modelListCache });
  // String(), not the raw number: Playwright sets FORCE_COLOR, so console.log of a
  // number comes back wrapped in ANSI escapes and parses as NaN.
  const script = `const { contextWindowFor } = require(${JSON.stringify(MODEL_DATA_JS)});` +
    `console.log(String(contextWindowFor(${JSON.stringify(id)})));`;
  const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, ARGUS_CONFIG: file } });
  const raw = out.toString().trim();
  const window = Number(raw);
  if (!Number.isFinite(window)) throw new Error(`unexpected child output: ${JSON.stringify(raw)}`);
  return window;
}

const CACHE = [
  { id: 'claude-opus-5', displayName: 'Claude Opus 5', contextWindow: 1_000_000 },
  { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', contextWindow: 200_000 },
  { id: 'claude-legacy-nowindow', displayName: 'No window' },
];

test('contextWindowFor resolves the window per model from the cached list', () => {
  expect(resolveWindow(CACHE, 'claude-opus-5')).toBe(1_000_000);
  expect(resolveWindow(CACHE, 'claude-haiku-4-5-20251001')).toBe(200_000);
});

test('contextWindowFor matches a snapshot id against its dateless alias both ways', () => {
  // Reported ids carry a date the cached list may not, and vice versa.
  expect(resolveWindow(CACHE, 'claude-haiku-4-5')).toBe(200_000);
  expect(resolveWindow([{ id: 'claude-opus-5', displayName: 'x', contextWindow: 1_000_000 }], 'claude-opus-5-20260724')).toBe(1_000_000);
});

test('contextWindowFor falls back to 200k when the model is unknown or has no window', () => {
  // The window is not derivable from the family (opus-4-5 is 200k, opus-4-6 is 1M),
  // so an unknown id must take the default rather than guess.
  expect(resolveWindow(CACHE, 'claude-unreleased-9')).toBe(200_000);
  expect(resolveWindow(CACHE, 'claude-legacy-nowindow')).toBe(200_000);
  expect(resolveWindow([], 'claude-opus-5')).toBe(200_000);
  expect(resolveWindow(CACHE, '')).toBe(200_000);
});

// Title format: "N% used\nInput: X tokens\nOutput: Y tokens\nWindow: Z tokens"
function parseTitle(title: string): Record<string, number> {
  const out: Record<string, number> = {};
  const percent = /^(\d+)% used/.exec(title);
  if (percent) out.percent = Number(percent[1]);
  for (const [, key, value] of title.matchAll(/(Input|Output|Window): ([\d,.\s  ]+) tokens/g)) {
    out[key.toLowerCase()] = Number(value.replace(/\D/g, ''));
  }
  return out;
}

test('the pill reports a percentage of the seeded model window, not a fixed 200k', async ({ page }) => {
  patchConfig({
    model: PINNED_MODEL,
    modelListCache: [{ id: PINNED_MODEL, displayName: 'Pinned', contextWindow: SEEDED_WINDOW }],
  });

  await waitForApp(page);
  await page.getByPlaceholder('Ask Argus').fill('say ok');
  await page.getByRole('button', { name: 'Send' }).click();

  const pill = page.locator('[class*="contextPill"]');
  await expect(pill).toBeVisible({ timeout: 25_000 });

  const parsed = parseTitle((await pill.getAttribute('title')) ?? '');
  expect(parsed.window).toBe(SEEDED_WINDOW);
  expect(parsed.input).toBeGreaterThan(0);
  // Output is excluded from the numerator: it is already counted in the next request's
  // input, and the CLI's own percentage uses input alone.
  expect(parsed.percent).toBe(Math.min(100, Math.round(parsed.input / SEEDED_WINDOW * 100)));
  await expect(pill).toHaveText(`${parsed.percent}%`);
});
