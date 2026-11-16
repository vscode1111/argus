import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('associated live and replay questions have exactly one interactive surface and preserve legacy answers', async ({ page }) => {
  await page.addInitScript(() => {
    const captured: unknown[] = [];
    Object.assign(window, { questionAnswers: captured });
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string' && JSON.parse(data).type === 'toolAnswer') { captured.push(JSON.parse(data)); return; }
      return send.call(this, data);
    };
  });
  await waitForApp(page);
  const call = { id: 'inventory-choice', name: 'AskUserQuestion', input: { questions: [{ question: 'Choose features', header: 'Features',
    multiSelect: true, options: [{ label: 'Search', description: 'Search inventory' }, { label: 'Sort' }] }] } };
  const request = { id: call.id, sourceToolId: call.id, kind: 'question', title: 'Your input is needed',
    questions: [{ id: `${call.id}:0`, question: 'Choose features', multiSelect: true, options: ['Search', 'Sort'] }] };
  for (const replay of [false, true]) {
    await page.evaluate(({ call, request, replay }) => {
      const emit = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
      emit({ type: 'clear' });
      if (replay) emit({ type: 'sessionLoaded', id: 'inventory', messages: [{ id: 'reply', role: 'assistant', content: '', blocks: [{ type: 'tool', call }] }] });
      else { emit({ type: 'thinking_start' }); emit({ type: 'tool_start', call }); }
      emit({ type: 'interaction', request });
    }, { call, request, replay });
    await expect(page.getByRole('button', { name: 'Submit answers' })).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Provider request' })).toHaveCount(0);
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.getByText('Search inventory', { exact: true })).toBeVisible();
    }
    await page.getByText('Search', { exact: true }).click(); await page.getByText('Sort', { exact: true }).click();
    await page.getByRole('button', { name: 'Submit answers' }).click();
  }
  const answers = await page.evaluate(() => (window as unknown as { questionAnswers: unknown[] }).questionAnswers);
  expect(answers).toEqual([0, 1].map(() => ({ type: 'toolAnswer', id: call.id, answers: { 'Choose features': 'Search, Sort' } })));
});
