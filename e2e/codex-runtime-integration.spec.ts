import { test, expect } from './provider-fixtures';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { waitForApp } from './helpers';

type Frame = Record<string, any>;
async function connect(dir: string, panel: string) {
  const nonce = (await (await fetch('http://localhost:3001/nonce')).text()).trim();
  const ws = new WebSocket(`ws://localhost:3001/agent?nonce=${nonce}&dir=${encodeURIComponent(dir)}&panel=${panel}`);
  const frames: Frame[] = [];
  ws.on('message', data => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const wait = async (type: string, predicate = (_f: Frame) => true) => {
    await expect.poll(() => frames.some(f => f.type === type && predicate(f)), { timeout: 30_000 }).toBe(true);
    return frames.find(f => f.type === type && predicate(f))!;
  };
  return { ws, frames, wait, send: (msg: Frame) => ws.send(JSON.stringify(msg)) };
}

test('native model capabilities, effort changes and account usage work without another provider', { tag: ['@codex'] }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-catalog-'));
  const a = await connect(dir, 'scub-a');
  const b = await connect(dir, 'scub-b');
  try {
    a.send({ type: 'getModels' });
    const catalog = await a.wait('modelList');
    expect(catalog.error).toBeUndefined();
    expect(catalog.models.length).toBeGreaterThan(0);
    const model = catalog.models.find((m: Frame) => m.efforts?.length);
    expect(model).toBeTruthy();
    a.send({ type: 'switchModel', model: model.id });
    a.send({ type: 'switchEffort', effort: model.efforts[0] });
    const selected = await a.wait('providerSelection', f => f.model === model.id && f.effort === model.efforts[0]);
    expect(selected.providerId).toBe('codex');
    b.frames.length = 0;
    b.send({ type: 'getProviders' });
    expect((await b.wait('providerSelection')).model).toBe('gpt-6-luna');
    a.send({ type: 'getAccountUsage' });
    const account = await a.wait('accountUsage', f => f.usagePending === false);
    expect(account.account.loggedIn).toBe(true);
    expect(account.usageError).toBeUndefined();
    expect(Array.isArray(account.rateLimits)).toBe(true);
    for (const window of account.rateLimits) {
      expect(window.utilization).toBeGreaterThanOrEqual(0);
      expect(window.utilization).toBeLessThanOrEqual(1);
    }
    a.send({ type: 'getSkills' });
    const skills = await a.wait('skills');
    expect(skills.error).toBeUndefined();
    expect(skills.skills.length).toBeGreaterThan(0);
    expect(skills.skills.every((s: Frame) => s.name && s.path)).toBe(true);
  } finally {
    a.ws.close(); b.ws.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provider and model choices apply to future conversations without an extra save', { tag: ['@codex'] }, async () => {
  const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-choice-a-'));
  const nextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-choice-b-'));
  const thirdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-choice-c-'));
  const first = await connect(firstDir, 'scub-first');
  let next: Awaited<ReturnType<typeof connect>> | undefined;
  let third: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    first.send({ type: 'getModels' });
    const catalog = await first.wait('modelList');
    const selected = catalog.models.find((model: Frame) => model.id !== 'gpt-6-luna' && model.efforts?.length);
    expect(selected).toBeTruthy();
    first.send({ type: 'switchModel', model: selected.id });
    await first.wait('providerSelection', frame => frame.model === selected.id);
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(__dirname, 'argus.json'), 'utf8')).providerDefaults?.codex?.model).toBe(selected.id);
    next = await connect(nextDir, 'scub-next');
    next.send({ type: 'getProviders' });
    expect((await next.wait('providerSelection')).model, JSON.stringify(next.frames.filter(frame => frame.type === 'providerSelection'))).toBe(selected.id);
    expect((await next.wait('providerSelection')).providerId).toBe('codex');
    first.send({ type: 'switchProvider', providerId: 'claude' });
    await first.wait('providerSelection', frame => frame.providerId === 'claude');
    third = await connect(thirdDir, 'scub-third');
    third.send({ type: 'getProviders' });
    expect((await third.wait('providerSelection')).providerId).toBe('claude');
    first.send({ type: 'switchProvider', providerId: 'codex' });
    await first.wait('providerSelection', frame => frame.providerId === 'codex' && frame.model === selected.id);
  } finally {
    first.ws.close(); next?.ws.close(); third?.ws.close();
    fs.rmSync(firstDir, { recursive: true, force: true });
    fs.rmSync(nextDir, { recursive: true, force: true });
    fs.rmSync(thirdDir, { recursive: true, force: true });
  }
});

test('account picker shows the initial Codex and GPT-6-Luna selection', { tag: ['@codex'] }, async ({ page }) => {
  await waitForApp(page);
  await page.getByRole('button', { name: 'Choose provider and model' }).click();
  const dialog = page.getByRole('dialog', { name: 'Account' });
  const picker = dialog.getByRole('button', { name: 'Provider' });
  await expect(picker).toContainText('Codex');
  await picker.press('ArrowDown');
  const options = dialog.getByRole('listbox', { name: 'Providers' }).getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.locator('[data-provider-icon]')).toHaveCount(2);
  for (const icon of await options.locator('[data-provider-icon]').all()) {
    await expect(icon).toBeVisible();
  }
  await expect.poll(() => options.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(dialog.getByRole('option', { selected: true })).toBeFocused();
  await dialog.getByRole('option', { selected: true }).press('Escape');
  await expect(dialog.getByRole('listbox', { name: 'Providers' })).toHaveCount(0);
  await expect(picker).toBeFocused();
  await dialog.getByRole('button', { name: 'Models', exact: true }).click();
  await expect(dialog.locator('[class*="modelRow"]').filter({ hasText: 'GPT-6-Luna' }).locator('[class*="modelCheck"]')).toHaveText('✓');
  await expect(dialog.getByRole('button', { name: 'Use for new conversations' })).toHaveCount(0);
});

test('unsupported attachment keeps the draft and does not start a turn', { tag: ['@codex'] }, async ({ page }) => {
  await page.goto('/');
  const input = page.getByPlaceholder('Ask Argus');
  await expect(page.getByRole('button', { name: 'Codex permissions' })).toBeVisible();
  await input.fill('scub-retained-draft');
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['scub-document'], 'scub-document.pdf', { type: 'application/pdf' }));
    document.querySelector('textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }));
  });
  await expect(page.getByText('scub-document.pdf').first()).toBeVisible();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('does not support');
  await expect(input).toHaveValue('scub-retained-draft');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});
