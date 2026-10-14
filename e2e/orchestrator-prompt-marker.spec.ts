import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

async function send(page: Page, data: object) {
  await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), data);
}

async function backgrounds(page: Page) {
  return page.locator('div[class*="userMsg"]').evaluateAll(elements =>
    elements.map(element => getComputedStyle(element).backgroundColor));
}

test('orchestrator prompts stay violet in live messages and Session History replay', async ({ page }) => {
  await waitForApp(page);
  await send(page, { type: 'message', message: { id: 'scub-live-worker', role: 'user', content: '🤖 scub-delegated work' } });
  await send(page, { type: 'message', message: { id: 'scub-live-human', role: 'user', content: 'scub-human follow-up' } });
  await expect(page.getByText('🤖 scub-delegated work')).toBeVisible();
  const live = await backgrounds(page);
  expect(live).toHaveLength(2);
  expect(live[0]).not.toBe(live[1]);

  await send(page, { type: 'sessionLoaded', id: 'scub-session', messages: [
    { id: 'scub-replay-worker', role: 'user', content: '🤖 scub-delegated work' },
    { id: 'scub-replay-command', role: 'user', content: '/scub-check 🤖 scub-delegated work' },
    { id: 'scub-replay-human', role: 'user', content: 'scub-human follow-up' },
  ] });
  const replay = await backgrounds(page);
  expect(replay).toHaveLength(3);
  expect(replay[0]).toBe(live[0]);
  expect(replay[1]).toBe(live[0]);
  expect(replay[2]).toBe(live[1]);

  await send(page, { type: 'thinking_start' });
  await send(page, { type: 'user_inject', text: '🤖 scub-mid-turn request' });
  const injection = page.locator('div[class*="userInject"]').first();
  await expect(injection).toContainText('🤖 scub-mid-turn request');
  expect(await injection.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(live[0]);
});
