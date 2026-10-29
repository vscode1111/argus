import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('refreshed interrupted turn explains why work is idle', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'sessionLoaded', id: 'status-session', before: 0,
    messages: [
      { id: 'request-one', role: 'user', content: 'Check the status' },
      { id: 'reply-one', role: 'assistant', content: 'Checking now.', outcome: 'stopped',
        blocks: [{ type: 'text', text: 'Checking now.' }, { type: 'tool', call: { id: 'tool-one', name: 'status', input: {} } }] },
    ],
  } })));
  await expect(page.getByText('Turn interrupted. Send a message to continue.')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'sessionLoaded', id: 'complete-session', before: 0,
    messages: [{ id: 'complete-reply', role: 'assistant', content: 'All clear.', blocks: [{ type: 'text', text: 'All clear.' }] }],
  } })));
  await expect(page.getByText('Turn interrupted. Send a message to continue.')).toHaveCount(0);
});
