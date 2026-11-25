import { expect, test } from '@playwright/test';
import { waitForApp } from './helpers';

test('consecutive name-only calls share a counter during streaming and after completion', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const emit = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    emit({ type: 'thinking_start' });
    emit({ type: 'tool_start', call: { id: 'search-1', name: 'webSearch', input: { detail: 'webSearch' } } });
  });
  await expect(page.getByText('webSearch', { exact: true })).toHaveCount(1);
  await expect(page.getByText('×1', { exact: true })).toHaveCount(0);

  await page.evaluate(() => {
    const emit = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    for (const id of ['search-1', 'search-2']) {
      const call = { id, name: 'webSearch', input: { detail: 'webSearch' }, result: 'Complete' };
      if (id === 'search-2') emit({ type: 'tool_start', call });
      emit({ type: 'tool_end', call });
    }
  });
  await expect(page.getByText('webSearch', { exact: true })).toHaveCount(1);
  await expect(page.getByText('×2', { exact: true })).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'done' } })));
  await expect(page.getByText('webSearch', { exact: true })).toHaveCount(1);
  await expect(page.getByText('×2', { exact: true })).toBeVisible();
});

test('history groups name-only calls while preserving text, descriptions and errors', async ({ page }) => {
  await waitForApp(page);
  const wait = (id: string, input = {}, error = false) => ({
    type: 'tool', call: { id, name: 'wait', input, error, result: 'Complete' },
  });
  await page.evaluate(blocks => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'sessionLoaded', id: 'history-session', before: 0,
    messages: [{ id: 'reply', role: 'assistant', content: '', outcome: 'success', blocks }],
  } })), [
    wait('wait-1'), wait('wait-2'), wait('wait-3'),
    { type: 'text', text: 'Checking inventory.' },
    wait('wait-4'), wait('wait-5', { description: 'Waiting for inventory' }), wait('wait-6', {}, true), wait('wait-7'),
  ]);
  await expect(page.getByText('wait', { exact: true })).toHaveCount(5);
  await expect(page.getByText('×3', { exact: true })).toBeVisible();
  await expect(page.getByText('×2', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Checking inventory.', { exact: true })).toBeVisible();
  await expect(page.getByText('Waiting for inventory', { exact: true })).toBeVisible();
  await expect(page.locator('[class*="_toolCall_"][class*="_error_"]')).toHaveCount(1);
});

test('paged history groups segments of one turn and expands when details are enabled', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const messages = ['reply:block:0', 'reply:block:1', 'other-reply:block:0'].map((id, index) => ({
      id, role: 'assistant', content: '', outcome: index ? 'success' : undefined,
      blocks: [{ type: 'tool', call: { id: `wait-${index}`, name: 'wait', input: {}, result: 'Complete' } }],
    }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'sessionLoaded', id: 'history-session', before: 0, messages } }));
  });
  const waits = page.getByText('wait', { exact: true });
  const count = page.getByText('×2', { exact: true });
  await expect(waits).toHaveCount(2);
  await expect(count).toBeVisible();

  for (const settings of [{ showOutput: true }, { showOutput: false, verboseTools: true }]) {
    await page.evaluate(settings => window.dispatchEvent(new MessageEvent('message', { data: { type: 'settings', settings } })), settings);
    await expect(count).toHaveCount(0);
    await expect(waits).toHaveCount(3);
  }
});
