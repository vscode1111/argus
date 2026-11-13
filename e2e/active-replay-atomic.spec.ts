import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('opening an active response paints its complete tail instead of replaying earlier progress', async ({ page }) => {
  await waitForApp(page);
  const send = async (data: unknown) => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), data);
  await send({ type: 'replay_start' });
  await send({ type: 'sessionLoaded', id: 'delivery-session', messages: [{ id: 'request', role: 'user', content: 'Inspect deliveries' }] });
  await send({ type: 'thinking_start', startedAt: Date.now() - 60000 });
  await send({ type: 'text_chunk', text: 'Earlier delivery progress' });
  await expect(page.getByText('Earlier delivery progress', { exact: true })).toHaveCount(0);
  await send({ type: 'tool_start', call: { id: 'inspection', name: 'Inspect', input: {} } });
  await send({ type: 'tool_end', call: { id: 'inspection', result: 'Checked' } });
  await send({ type: 'text_chunk', text: 'Latest delivery progress' });
  await send({ type: 'replay_end' });
  await expect(page.getByText('Latest delivery progress', { exact: true })).toBeVisible();
  const list = page.locator('[class*="_messages_"]');
  await expect.poll(() => list.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(2);
  await send({ type: 'text_chunk', text: '\nNew delivery update' });
  await expect(page.getByText('New delivery update', { exact: false })).toBeVisible();
});
