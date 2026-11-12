import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Codex writes one statement per line with single newlines and no blank lines.
// CommonMark folds those into one paragraph, which rendered a fifteen-line Codex
// answer as one wall of text. Codex replies render each newline as a line break;
// Claude keeps standard Markdown, which is the control: a build that enabled hard
// breaks for every provider fails the second test.
const TEXT = 'scub-first line\nscub-second line\nscub-third line';

async function send(page: Page, data: unknown) {
  await page.evaluate(d => window.dispatchEvent(new MessageEvent('message', { data: d })), data);
}

async function showReply(page: Page, providerId: string) {
  await waitForApp(page);
  await send(page, { type: 'providerSelection', providerId, model: 'scub-model', effort: '', thinking: true });
  await send(page, { type: 'sessionLoaded', id: 'scub-session', messages: [
    { id: 'scub-user', role: 'user', content: 'scub-question' },
    { id: 'scub-reply', role: 'assistant', content: TEXT, outcome: 'success' },
  ] });
  const paragraph = page.locator('p', { hasText: 'scub-first line' });
  await expect(paragraph).toBeVisible();
  return paragraph;
}

test('a Codex reply renders each single newline as a line break', async ({ page }) => {
  const paragraph = await showReply(page, 'codex');
  await expect(paragraph.locator('br')).toHaveCount(2);
});

test('a Claude reply keeps standard soft line breaks', async ({ page }) => {
  const paragraph = await showReply(page, 'claude');
  await expect(paragraph.locator('br')).toHaveCount(0);
});

test('a streaming Codex reply renders line breaks too', async ({ page }) => {
  await waitForApp(page);
  await send(page, { type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true });
  await send(page, { type: 'thinking_start' });
  await send(page, { type: 'text_chunk', text: TEXT });
  const paragraph = page.locator('p', { hasText: 'scub-first line' });
  await expect(paragraph.locator('br')).toHaveCount(2);
});
