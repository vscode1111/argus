import { test, expect } from './provider-fixtures';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
    expect((await b.wait('providerSelection')).model).toBe('');
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

test('unsupported attachment keeps the draft and does not start a turn', { tag: ['@codex'] }, async ({ page }) => {
  await page.goto('/');
  const input = page.getByPlaceholder('Ask Argus');
  await expect(page.getByRole('button', { name: 'Choose provider and model' })).toContainText('Codex');
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
