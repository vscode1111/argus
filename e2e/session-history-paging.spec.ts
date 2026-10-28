import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('keeps three older pages ready before the reader reaches them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  page.on('console', message => {
    if (message.text() === '[mock] suppressed loadEarlier') requests.push(message.text());
  });
  await waitForApp(page);
  const id = 'prefetch-session';
  const send = (data: object) => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), data);
  const pageOf = (prefix: string) => Array.from({ length: 30 }, (_, index) => ({ id: `${prefix}-${index}`, role: 'user', content: `${prefix} ${index}: ${'detail '.repeat(20)}` }));
  await send({ type: 'sessionLoaded', id, messages: pageOf('Recent'), before: 120 });
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByText('Loading older messages…')).toHaveCount(0);
  await send({ type: 'historyPage', id, revision: 1, prefetch: true, before: 90, messages: pageOf('Page one') });
  await expect.poll(() => requests.length).toBe(2);
  await send({ type: 'historyPage', id, revision: 1, prefetch: true, before: 60, messages: pageOf('Page two') });
  await expect.poll(() => requests.length).toBe(3);
  await send({ type: 'historyPage', id, revision: 1, prefetch: true, before: 30, messages: pageOf('Page three') });
  expect(requests).toHaveLength(3);
  await expect(page.getByText(/^Page one 0:/)).toHaveCount(0);
  await expect(page.getByText(/^Page three 0:/)).toHaveCount(0);

  const list = page.locator('[class*="_messages_"]');
  await list.evaluate(element => { element.scrollTop = 1; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByText(/^Page one 0:/)).toHaveCount(1);
  await expect(page.getByText(/^Page two 0:/)).toHaveCount(0);
  await expect.poll(() => requests.length).toBe(4);
  await send({ type: 'historyPage', id, revision: 1, prefetch: true, before: 0, messages: pageOf('Page four') });
  await expect(page.getByText(/^Page four 0:/)).toHaveCount(0);
  expect(requests).toHaveLength(4);

  await list.evaluate(element => { element.scrollTop = 1; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByText(/^Page two 0:/)).toHaveCount(1);
  await expect(page.getByText(/^Page three 0:/)).toHaveCount(0);
  expect(requests).toHaveLength(4);
});

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
  await expect.poll(() => requests.length).toBe(1);
  const older = Array.from({ length: 30 }, (_, index) => ({ id: `older-${index}`, role: 'user', content: `Older ${index + 1}: ${'detail '.repeat(20)}` }));
  await page.evaluate(({ id, older }) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'historyPage', id, messages: older, before: 0, revision: 1, prefetch: true } })), { id, older });
  await expect(page.getByText(/^Older 1:/)).toHaveCount(0);
  const oldScrollTop = await list.evaluate(element => element.scrollTop);
  const before = await anchor.boundingBox();
  await list.evaluate(element => { element.scrollTop = 1; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByText(/^Older 1:/)).toHaveCount(1);
  const after = await anchor.boundingBox();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0) - oldScrollTop + 1)).toBeLessThan(5);
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
  await send({ type: 'historyPage', id, messages: [{ id: 'stale-prefetch', role: 'user', content: 'Stale buffered entry' }], before: 0, revision: 1, prefetch: true });
  await expect(page.getByText('Refreshed entry')).toBeVisible();
  await expect(page.getByText('Stale entry')).toHaveCount(0);
  await expect(page.getByText('Stale buffered entry')).toHaveCount(0);
  await send({ type: 'historyPage', id, messages: [{ id: 'current-older', role: 'user', content: 'Current older entry' }], before: 0, revision: 2, prefetch: true });
  await page.getByRole('button', { name: 'Load earlier messages' }).click();
  await expect(page.getByText('Current older entry')).toBeVisible();
  await expect(page.getByText('Stale buffered entry')).toHaveCount(0);
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
  await expect(page.getByText('Loading older messages…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'historyPage', id: 'short-page-session', revision: 1, prefetch: true, before: 0,
    messages: [{ id: 'older-entry', role: 'user', content: 'Older detail' }],
  } })));
  await expect(page.getByText('Older detail')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
});
