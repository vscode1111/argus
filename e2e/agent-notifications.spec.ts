import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';
async function emit(page: Page, value: object) {
  await page.evaluate(value => new Promise<void>(resolve => { window.dispatchEvent(new MessageEvent('message', { data: value })); requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }), value);
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const counts = { sound: 0, notify: 0 }; Object.assign(window, { alertCounts: counts });
    const Audio = window.AudioContext;
    window.AudioContext = function() { counts.sound++; return new Audio(); } as unknown as typeof AudioContext;
    window.AudioContext.prototype = Audio.prototype;
    class Notice { static permission = 'granted'; constructor() { counts.notify++; } close() {} }
    Object.defineProperty(window, 'Notification', { value: Notice, configurable: true });
  });
  await waitForApp(page);
});
const counts = (page: Page) => page.evaluate(() => (window as unknown as { alertCounts: { sound: number; notify: number } }).alertCounts);
for (const terminal of ['done', 'error']) test(`graph ${terminal} suppresses pending/unknown alerts but final all-clear rings`, async ({ page }) => {
  for (const pending of [{ pendingAgentChildren: 1 }, { unknownAgentChildren: 1 }]) {
    await emit(page, { type: 'thinking_start', notificationOrigin: 'graph' }); await emit(page, { type: 'text_chunk', text: 'Synthetic progress' });
    await emit(page, { type: terminal, text: 'Synthetic terminal', notificationOrigin: 'graph', ...pending });
    expect(await counts(page)).toEqual({ sound: 0, notify: 0 });
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  }
  await emit(page, { type: 'thinking_start', notificationOrigin: 'graph' }); await emit(page, { type: 'text_chunk', text: 'Synthetic final report' });
  await emit(page, { type: terminal, text: 'Synthetic terminal', notificationOrigin: 'graph', pendingAgentChildren: 0, unknownAgentChildren: 0 });
  expect(await counts(page)).toEqual({ sound: 1, notify: 1 });
});
test('graph pending Ask stays silent, manual pending Ask still alerts', async ({ page }) => {
  const call = { id: 'inventory-choice', name: 'AskUserQuestion', input: { questions: [{ question: 'Choose section', header: 'Section', options: [{ label: 'Stock' }] }] } };
  await emit(page, { type: 'thinking_start', notificationOrigin: 'graph' }); await emit(page, { type: 'tool_start', call });
  expect(await counts(page)).toEqual({ sound: 0, notify: 0 });
  await emit(page, { type: 'clear' }); await emit(page, { type: 'thinking_start' }); await emit(page, { type: 'tool_start', call });
  expect(await counts(page)).toEqual({ sound: 1, notify: 1 });
});
test('manual injection takes over graph turn before a subsequent pending Ask', async ({ page }) => {
  await emit(page, { type: 'thinking_start', notificationOrigin: 'graph' });
  await emit(page, { type: 'user_inject', text: 'Synthetic manual input' });
  await emit(page, { type: 'tool_start', call: { id: 'inventory-choice', name: 'AskUserQuestion', input: { questions: [{ question: 'Choose section', header: 'Section', options: [{ label: 'Stock' }] }] } } });
  expect(await counts(page)).toEqual({ sound: 1, notify: 1 });
});
test('disabled settings and replay never emit sound or OS notification', async ({ page }) => {
  await emit(page, { type: 'settings', settings: { soundOnComplete: false, notifyOnComplete: false } });
  await emit(page, { type: 'thinking_start', notificationOrigin: 'graph' }); await emit(page, { type: 'text_chunk', text: 'Synthetic all-clear' });
  await emit(page, { type: 'done', notificationOrigin: 'graph', pendingAgentChildren: 0, unknownAgentChildren: 0 });
  expect(await counts(page)).toEqual({ sound: 0, notify: 0 });
  await emit(page, { type: 'settings', settings: { soundOnComplete: true, notifyOnComplete: true } });
  await emit(page, { type: 'sessionLoaded', id: 'inventory', messages: [{ id: 'historical', role: 'assistant', content: 'Synthetic historical completion', outcome: 'success' }] });
  expect(await counts(page)).toEqual({ sound: 0, notify: 0 });
});
test('an accepted human answer restores alerts for the next Ask in the same graph-started turn', async ({ page }) => {
  const call = { id: 'first-choice', name: 'AskUserQuestion', input: { questions: [{ question: 'Choose section', header: 'Section', options: [{ label: 'Stock' }] }] } };
  await emit(page, { type: 'thinking_start', notificationOrigin: 'graph' }); await emit(page, { type: 'tool_start', call });
  expect(await counts(page)).toEqual({ sound: 0, notify: 0 });
  await emit(page, { type: 'tool_end', call: { ...call, result: 'Synthetic answer recorded' } });
  await emit(page, { type: 'tool_start', notificationOrigin: null, call: { ...call, id: 'second-choice' } });
  expect(await counts(page)).toEqual({ sound: 1, notify: 1 });
});
