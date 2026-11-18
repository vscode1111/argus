import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('Codex usage refreshes every minute without opening Account', async ({ page }) => {
  const requests: number[] = [];
  page.on('console', message => {
    if (message.text() === '[mock] suppressed getUsageLimits') requests.push(Date.now());
  });
  // The usage interval and bridge heartbeat share the page's virtual clock.
  // Keep heartbeat replies local instead of racing a real server against it.
  await page.addInitScript(() => {
    class LocalSocket extends EventTarget {
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
      send(data: string) {
        if (JSON.parse(data).type === 'getBgTasks') queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'bgTasks', count: 0 }) })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent('close')); }
    }
    window.WebSocket = LocalSocket as unknown as typeof WebSocket;
  });
  await page.clock.install();
  await waitForApp(page);
  await expect(page.getByTitle('Connected', { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'providerSelection', providerId: 'codex', model: 'inventory-model', effort: '', thinking: true,
  } })));
  await page.clock.runFor(100);
  const before = requests.length;
  await page.clock.runFor(61_000);
  expect(requests.length - before).toBe(1);
  await expect(page.getByTitle('Connected', { exact: true })).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'providerSelection', providerId: 'claude', model: 'inventory-model', effort: '', thinking: true,
  } })));
  await page.clock.runFor(100);
  const afterSwitch = requests.length;
  await page.clock.runFor(61_000);
  expect(requests.length).toBe(afterSwitch);
  await expect(page.getByTitle('Connected', { exact: true })).toBeVisible();
});
