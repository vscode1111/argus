import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

const request = { id: 'scub-ask', kind: 'question', async: true, title: 'scub-input-needed',
  questions: [{ id: '0', question: 'scub-choice', options: ['scub-blue', 'scub-green'] }] };

async function send(page: Page, data: object) {
  await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), data);
}

test('async choice opens a modal, survives turn completion, and sends the selected response', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    (window as unknown as { scubSent: unknown[] }).scubSent = [];
    const original = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      const message = typeof data === 'string' ? JSON.parse(data) : null;
      if (message?.type === 'send') {
        (window as unknown as { scubSent: unknown[] }).scubSent.push(message);
        return;
      }
      return original.call(this, data);
    };
  });
  await waitForApp(page);
  await send(page, { type: 'interaction', request });
  const dialog = page.getByRole('dialog', { name: 'scub-input-needed' });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('dialog.png') });
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  await send(page, { type: 'done' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('scub-green').check();
  await dialog.getByRole('button', { name: 'Submit answers' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { scubSent: Array<{ type: string; text?: string; mode?: string }> }).scubSent
    .filter(message => message.type === 'send').map(message => ({ text: message.text, mode: message.mode })))).toEqual([{ text: 'scub-choice\nscub-green', mode: 'full-access' }]);
  await send(page, { type: 'message', message: { id: 'scub-reply', role: 'user', content: 'scub-choice\nscub-green' } });
  await expect(dialog).toHaveCount(0);
});

test('history replay restores the latest unanswered choice', async ({ page }) => {
  await waitForApp(page);
  await send(page, { type: 'sessionLoaded', id: 'scub-session', messages: [
    { id: 'scub-user', role: 'user', content: 'scub-request' },
    { id: 'scub-earlier', role: 'assistant', content: 'scub-first', interaction: { ...request, id: 'scub-earlier', title: 'scub-earlier-title' } },
    { id: 'scub-answer', role: 'assistant', content: 'scub-choice', interaction: request },
  ] });
  await expect(page.getByRole('dialog', { name: 'scub-input-needed' })).toBeVisible();
  await send(page, { type: 'sessionLoaded', id: 'scub-session', messages: [
    { id: 'scub-user', role: 'user', content: 'scub-request' },
    { id: 'scub-earlier', role: 'assistant', content: 'scub-first', interaction: { ...request, id: 'scub-earlier', title: 'scub-earlier-title' } },
    { id: 'scub-answer', role: 'assistant', content: 'scub-choice', interaction: request },
    { id: 'scub-reply', role: 'user', content: 'scub-green' },
  ] });
  await expect(page.getByRole('dialog', { name: 'scub-input-needed' })).toHaveCount(0);
});

test('approval actions use the panel button styles at compact width', async ({ page }) => {
  await page.setViewportSize({ width: 970, height: 500 });
  await waitForApp(page);
  await send(page, { type: 'interaction', request: { id: 'scub-approval', kind: 'approval', title: 'scub-operation', detail: 'scub-command', options: ['accept', 'decline'] } });
  const panel = page.getByRole('region', { name: 'Provider request' });
  const allow = panel.getByRole('button', { name: 'Allow once' });
  const decline = panel.getByRole('button', { name: 'Decline' });
  await expect(allow).toBeVisible();
  await expect(decline).toBeVisible();
  const appearance = await allow.evaluate(element => {
    const style = getComputedStyle(element);
    const reference = document.createElement('span');
    reference.style.backgroundColor = 'var(--vscode-button-background)';
    document.body.append(reference);
    const themeBackground = getComputedStyle(reference).backgroundColor;
    reference.remove();
    return { background: style.backgroundColor, themeBackground, radius: style.borderRadius, height: element.getBoundingClientRect().height };
  });
  expect(appearance.background).toBe(appearance.themeBackground);
  expect(appearance.radius).toBe('4px');
  expect(appearance.height).toBeGreaterThanOrEqual(28);
});
