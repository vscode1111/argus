import { test, expect } from '@playwright/test';

test('opening and refreshing a session shows its latest message and live progress', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.routeWebSocket('**/*', socket => socket.close());
  await page.goto('/?mock=1');
  await expect(page.getByPlaceholder('Ask Argus')).toBeVisible();

  const send = (data: object) => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), data);
  const messages = (prefix: string) => Array.from({ length: 30 }, (_, index) => ({
    id: `${prefix}-${index}`, role: 'user', content: `${prefix} entry ${index}: ${'detail '.repeat(24)}`,
  }));
  const list = page.locator('[class*="_messages_"]');
  const distanceFromBottom = () => list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);

  await send({ type: 'sessionLoaded', id: 'first-session', messages: messages('First') });
  await expect.poll(() => list.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100);
  await list.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeVisible();

  await send({ type: 'sessionLoaded', id: 'second-session', messages: messages('Second') });
  await expect.poll(distanceFromBottom).toBeLessThan(2);

  await list.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeVisible();
  await send({ type: 'sessionLoaded', id: 'second-session', messages: messages('Second') });
  await send({ type: 'thinking_start', startedAt: Date.now() });
  await send({ type: 'text_chunk', text: 'Current progress' });
  await send({ type: 'token_update', inputTokens: 123, outputTokens: 12 });
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(page.getByText(/123 in \/ 12 out/)).toBeInViewport();
  await expect.poll(distanceFromBottom).toBeLessThan(2);
});
