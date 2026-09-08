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

  // The CLI wakes itself to report every finished background task, so a watch session is
  // made of turns the user never started: 156 of them in the reported session, each one
  // ringing the sound and raising an OS toast for work the user was already waiting on.
  // The turn must still *complete* (that is the background-waiting-forever fix); only the
  // alert is withheld. See !notes/tasks/bg-turn-completion-noise/notes.md.
  test('a turn the user did not start finishes silently', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-watch-ci' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'still waiting' });
    await send(page, { type: 'done', autonomous: true, pendingBackgroundTasks: 1 });

    // Finished like any other turn: committed, timer shown, nothing left streaming.
    await expect(page.locator('[class*="responseTime"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    expect(await soundPlays(page)).toBe(0);
  });

  // The end of the chain is the alert worth keeping: nothing is left to wake the CLI, so
  // this is the last thing the user will get (the build finished, CI is green). Silencing
  // it as well would suppress exactly the ping they were waiting through the watch for.
  test('the last autonomous turn, with nothing left pending, does ring', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-watch-ci' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'done', autonomous: true, pendingBackgroundTasks: 1 });
    expect(await soundPlays(page), 'mid-watch: another turn is coming').toBe(0);

    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'CI is green, all done.' });
    await send(page, { type: 'done', autonomous: true });

    await expect.poll(() => soundPlays(page)).toBeGreaterThan(0);
  });

  // Control: without it a build that simply never played the sound would pass the tests
  // above. A real send after an autonomous turn must ring again.
  test('a user-started turn after an autonomous one still plays the sound', async ({ page }) => {
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'done', autonomous: true, pendingBackgroundTasks: 1 });
    expect(await soundPlays(page)).toBe(0);

    await send(page, { type: 'message', message: { id: '2', role: 'user', content: 'scub-real-send' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'done watching' });
    await send(page, { type: 'done' });

    await expect.poll(() => soundPlays(page)).toBeGreaterThan(0);
  });

  test('dev "sound:play" action plays the sound directly', async ({ page }) => {
    await page.evaluate(() => window.dispatchEvent(new Event('argus:test-sound')));
    await expect.poll(() => soundPlays(page)).toBeGreaterThan(0);
  });
});
