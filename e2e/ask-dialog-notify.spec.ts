import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

const ASK_TOOL_INPUT = {
  questions: [
    {
      question: 'Which approach?',
      header: 'Approach',
      multiSelect: false,
      options: [
        { label: 'Option A', description: 'First' },
        { label: 'Option B', description: 'Second' },
      ],
    },
  ],
};

test.describe('AskUserQuestion notifications', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('argus.showTimer', 'true');
      localStorage.setItem('argus.soundOnComplete', 'true');
    });
    await waitForApp(page);
  });

  test('timer hides idle time while AskUserQuestion is pending', async ({ page }) => {
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'Let me ask.' });
    await send(page, { type: 'tool_start', call: { id: 'ask1', name: 'AskUserQuestion', input: ASK_TOOL_INPUT } });

    const dialog = page.locator('[class*="askDialog"]');
    await expect(dialog).toBeVisible();

    const timer = page.locator('[class*="responseTime"]');
    await expect(timer).toBeVisible();

    // Wait for idle time to accumulate
    await page.waitForTimeout(2000);

    const timerText = await timer.textContent();
    // Timer should show elapsed time but NO idle counter in parentheses
    expect(timerText).toMatch(/^\d+s$/);
    expect(timerText).not.toMatch(/\(\d+s\)/);
  });

  test('timer idle counter returns after AskUserQuestion is answered', async ({ page }) => {
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'tool_start', call: { id: 'ask1', name: 'AskUserQuestion', input: ASK_TOOL_INPUT } });

    const dialog = page.locator('[class*="askDialog"]');
    await expect(dialog).toBeVisible();

    // Answer the question
    await send(page, {
      type: 'tool_end',
      call: { id: 'ask1', name: 'AskUserQuestion', input: ASK_TOOL_INPUT, result: JSON.stringify({ answers: { 'Which approach?': 'Option A' } }) },
    });

    // Wait for idle to accumulate after answer
    await page.waitForTimeout(2000);

    const timer = page.locator('[class*="responseTime"]');
    const timerText = await timer.textContent();
    // Idle counter should be back
    expect(timerText).toMatch(/\(\d+s\)/);
  });

  test('completion sound plays when AskUserQuestion appears', async ({ page }) => {
    // Track AudioContext creation
    await page.evaluate(() => {
      (window as any).__audioContextCreated = false;
      const OrigAudioContext = window.AudioContext;
      (window as any).AudioContext = class extends OrigAudioContext {
        constructor() {
          super();
          (window as any).__audioContextCreated = true;
        }
      };
    });

    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'tool_start', call: { id: 'ask1', name: 'AskUserQuestion', input: ASK_TOOL_INPUT } });

    const dialog = page.locator('[class*="askDialog"]');
    await expect(dialog).toBeVisible();

    const soundPlayed = await page.evaluate(() => (window as any).__audioContextCreated);
    expect(soundPlayed).toBe(true);
  });

  test('sound does not play twice for the same AskUserQuestion', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__audioCount = 0;
      const OrigAudioContext = window.AudioContext;
      (window as any).AudioContext = class extends OrigAudioContext {
        constructor() {
          super();
          (window as any).__audioCount++;
        }
      };
    });

    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'tool_start', call: { id: 'ask1', name: 'AskUserQuestion', input: ASK_TOOL_INPUT } });

    const dialog = page.locator('[class*="askDialog"]');
    await expect(dialog).toBeVisible();

    // Wait a bit to ensure no duplicate triggers
    await page.waitForTimeout(500);

    const count = await page.evaluate(() => (window as any).__audioCount);
    expect(count).toBe(1);
  });
});
