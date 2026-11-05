import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('opening recent history stays at the bottom as its content finishes loading', async ({ page }) => {
  await waitForApp(page);
  const replay = () => page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'sessionLoaded', id: 'delivery-history',
      messages: Array.from({ length: 30 }, (_, index) => ({ id: `delivery-${index}`, role: 'user', content: `Delivery update ${index}: ${'Shipment detail. '.repeat(30)}` })),
    } }));
  });
  await replay();
  const gap = () => page.locator('[class*="_messages_"]').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await page.getByText('Delivery update 29:', { exact: false }).evaluate(el => {
    const attachment = document.createElement('div');
    attachment.style.height = '900px';
    el.appendChild(attachment);
  });
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await page.locator('[class*="_messages_"]').evaluate(el => { el.scrollTop = 0; });
  await expect.poll(gap).toBeGreaterThan(500);
  await page.getByText('Delivery update 29:', { exact: false }).evaluate(el => {
    const attachment = document.createElement('div');
    attachment.style.height = '300px';
    el.appendChild(attachment);
  });
  await expect.poll(() => page.locator('[class*="_messages_"]').evaluate(el => el.scrollTop)).toBe(0);
  await replay();
  await expect.poll(gap).toBeLessThanOrEqual(2);
});

test('a new request paints promptly beside a large completed history', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      id: `delivery-history-${index}`, role: 'assistant', content: '', outcome: 'success',
      blocks: Array.from({ length: 12 }, (_, section) => ({ type: 'text',
        text: `### Delivery ${index}, section ${section}\n\n| Parcel | Status |\n| --- | --- |\n| North warehouse | Dispatched |\n\nThe delivery record is complete. Review the next shipment when ready.`,
      })),
    }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'sessionLoaded', id: 'delivery-history', messages } }));
  });
  await page.getByRole('heading', { name: 'Delivery 59, section 11', exact: true }).waitFor({ state: 'attached' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const elapsedMs = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const started = performance.now();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'message', message: {
      id: 'delivery-status-request', role: 'user', content: 'Check the next delivery',
    } } }));
    await new Promise<void>(resolve => {
      const observer = new MutationObserver(() => {
        if (document.getElementById('root')?.textContent?.includes('Check the next delivery')) {
          observer.disconnect(); resolve();
        }
      });
      observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
    });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - started;
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  expect(elapsedMs).toBeLessThan(500);
  await expect(page.getByText('Check the next delivery', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delivery 59, section 11', exact: true })).toHaveCount(1);
});

test('keeps five older pages ready before the reader reaches them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  page.on('console', message => {
    if (message.text() === '[mock] suppressed loadEarlier') requests.push(message.text());
  });
  await waitForApp(page);
  const id = 'prefetch-session';
  const send = (data: object) => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), data);
  const pageOf = (prefix: string) => Array.from({ length: 30 }, (_, index) => ({ id: `${prefix}-${index}`, role: 'user', content: `${prefix} ${index}: ${'detail '.repeat(20)}` }));
  await send({ type: 'sessionLoaded', id, messages: pageOf('Recent'), before: 180 });
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByText('Loading earlier messages…')).toHaveCount(0);
  await send({ type: 'historyPage', id, revision: 1, prefetch: true, before: 150, messages: pageOf('Page one') });
  await expect.poll(() => requests.length).toBe(2);
  await send({ type: 'historyPage', id, revision: 1, prefetch: true, before: 120, messages: pageOf('Page two') });
  await expect.poll(() => requests.length).toBe(3);
  await send({ type: 'historyPage', id, revision: 1, prefetch: true, before: 90, messages: pageOf('Page three') });
  await expect.poll(() => requests.length).toBe(4);
  await send({ type: 'historyPage', id, revision: 1, prefetch: true, before: 60, messages: pageOf('Page four') });
  await expect.poll(() => requests.length).toBe(5);
  await send({ type: 'historyPage', id, revision: 1, prefetch: true, before: 30, messages: pageOf('Page five') });
  expect(requests).toHaveLength(5);
  await expect(page.getByText(/^Page one 0:/)).toHaveCount(0);
  await expect(page.getByText(/^Page three 0:/)).toHaveCount(0);
  await expect(page.getByText(/^Page five 0:/)).toHaveCount(0);

  const list = page.locator('[class*="_messages_"]');
  await list.evaluate(element => { element.scrollTop = 1; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByText(/^Page one 0:/)).toHaveCount(1);
  await expect(page.getByText(/^Page two 0:/)).toHaveCount(0);
  await expect.poll(() => requests.length).toBe(6);
  await send({ type: 'historyPage', id, revision: 1, prefetch: true, before: 0, messages: pageOf('Page six') });
  await expect(page.getByText(/^Page six 0:/)).toHaveCount(0);
  expect(requests).toHaveLength(6);

  await list.evaluate(element => { element.scrollTop = 1; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByText(/^Page two 0:/)).toHaveCount(1);
  await expect(page.getByText(/^Page three 0:/)).toHaveCount(0);
  expect(requests).toHaveLength(6);
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
  await expect(page.getByText('Current older entry')).toBeVisible();
  await expect(page.getByText('Stale buffered entry')).toHaveCount(0);
});

test('a scrollable recent page keeps the manual older-message button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  page.on('console', message => {
    if (message.text() === '[mock] suppressed loadEarlier') requests.push(message.text());
  });
  await waitForApp(page);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'sessionLoaded', id: 'short-page-session',
    messages: [{ id: 'recent-entry', role: 'assistant', content: `Recent summary ${'detail '.repeat(500)}` }], before: 30,
  } })));
  await expect(page.getByText('Recent summary')).toBeVisible();
  await expect.poll(() => page.locator('[class*="_messages_"]').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.getByRole('button', { name: 'Load earlier messages' }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByText('Loading earlier messages…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'historyPage', id: 'short-page-session', revision: 1, prefetch: true, before: 0,
    messages: [{ id: 'older-entry', role: 'user', content: 'Older detail' }],
  } })));
  await expect(page.getByText('Older detail')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
});

test('a short recent page fills the visible window from prefetched history', async ({ page }) => {
  await page.setViewportSize({ width: 1540, height: 500 });
  await waitForApp(page);
  const id = 'short-window-session';
  const send = (data: object) => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), data);
  await send({ type: 'sessionLoaded', id, messages: [{ id: 'recent-summary', role: 'assistant', content: 'Recent summary' }], before: 30 });
  await expect(page.getByText('Recent summary')).toBeVisible();
  await expect(page.getByText('Loading earlier messages…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
  await send({ type: 'historyPage', id, revision: 1, prefetch: true, before: 20,
    messages: [{ id: 'older-detail', role: 'user', content: 'Earlier detail' }] });
  await expect(page.getByText('Earlier detail')).toBeVisible();
  await send({ type: 'historyPage', id, revision: 1, prefetch: true, before: 0,
    messages: [{ id: 'oldest-detail', role: 'user', content: 'Oldest detail' }] });
  await expect(page.getByText('Oldest detail')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
});
