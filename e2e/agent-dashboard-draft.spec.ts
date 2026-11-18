import { test, expect } from '@playwright/test';
import { setup, sync, emit, requests } from './fixtures/agent-graph-ui';

const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=';
const draftText = '  Check the inventory photo\nbefore dispatch.  ';
async function prepare(page: Parameters<typeof setup>[0]) {
  await setup(page); await sync(page); await emit(page, { type: 'sessionLoaded', id: 'parent', messages: [] });
  await page.evaluate(() => {
    (window as any).draftEffects = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let message; try { message = JSON.parse(String(data)); } catch {}
      if (message && ['send', 'stop', 'steer'].includes(message.type)) { (window as any).draftEffects.push(message); return; }
      return send.call(this, data);
    };
  });
  await page.getByPlaceholder('Ask Argus').fill(draftText);
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: 'inventory.png', mimeType: 'image/png', buffer: Buffer.from(imageData, 'base64') });
  await expect(page.getByRole('button', { name: 'Remove all attachments' })).toBeVisible();
}

for (const viaHistory of [false, true]) test(`same-session dashboard ${viaHistory ? 'history' : 'Back'} preserves text and image without hidden effects`, async ({ page }) => {
  await prepare(page); const before = page.url();
  await page.getByRole('button', { name: 'Agent dashboard', exact: true }).click();
  const dashboard = page.getByRole('main', { name: 'Agent dashboard' }); await expect(dashboard).toBeVisible();
  await expect(page.getByPlaceholder('Ask Argus')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await dashboard.getByLabel('Search title').focus(); await page.keyboard.press('Control+Enter');
  expect(await page.evaluate(() => (window as any).draftEffects)).toEqual([]);
  if (viaHistory) await page.goBack(); else await dashboard.getByRole('button', { name: 'Back to conversation' }).click();
  await expect(page.getByPlaceholder('Ask Argus')).toHaveValue(draftText);
  await expect(page.getByRole('button', { name: 'Remove all attachments' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('session')).toBe(new URL(before).searchParams.get('session'));
  expect((await requests(page)).filter(m => ['resumeSession', 'switchWorkspace'].includes(m.type))).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).draftEffects)).toEqual([]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const messages = await page.evaluate(() => (window as any).draftEffects);
  expect(messages).toHaveLength(1); expect(messages[0].text).toBe(draftText.trim());
  expect(messages[0].images).toHaveLength(1); expect(messages[0].images[0]).toMatchObject({ data: imageData, mediaType: 'image/png', name: 'inventory.png' });
  await expect(page.getByPlaceholder('Ask Argus')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remove all attachments' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Agent dashboard', exact: true }).click();
  await page.getByRole('button', { name: 'Back to conversation' }).click();
  await expect(page.getByPlaceholder('Ask Argus')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remove all attachments' })).toHaveCount(0);
});

test('intentional opening of another dashboard session keeps the established empty composer behavior', async ({ page }) => {
  await prepare(page); await page.getByRole('button', { name: 'Agent dashboard', exact: true }).click();
  await page.getByRole('button', { name: 'Open Stock worker', exact: true }).click();
  expect((await requests(page)).filter(m => m.type === 'resumeSession').at(-1)?.id).toBe('child');
  await emit(page, { type: 'sessionLoaded', id: 'child', messages: [] });
  await expect(page.getByPlaceholder('Ask Argus')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remove all attachments' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).draftEffects)).toEqual([]);
});

test('restoring a draft does not repeat prefill or restore removed attachments', async ({ page }) => {
  await prepare(page); await page.getByRole('button', { name: 'Remove all attachments' }).click();
  await emit(page, { type: 'prefill', text: 'Review receiving labels' });
  await expect(page.getByPlaceholder('Ask Argus')).toHaveValue(draftText.trimEnd() + '\nReview receiving labels\n');
  const before = await page.getByPlaceholder('Ask Argus').inputValue();
  await page.getByRole('button', { name: 'Agent dashboard', exact: true }).click();
  await page.getByRole('button', { name: 'Back to conversation' }).click();
  await expect(page.getByPlaceholder('Ask Argus')).toHaveValue(before);
  await expect(page.getByRole('button', { name: 'Remove all attachments' })).toHaveCount(0);
  await emit(page, { type: 'prefill', text: '' }); await emit(page, { type: 'prefill', text: 'Review receiving labels' });
  await expect(page.getByPlaceholder('Ask Argus')).toHaveValue(before.trimEnd() + '\nReview receiving labels\n');
  expect(await page.evaluate(() => (window as any).draftEffects)).toEqual([]);
});

for (const newWhileOpen of [false, true]) test(`submitted prefill stays consumed on different-target Open${newWhileOpen ? ' while new dashboard prefill is applied' : ''}`, async ({ page }) => {
  await prepare(page); await page.getByPlaceholder('Ask Argus').fill('');
  await emit(page, { type: 'prefill', text: 'Review receiving labels' });
  await expect(page.getByPlaceholder('Ask Argus')).toHaveValue('Review receiving labels\n');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByPlaceholder('Ask Argus')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remove all attachments' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Agent dashboard', exact: true }).click();
  if (newWhileOpen) await emit(page, { type: 'prefill', text: 'Check dispatch labels' });
  await page.getByRole('button', { name: 'Open Stock worker', exact: true }).click();
  await emit(page, { type: 'sessionLoaded', id: 'child', messages: [] });
  await expect(page.getByPlaceholder('Ask Argus')).toHaveValue(newWhileOpen ? 'Check dispatch labels\n' : '');
  await expect(page.getByRole('button', { name: 'Remove all attachments' })).toHaveCount(0);
  expect((await requests(page)).filter(m => m.type === 'resumeSession').at(-1)?.id).toBe('child');
  expect(await page.evaluate(() => (window as any).draftEffects)).toHaveLength(1);
  await emit(page, { type: 'prefill', text: 'Inspect storage labels' });
  await expect(page.getByPlaceholder('Ask Argus')).toHaveValue((newWhileOpen ? 'Check dispatch labels\n' : '') + 'Inspect storage labels\n');
  expect(await page.evaluate(() => (window as any).draftEffects)).toHaveLength(1);
});
