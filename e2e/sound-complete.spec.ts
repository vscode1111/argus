import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

declare global {
  interface Window { __soundPlays?: number }
}

function send(page: Page, data: object) {
  // Dispatch a synthetic extension message, then flush two RAFs so React commits
  // the update (and any completion effect) before resolving. Mirrors the helper
  // used by the other mock specs.
  return page.evaluate(
    (d) =>
      new Promise<void>((resolve) => {
        window.dispatchEvent(new MessageEvent('message', { data: d }));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
    data
  );
}

const soundPlays = (page: Page) => page.evaluate(() => window.__soundPlays ?? 0);

test.describe('sound on complete', () => {
  test.beforeEach(async ({ page }) => {
    // playCompletionSound() constructs one AudioContext per beep, so counting
    // constructions tells us whether the sound fired. Installed before the app
    // loads so the wrapped constructor is in place when the effect runs.
    await page.addInitScript(() => {
      window.__soundPlays = 0;
      const Orig = window.AudioContext
        || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Orig) return;
      function Spy(this: unknown) {
        window.__soundPlays = (window.__soundPlays ?? 0) + 1;
        return new Orig();
      }
      Spy.prototype = Orig.prototype;
      window.AudioContext = Spy as unknown as typeof AudioContext;
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext =
        Spy as unknown as typeof AudioContext;
    });
    await waitForApp(page);
  });

  test('plays the completion sound when a turn finishes successfully', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-sound-test' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'a response' });
    await send(page, { type: 'done' });

    await expect.poll(() => soundPlays(page)).toBeGreaterThan(0);
    await expect(page.locator('[class*="responseTimeSuccess"]')).toBeVisible();
  });

  test('does not play the sound when the turn is stopped', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-stop-test' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'partial' });

    await page.getByRole('button', { name: 'Stop' }).click();
    await send(page, { type: 'done' });

    await expect(page.locator('[class*="responseTimeStopped"]')).toBeVisible();
    expect(await soundPlays(page)).toBe(0);
  });

  test('dev "sound:play" action plays the sound directly', async ({ page }) => {
    await page.evaluate(() => window.dispatchEvent(new Event('argus:test-sound')));
    await expect.poll(() => soundPlays(page)).toBeGreaterThan(0);
  });
});
