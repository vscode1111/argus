import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('tool rows from one paged assistant turn keep their compact spacing', async ({ page }) => {
  await waitForApp(page);
  const tool = (id: string) => ({ type: 'tool', call: {
    id, name: 'Bash', kind: 'command', input: { command: 'echo ready' }, result: 'ready',
  } });
  await page.evaluate(messages => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'sessionLoaded', id: 'history-session', messages, before: 0,
  } })), [
    { id: 'reply:block:0', role: 'assistant', content: '', blocks: [tool('first')] },
    { id: 'reply:block:1', role: 'assistant', content: '', blocks: [tool('second')], outcome: 'success' },
    { id: 'other-reply', role: 'assistant', content: '', blocks: [tool('third')], outcome: 'success' },
  ]);
  const rows = page.locator('[class*="_toolCall_"]');
  await expect(rows).toHaveCount(3);
  const [first, second, third] = await Promise.all([0, 1, 2].map(index => rows.nth(index).boundingBox()));
  if (!first || !second || !third) throw new Error('Tool rows have no layout boxes');
  const withinTurnGap = second.y - (first.y + first.height);
  const betweenTurnsGap = third.y - (second.y + second.height);
  expect(withinTurnGap).toBeLessThanOrEqual(12);
  expect(betweenTurnsGap).toBeGreaterThan(12);
});
