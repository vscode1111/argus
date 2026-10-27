import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('loads older messages when scrolled to the top without moving the visible row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  page.on('console', message => {
    if (message.text() === '[mock] suppressed loadEarlier') requests.push(message.text());
  });
  await waitForApp(page);
  const id = 'history-page-session';
  const recent = Array.from({ length: 30 }, (_, index) => ({ id: `recent-${index}`, role: 'user', content: `Recent ${index + 31}: ${'detail '.repeat(20)}` }));
  await page.evaluate(({ id, recent }) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'sessionLoaded', id, messages: recent, before: 30 } })), { id, recent });
  const list = page.locator('[class*="_messages_"]');
  const anchor = page.getByText(/^Recent 31:/);
  await expect(anchor).toBeVisible();
  await list.evaluate(element => { element.scrollTop = 1; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => requests.length).toBe(1);
  const before = await anchor.boundingBox();
  const older = Array.from({ length: 30 }, (_, index) => ({ id: `older-${index}`, role: 'user', content: `Older ${index + 1}: ${'detail '.repeat(20)}` }));
  await page.evaluate(({ id, older }) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'historyPage', id, messages: older, before: 0, revision: 1 } })), { id, older });
  await expect(page.getByText(/^Older 1:/)).toHaveCount(1);
  const after = await anchor.boundingBox();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(5);
  await list.evaluate(element => { element.scrollTop = 1; element.dispatchEvent(new Event('scroll')); });
  expect(requests).toHaveLength(1);
});

test('ignores an older page from a previous replay of the same session', async ({ page }) => {
  await waitForApp(page);
  const id = 'history-reload-session';
  const send = (data: object) => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), data);
  await send({ type: 'sessionLoaded', id, messages: [{ id: 'current-a', role: 'user', content: 'Current entry' }], before: 10 });
  await send({ type: 'sessionLoaded', id, messages: [{ id: 'current-b', role: 'user', content: 'Refreshed entry' }], before: 10 });
  await send({ type: 'historyPage', id, messages: [{ id: 'stale', role: 'user', content: 'Stale entry' }], before: 0, revision: 1 });
  await expect(page.getByText('Refreshed entry')).toBeVisible();
  await expect(page.getByText('Stale entry')).toHaveCount(0);
});

test('a short recent page exposes older messages without scrolling', async ({ page }) => {
  const requests: string[] = [];
  page.on('console', message => {
    if (message.text() === '[mock] suppressed loadEarlier') requests.push(message.text());
  });
  await waitForApp(page);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'sessionLoaded', id: 'short-page-session',
    messages: [{ id: 'recent-entry', role: 'assistant', content: 'Recent summary' }], before: 30,
  } })));
  await expect(page.getByText('Recent summary')).toBeVisible();
  await page.getByRole('button', { name: 'Load earlier messages' }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'historyPage', id: 'short-page-session', revision: 1, before: 0,
    messages: [{ id: 'older-entry', role: 'user', content: 'Older detail' }],
  } })));
  await expect(page.getByText('Older detail')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
});
