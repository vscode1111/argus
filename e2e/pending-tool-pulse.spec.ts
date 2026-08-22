import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// A tool call that never received a result must stop pulsing once its turn is over.
//
// `ToolCall` derived `pending` from `!result && !error` alone, which is right only while
// the turn is live. A committed message can hold a resultless tool for good: the `done`
// reducer's finalizeBlocks() only rewrites blocks in `state.streaming`, and a transcript
// replayed from disk (`sessionLoaded`) never went through it at all - so an interrupted
// last turn came back with its final tool pulsing green forever, as if still working.
//
// Mock, not integration: this is pure render logic off a message shape, and the shape is
// exactly what loadSession() produces for an interrupted turn.

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

const PULSING = '[class*="toolNamePending"]';

// An assistant turn whose last tool never came back - what a stopped session looks like
// once it has been replayed from disk.
function interruptedTurn(outcome: string) {
  return {
    id: 'replay-assistant',
    role: 'assistant',
    content: 'working on it',
    outcome,
    blocks: [
      { type: 'text', text: 'working on it' },
      { type: 'tool', call: { id: 't-done', name: 'Read', input: { file_path: '/tmp/scub-a.ts' }, result: 'file contents' } },
      { type: 'tool', call: { id: 't-hanging', name: 'Bash', input: { command: 'echo scub-hanging' } } },
    ],
  };
}

test.describe('pending tool pulse', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('a resultless tool in a finished turn does not pulse', async ({ page }) => {
    await send(page, {
      type: 'sessionLoaded',
      id: '44444444-4444-4444-4444-444444444444',
      messages: [
        { id: 'replay-user', role: 'user', content: 'scub-interrupted-question' },
        interruptedTurn('success'),
      ],
    });

    // The turn rendered, so the absence of a pulse below is a real assertion.
    await expect(page.getByText('scub-interrupted-question')).toBeVisible();
    await expect(page.locator('[class*="toolCall"]')).toHaveCount(2);
    await expect(page.locator(PULSING)).toHaveCount(0);
  });

  test('a stopped turn does not leave its last tool pulsing', async ({ page }) => {
    await send(page, {
      type: 'sessionLoaded',
      id: '55555555-5555-5555-5555-555555555555',
      messages: [
        { id: 'replay-user', role: 'user', content: 'scub-stopped-question' },
        interruptedTurn('stopped'),
      ],
    });

    await expect(page.getByText('scub-stopped-question')).toBeVisible();
    await expect(page.locator(PULSING)).toHaveCount(0);
  });

  test('a tool still running in a LIVE turn keeps pulsing', async ({ page }) => {
    // The control: without this, "nothing pulses ever" would pass both tests above.
    await send(page, { type: 'thinking_start' });
    await send(page, {
      type: 'tool_start',
      call: { id: 't-live', name: 'Bash', input: { command: 'echo scub-live' } },
    });

    await expect(page.locator('[class*="toolCall"]')).toHaveCount(1);
    await expect(page.locator(PULSING)).toHaveCount(1);

    // ...and stops as soon as the turn ends, without a result ever arriving.
    await send(page, { type: 'done' });
    await expect(page.locator(PULSING)).toHaveCount(0);
  });
});
