import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { waitForApp } from './helpers';

// The header usage indicator (three stacked bars) plus the gate that decides when the
// daemon's central poller runs.
//
// Two halves of one feature: the UI never fetches - it only renders what the daemon
// pushes as `usageLimits` - and the daemon only polls while there has been activity in
// the last hour. Both are covered here; `getUsageLimits` is in webview/index.html's
// MOCK_SUPPRESSED, so under ?mock=1 the injected pushes are the only data that lands.

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

const NOW_SEC = Math.floor(Date.now() / 1000);

// One window per colour tier, deliberately out of display order so a test that passes
// only because the server happened to sort them would fail.
const WINDOWS = [
  { rateLimitType: 'seven_day_fable', utilization: 0.36, resetsAt: NOW_SEC + 30 * 3600, label: 'Weekly Fable' },
  { rateLimitType: 'five_hour', utilization: 0.1, resetsAt: NOW_SEC + 2 * 3600 },
  { rateLimitType: 'seven_day', utilization: 0.7, resetsAt: NOW_SEC + 30 * 3600 },
];

const indicator = (page: Page) => page.getByTestId('usage-indicator');
const bars = (page: Page) => indicator(page).locator('[data-window]');

test.describe('header usage indicator', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  // It is the header's only entry to the Account & Usage modal, so it must stay
  // clickable with no data (before the first poll, or while the API is rate-limiting)
  // instead of drawing three dead grey lines or vanishing.
  test('with no usage yet it falls back to the account icon and still opens the modal', async ({ page }) => {
    await expect(indicator(page)).toBeVisible();
    await expect(bars(page)).toHaveCount(0);
    await expect(indicator(page)).toHaveAttribute('title', /not loaded yet/);

    await indicator(page).click();
    await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  });

  // An empty indicator was reported as "I don't see that feature", because nothing
  // said why. The server sends a reason with the empty list; the tooltip must show it.
  test('the fallback names the reason the server gave', async ({ page }) => {
    await send(page, { type: 'usageLimits', windows: [], error: 'rate limited (HTTP 429)', fetchedAt: Date.now() });

    await expect(bars(page)).toHaveCount(0);
    await expect(indicator(page)).toHaveAttribute('title', /rate limited \(HTTP 429\)/);
  });

  // ... and the fallback is replaced by real bars once data arrives, in place.
  test('a push replaces the fallback icon with bars', async ({ page }) => {
    await expect(bars(page)).toHaveCount(0);
    await send(page, { type: 'usageLimits', windows: WINDOWS, fetchedAt: Date.now() });
    await expect(bars(page)).toHaveCount(3);
    await expect(indicator(page).locator('svg')).toHaveCount(0);
  });

  test('the old separate Account & usage button is gone from the header', async ({ page }) => {
    // One control, not two: the indicator absorbed it. Guards against the button
    // creeping back in beside a widget that already opens the same modal.
    await expect(page.locator('.topRightActions').getByRole('button', { name: 'Account & usage' }))
      .toHaveCount(1);
  });

  test('a push renders one bar per window in display order', async ({ page }) => {
    await send(page, { type: 'usageLimits', windows: WINDOWS, fetchedAt: Date.now() });

    await expect(bars(page)).toHaveCount(3);
    // Session first, then the all-model week, then the model-scoped week.
    expect(await bars(page).evaluateAll(els => els.map(e => e.getAttribute('data-window'))))
      .toEqual(['five_hour', 'seven_day', 'seven_day_fable']);
    expect(await bars(page).evaluateAll(els => els.map(e => e.getAttribute('data-percent'))))
      .toEqual(['10', '70', '36']);
  });

  test('fill width and colour tier follow the percentage', async ({ page }) => {
    await send(page, {
      type: 'usageLimits',
      windows: [
        { rateLimitType: 'five_hour', utilization: 0.05 },   // base
        { rateLimitType: 'seven_day', utilization: 0.62 },   // medium
        { rateLimitType: 'seven_day_fable', utilization: 0.94 }, // high
      ],
      fetchedAt: Date.now(),
    });

    const widths = await bars(page).evaluateAll(els =>
      els.map(e => (e.firstElementChild as HTMLElement).style.width));
    expect(widths).toEqual(['5%', '62%', '94%']);

    // Same thresholds as the modal's full bars: <50 base, 50-89 medium, >=90 high.
    await expect(indicator(page).locator('[class*="fillMedium"]')).toHaveCount(1);
    await expect(indicator(page).locator('[class*="fillHigh"]')).toHaveCount(1);
    await expect(bars(page).nth(0).locator('[class*="fillMedium"], [class*="fillHigh"]')).toHaveCount(0);
  });

  test('at most three bars, dropping the lowest-priority window', async ({ page }) => {
    await send(page, {
      type: 'usageLimits',
      windows: [...WINDOWS, { rateLimitType: 'seven_day_sonnet', utilization: 0.5 }],
      fetchedAt: Date.now(),
    });

    await expect(bars(page)).toHaveCount(3);
    await expect(indicator(page).locator('[data-window="seven_day_sonnet"]')).toHaveCount(0);
  });

  test('the tooltip names each window with its percent and reset', async ({ page }) => {
    await send(page, { type: 'usageLimits', windows: WINDOWS, fetchedAt: Date.now() });

    const title = await indicator(page).getAttribute('title');
    expect(title).toContain('Session (5hr): 10%');
    expect(title).toContain('Weekly (7 day): 70%');
    // The server's own label wins for model-scoped windows.
    expect(title).toContain('Weekly Fable: 36%');
    expect(title).toContain('Resets in');
  });

  // The point of the central poller: the numbers move on their own, with no request
  // from this client and no modal open.
  test('a later push updates the bars in place', async ({ page }) => {
    await send(page, { type: 'usageLimits', windows: WINDOWS, fetchedAt: Date.now() });
    await expect(bars(page).nth(0)).toHaveAttribute('data-percent', '10');

    await send(page, {
      type: 'usageLimits',
      windows: WINDOWS.map(w => (w.rateLimitType === 'five_hour' ? { ...w, utilization: 0.93 } : w)),
      fetchedAt: Date.now(),
    });
    await expect(bars(page).nth(0)).toHaveAttribute('data-percent', '93');
    await expect(bars(page).nth(0).locator('[class*="fillHigh"]')).toHaveCount(1);
  });

  // The bar has to show how much room is left, not just the filled stub. This broke
  // once already: the track used --input-bg, which in the Dark 2026 theme is the exact
  // same colour as the surface behind it, so a 14% bar looked like a floating segment
  // with no sense of the full width. Equal-colour bugs are invisible to any assertion
  // about layout, so this one compares the computed colours directly.
  test('the unfilled part of a bar is visible against its surface', async ({ page }) => {
    await send(page, { type: 'usageLimits', windows: WINDOWS, fetchedAt: Date.now() });
    await expect(bars(page)).toHaveCount(3);

    const header = await page.evaluate(() => {
      const track = document.querySelector('[data-testid="usage-indicator"] [data-window]')!;
      return {
        track: getComputedStyle(track).backgroundColor,
        surface: getComputedStyle(track.parentElement!.parentElement!).backgroundColor,
      };
    });
    expect(header.track).not.toBe(header.surface);
    expect(header.track).not.toBe('rgba(0, 0, 0, 0)');

    // Same track, full-size, in the modal the indicator opens.
    await indicator(page).click();
    await send(page, {
      type: 'accountUsage',
      account: { loggedIn: true, authMethod: 'claude.ai', email: 'scub@example.com', subscriptionType: 'max' },
      rateLimits: WINDOWS,
      usagePending: false,
    });
    const modalTrack = page.locator('[class*="progressTrack"]').first();
    await expect(modalTrack).toBeVisible();
    const modal = await page.evaluate(() => {
      const track = document.querySelector('[class*="progressTrack"]')!;
      return {
        track: getComputedStyle(track).backgroundColor,
        surface: getComputedStyle(track.closest('[role="dialog"]')!).backgroundColor,
      };
    });
    expect(modal.track).not.toBe(modal.surface);
    expect(modal.track).not.toBe('rgba(0, 0, 0, 0)');
  });

  // The modal fetches usage itself, so without a sync its bars and the header's can show
  // different numbers side by side - which is exactly how this was reported.
  test('opening the modal syncs the header indicator to what the modal shows', async ({ page }) => {
    await send(page, { type: 'usageLimits', windows: WINDOWS, fetchedAt: Date.now() });
    await expect(bars(page).nth(1)).toHaveAttribute('data-percent', '70');

    // The modal's own reply carries fresher numbers (the weekly window moved on).
    await indicator(page).click();
    await send(page, {
      type: 'accountUsage',
      account: { loggedIn: true, authMethod: 'claude.ai', email: 'scub@example.com', subscriptionType: 'max' },
      rateLimits: WINDOWS.map(w => (w.rateLimitType === 'seven_day' ? { ...w, utilization: 0.72 } : w)),
      usagePending: false,
    });

    await expect(bars(page).nth(1)).toHaveAttribute('data-percent', '72');
    // ... and the modal renders the same value, not a competing one.
    await expect(page.locator('[class*="usageRow"]', { hasText: 'Weekly (7 day)' })
      .locator('[class*="usagePercent"]')).toHaveText('72%');
  });

  // The other direction: a push while the modal is open (the poller ticked, or another
  // panel refreshed) must reach the modal too, or it freezes at its opening values.
  test('a push while the modal is open updates the modal as well as the header', async ({ page }) => {
    await indicator(page).click();
    await send(page, {
      type: 'accountUsage',
      account: { loggedIn: true, authMethod: 'claude.ai', email: 'scub@example.com', subscriptionType: 'max' },
      rateLimits: WINDOWS,
      usagePending: false,
    });
    await expect(page.locator('[class*="usageRow"]', { hasText: 'Weekly (7 day)' })
      .locator('[class*="usagePercent"]')).toHaveText('70%');

    await send(page, {
      type: 'usageLimits',
      windows: WINDOWS.map(w => (w.rateLimitType === 'seven_day' ? { ...w, utilization: 0.81 } : w)),
      fetchedAt: Date.now(),
    });

    await expect(page.locator('[class*="usageRow"]', { hasText: 'Weekly (7 day)' })
      .locator('[class*="usagePercent"]')).toHaveText('81%');
    await expect(bars(page).nth(1)).toHaveAttribute('data-percent', '81');
  });

  // An empty push means the fetch behind it failed (a reconnect landing on a 429). It
  // must not wipe numbers already on screen - the server keeps its own snapshot in that
  // case, and the client has to match or a blip blanks the header.
  test('an empty push does not blank bars that are already showing', async ({ page }) => {
    await send(page, { type: 'usageLimits', windows: WINDOWS, fetchedAt: Date.now() });
    await expect(bars(page)).toHaveCount(3);

    await indicator(page).click();
    await send(page, {
      type: 'accountUsage',
      account: { loggedIn: true, authMethod: 'claude.ai', email: 'scub@example.com', subscriptionType: 'max' },
      rateLimits: WINDOWS,
      usagePending: false,
    });
    await expect(page.locator('[class*="usageRow"]')).toHaveCount(3);

    await send(page, { type: 'usageLimits', windows: [], error: 'rate limited (HTTP 429)', fetchedAt: Date.now() });

    await expect(page.locator('[class*="usageRow"]')).toHaveCount(3);
    await expect(bars(page)).toHaveCount(3);
  });

  test('clicking it opens Account & usage', async ({ page }) => {
    await send(page, { type: 'usageLimits', windows: WINDOWS, fetchedAt: Date.now() });
    await indicator(page).click();
    await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  });
});

// The polling gate is a pure function taking the activity stamp and the clock, so it
// needs no daemon, no timers and no network - only the compiled bundle.
const ROOT = path.resolve(__dirname, '..');
const POLLER_JS = path.join(ROOT, 'out', 'backend', 'usagePoller.js');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_760_000_000_000; // fixed clock: pure function, nothing should vary

type PollerModule = {
  usagePollActive(lastActivityAt: number, now: number): boolean;
  usageRefreshDue(lastAttemptAt: number, now: number): boolean;
  publishUsageWindows(windows: Array<Record<string, unknown>>): void;
  requestUsageRefresh(): Promise<{ windows: Array<Record<string, unknown>>; fetchedAt: number; error?: string }>;
  getUsageSnapshot(): { windows: Array<Record<string, unknown>>; fetchedAt: number; error?: string };
  USAGE_POLL_INTERVAL_MS: number;
  USAGE_ACTIVE_WINDOW_MS: number;
  USAGE_MIN_REFRESH_MS: number;
};

test.describe('usage poll gate', () => {
  let mod: PollerModule;

  test.beforeAll(() => {
    if (!fs.existsSync(POLLER_JS)) execSync('yarn compile', { cwd: ROOT, stdio: 'ignore' });
    mod = require(POLLER_JS) as PollerModule;
  });

  test('one poll a minute, one hour of activity keeps it awake', () => {
    expect(mod.USAGE_POLL_INTERVAL_MS).toBe(MINUTE);
    expect(mod.USAGE_ACTIVE_WINDOW_MS).toBe(HOUR);
  });

  test('a process that has seen no activity never polls', () => {
    // 0 is "nothing has happened yet", not a very old stamp: without this the poller
    // would start hitting the API on a bare daemon launch that nobody ever used.
    expect(mod.usagePollActive(0, NOW)).toBe(false);
  });

  test('activity keeps polling alive for the whole hour', () => {
    expect(mod.usagePollActive(NOW, NOW)).toBe(true);
    expect(mod.usagePollActive(NOW - 59 * MINUTE, NOW)).toBe(true);
  });

  test('polling pauses once the hour of silence passes', () => {
    expect(mod.usagePollActive(NOW - HOUR - 1, NOW)).toBe(false);
    // ... and the same stamp was still live a couple of minutes earlier, so the test
    // pins the boundary rather than just "old enough".
    expect(mod.usagePollActive(NOW - HOUR - 1, NOW - 2 * MINUTE)).toBe(true);
  });

  // Clients cannot fetch usage themselves; they ask the server, and the server spends at
  // most one request per USAGE_MIN_REFRESH_MS however many panels ask. Without this floor
  // a row of open panels each clicking refresh is a burst straight into a 429.
  test('a refresh inside the floor is answered without calling the API', async () => {
    expect(mod.USAGE_MIN_REFRESH_MS).toBe(MINUTE);

    // Seed a snapshot, then stamp the attempt clock by taking one real refresh. That
    // single call is the only live request this spec makes (and on a rate-limited day it
    // returns the 429 immediately); everything after it is what the test proves does NOT
    // reach the API.
    mod.publishUsageWindows([{ rateLimitType: 'five_hour', utilization: 0.4 }]);
    const first = await mod.requestUsageRefresh();
    const at = mod.getUsageSnapshot().fetchedAt;

    // A burst of further requests must all be served from that same snapshot: no new
    // fetch, so the success stamp cannot move.
    const burst = await Promise.all([
      mod.requestUsageRefresh(), mod.requestUsageRefresh(), mod.requestUsageRefresh(),
    ]);
    for (const r of burst) expect(r.fetchedAt).toBe(at);
    expect(mod.getUsageSnapshot().fetchedAt).toBe(first.fetchedAt);
  });

  test('the floor is measured from the last attempt, not the last success', () => {
    // A failed attempt still pushes the next one out. Measuring from the last *success*
    // would let a user clicking refresh during a 429 retry on every click, deepening the
    // rate limit they are waiting out.
    expect(mod.usageRefreshDue(0, NOW)).toBe(true);              // never attempted
    expect(mod.usageRefreshDue(NOW - 30 * 1000, NOW)).toBe(false); // half a minute ago
    expect(mod.usageRefreshDue(NOW - MINUTE, NOW)).toBe(true);     // exactly at the floor
  });

  // The snapshot is what every client reads, and the modal's own fetch is published into
  // it so the two views cannot show different numbers. Exercised directly here because the
  // end-to-end version needs the live API, which rate-limits.
  test('published windows become the snapshot, and an empty publish is ignored', () => {
    const windows = [
      { rateLimitType: 'five_hour', utilization: 0.2 },
      { rateLimitType: 'seven_day', utilization: 0.72 },
    ];
    mod.publishUsageWindows(windows);
    const after = mod.getUsageSnapshot();
    expect(after.windows).toEqual(windows);
    expect(after.fetchedAt).toBeGreaterThan(0);

    // A failed fetch elsewhere must not wipe what everyone is reading.
    mod.publishUsageWindows([]);
    expect(mod.getUsageSnapshot().windows).toEqual(windows);
    expect(mod.getUsageSnapshot().fetchedAt).toBe(after.fetchedAt);
  });
});
