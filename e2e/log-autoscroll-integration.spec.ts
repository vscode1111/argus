import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// The debug log panel must stay pinned to the bottom as entries stream in.
//
// Regression test for a bug where autoscroll worked at the start but broke
// mid-stream and never recovered: our own scrollIntoView fires its scroll event
// asynchronously, and when a burst of new log entries landed before that event
// was processed, handleScroll measured a large distance-from-bottom and wrongly
// flipped the "user scrolled up" flag, freezing the panel partway up. The fix
// only treats an actual upward scrollTop move as user takeover, so content growth
// and programmatic scrolls keep the list pinned.

const LOG_LIST = '[data-testid="log-list"]';

function bottomDistance(page: Page): Promise<number> {
  return page
    .locator(LOG_LIST)
    .evaluate((el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

test('debug log auto-scrolls to the bottom throughout a stream', async ({ page }) => {
  // Watches a whole real turn, and the prompt deliberately asks for 80 lines so there is
  // something to stream. A fresh session in this workspace starts at ~77k input tokens
  // (CLAUDE.md plus the CLI system prompt), so the turn runs well past the flat 30s once
  // generation is added (!notes/common/e2e-testing.md, timeout section).
  test.setTimeout(90_000);

  await waitForApp(page);

  // The log panel is shown by default (e2e/argus.json sets showLogs:true), so its
  // scroll container must be present.
  const logList = page.locator(LOG_LIST);
  await expect(logList).toBeVisible();

  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill(
    'Write the numbers from 1 to 80, one per line, nothing else. No code block, no commentary.'
  );
  await page.getByRole('button', { name: 'Send' }).click();

  const stopBtn = page.getByRole('button', { name: 'Stop' });
  await expect(stopBtn).toBeVisible({ timeout: 10_000 });

  // Sample the scroll position repeatedly while streaming. Autoscroll should keep
  // the list near the bottom; the generous threshold absorbs the brief window
  // between a burst render and the autoscroll effect firing.
  // Bounded so a stream that never ends fails on this assertion instead of running
  // out the test timeout with no explanation. The bound has to sit above what a real turn
  // costs and below the test timeout, or it stops being a stall detector and becomes the
  // thing that fails: at 15s it did exactly that, missing by 90ms on an 80-line answer.
  let worstMidStream = 0;
  const deadline = Date.now() + 60_000;
  while ((await stopBtn.count()) > 0) {
    expect(Date.now(), 'stream did not finish in time').toBeLessThan(deadline);
    worstMidStream = Math.max(worstMidStream, await bottomDistance(page));
    await page.waitForTimeout(250);
  }

  // Let any trailing entries and the final scroll settle.
  await page.waitForTimeout(500);

  const { scrollHeight, clientHeight } = await logList.evaluate((el: HTMLElement) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  const finalDist = await bottomDistance(page);

  // The stream must have produced enough log entries to overflow the panel,
  // otherwise the test proves nothing about scrolling.
  expect(scrollHeight).toBeGreaterThan(clientHeight + 200);

  // After settling, the panel is pinned to the bottom. The bug left it frozen
  // far up and never recovered, so this is the decisive check.
  expect(finalDist).toBeLessThan(50);

  // It also stayed reasonably close to the bottom for the whole stream.
  expect(worstMidStream).toBeLessThan(500);
});
