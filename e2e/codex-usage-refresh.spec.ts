import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('Codex usage refreshes every minute without opening Account', async ({ page }) => {
  const requests: number[] = [];
  page.on('console', message => {
    if (message.text() === '[mock] suppressed getUsageLimits') requests.push(Date.now());
  });
  await page.clock.install();
  await waitForApp(page);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true,
  } })));
  await page.clock.runFor(100);
  const before = requests.length;
  await page.clock.runFor(61_000);
  expect(requests.length - before).toBeGreaterThanOrEqual(1);

  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'providerSelection', providerId: 'claude', model: 'scub-model', effort: '', thinking: true,
  } })));
  await page.clock.runFor(100);
  const afterSwitch = requests.length;
  await page.clock.runFor(61_000);
  expect(requests.length).toBe(afterSwitch);
});
