import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { waitForApp } from './helpers';
import {
  ensureCompiled,
  startDaemon,
  stopDaemon,
  readInfo,
  uniqueDaemonFile,
  type DaemonHandle,
} from './daemonHelpers';

// The header usage indicator against the real backend. The mock spec proves the
// rendering; this proves the wiring the mock cannot see - that `getUsageLimits`
// really reaches the server and comes back as a `usageLimits` frame, and that the
// header fills in from that reply with no injection.

const BACKEND = 'http://localhost:3001';

async function getNonce(): Promise<string> {
  const res = await fetch(`${BACKEND}/nonce`);
  return (await res.text()).trim();
}

function openClient(nonce: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:3001/agent?nonce=${nonce}`, { origin: 'http://localhost:5173' });
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) => reject(new Error('upgrade failed: ' + res.statusCode)));
    ws.on('error', reject);
  });
}

// Wait for the first frame of a given type, or reject on timeout.
function waitForFrame(ws: WebSocket, type: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`no ${type} frame within ${timeoutMs}ms`)); }, timeoutMs);
    function onMsg(raw: Buffer) {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(msg);
    }
    ws.on('message', onMsg);
  });
}

// Whether the live usage API can answer right now, so a test can skip instead of
// flaking - the endpoint rate-limits aggressively (HTTP 429).
async function liveUsageAvailable(): Promise<boolean> {
  try {
    const p = path.join(os.homedir(), '.claude', '.credentials.json');
    const token = JSON.parse(fs.readFileSync(p, 'utf8'))?.claudeAiOauth?.accessToken;
    if (!token) return false;
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { limits?: unknown[] };
    return Array.isArray(data.limits) && data.limits.length > 0;
  } catch {
    return false;
  }
}

test.describe('usage indicator (integration)', () => {
  // The round trip itself, independent of whether the API is healthy: one request
  // gets exactly one reply carrying a windows array (empty + `error` when the fetch
  // failed). Asserting only the happy path would make a wiring regression look like
  // a rate limit.
  test('getUsageLimits is answered with a usageLimits frame', async () => {
    const ws = await openClient(await getNonce());
    try {
      ws.send(JSON.stringify({ type: 'getUsageLimits' }));
      const msg = await waitForFrame(ws, 'usageLimits');
      expect(Array.isArray(msg.windows)).toBe(true);
      expect(typeof msg.fetchedAt).toBe('number');

      const windows = msg.windows as Array<Record<string, unknown>>;
      if (windows.length === 0) {
        // No data is only acceptable with a stated reason.
        expect(typeof msg.error).toBe('string');
      } else {
        for (const w of windows) {
          expect(typeof w.rateLimitType).toBe('string');
          expect(typeof w.utilization).toBe('number');
          expect(w.utilization as number).toBeGreaterThanOrEqual(0);
          expect(w.utilization as number).toBeLessThanOrEqual(1);
        }
      }
    } finally {
      ws.close();
    }
  });

  // Opening the Account & Usage modal fetches usage for that one client. The server adopts
  // those windows as the shared snapshot, so every other panel's indicator matches what the
  // modal shows instead of keeping an older copy.
  test('a modal fetch becomes the snapshot every other client reads', async () => {
    const nonce = await getNonce();
    const opener = await openClient(nonce);
    const other = await openClient(nonce);
    try {
      opener.send(JSON.stringify({ type: 'getAccountUsage', force: true }));
      // The reply arrives in two phases; the second carries the windows.
      let windows: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 3 && windows.length === 0; i++) {
        const msg = await waitForFrame(opener, 'accountUsage');
        if (msg.usagePending) continue;
        windows = (msg.rateLimits as Array<Record<string, unknown>>) ?? [];
      }
      test.skip(windows.length === 0, 'live usage API unavailable (rate limited / offline)');

      // The other client now reads that same fetch: same windows, and data already older
      // than its own request, which an on-request fallback fetch could not produce.
      const reqAt = Date.now();
      other.send(JSON.stringify({ type: 'getUsageLimits' }));
      const snap = await waitForFrame(other, 'usageLimits');
      expect((snap.windows as unknown[]).length).toBe(windows.length);
      expect(reqAt - (snap.fetchedAt as number)).toBeGreaterThan(0);
      expect((snap.windows as Array<Record<string, unknown>>).map(w => w.rateLimitType))
        .toEqual(windows.map(w => w.rateLimitType));
    } finally {
      opener.close();
      other.close();
    }
  });

  test('the header indicator fills in from the server, with no injected data', async ({ page }) => {
    test.skip(!(await liveUsageAvailable()), 'live usage API unavailable (rate limited / offline)');

    // The real app on '/' (no ?mock=1), so getUsageLimits actually reaches the backend.
    await waitForApp(page);

    const indicator = page.getByTestId('usage-indicator');
    await expect(indicator).toBeVisible({ timeout: 20_000 });

    const bars = indicator.locator('[data-window]');
    const count = await bars.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(3);

    // Real percentages, and the session window sorts first like the modal's bars.
    for (const pct of await bars.evaluateAll(els => els.map(e => Number(e.getAttribute('data-percent'))))) {
      expect(Number.isFinite(pct)).toBe(true);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
    await expect(bars.first()).toHaveAttribute('data-window', 'five_hour');
    expect(await indicator.getAttribute('title')).toContain('Session (5hr):');
  });
});

// The daemon is the only process that polls. The dev server on :3001 above answers
// from the on-request fallback, so it cannot show this: here a real daemon is spawned
// with the poller enabled and asked for usage it was never asked to fetch.
test.describe('daemon usage poller (integration)', () => {
  test.describe.configure({ mode: 'serial' });

  let d: DaemonHandle | undefined;

  test.beforeAll(() => { ensureCompiled(); });
  test.afterEach(() => { stopDaemon(d); d = undefined; });

  function openWs(port: number, nonce: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${port}/agent?nonce=${nonce}`);
    return new Promise((resolve, reject) => {
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  // How old the returned data already was when we asked for it. The poller's snapshot
  // predates the request (it was fetched at daemon startup), while the on-request
  // fallback stamps the moment it answers - so age is what tells the two apart, not
  // an absolute cutoff: the startup poll is a network round trip and lands a few
  // hundred ms AFTER the daemon starts listening.
  const STALE_ENOUGH_MS = 1_500;

  async function usageAge(ws: WebSocket): Promise<{ age: number; count: number }> {
    const reqAt = Date.now();
    ws.send(JSON.stringify({ type: 'getUsageLimits' }));
    const msg = await waitForFrame(ws, 'usageLimits', 10_000);
    return { age: reqAt - (msg.fetchedAt as number), count: (msg.windows as unknown[]).length };
  }

  // Ask until the answer is the poller's snapshot rather than a fresh fallback fetch.
  async function servedFromSnapshot(ws: WebSocket, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let last = { age: -1, count: 0 };
    while (Date.now() < deadline) {
      last = await usageAge(ws);
      if (last.count > 0 && last.age > STALE_ENOUGH_MS) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`last reply: ${last.count} windows, ${last.age}ms old at request time`);
    return false;
  }

  test('the daemon polls on its own and serves every client from that one fetch', async () => {
    test.skip(!(await liveUsageAvailable()), 'live usage API unavailable (rate limited / offline)');

    const file = uniqueDaemonFile('usage-poll');
    d = await startDaemon({ port: 4051, file, idleMs: 600_000, usagePoll: true });

    const a = await openWs(4051, readInfo(file).nonce);
    const b = await openWs(4051, readInfo(file).nonce);
    try {
      // Both clients read the same central snapshot - that is the "any number of
      // clients, one poller" claim.
      expect(await servedFromSnapshot(a, 15_000)).toBe(true);
      expect(await servedFromSnapshot(b, 15_000)).toBe(true);
    } finally {
      a.close();
      b.close();
    }
  });

  // Control: without the poller the same request is answered by a fetch made now, so
  // the test above is really detecting the poller and not just any usage reply.
  test('a daemon with polling disabled answers only from the moment it is asked', async () => {
    const file = uniqueDaemonFile('usage-nopoll');
    d = await startDaemon({ port: 4052, file, idleMs: 600_000 });

    const ws = await openWs(4052, readInfo(file).nonce);
    try {
      // Wait out the window the test above needs to pass, so "no snapshot" is a real
      // finding and not just an answer that arrived too quickly to age.
      await new Promise(r => setTimeout(r, STALE_ENOUGH_MS + 1_000));
      const { age } = await usageAge(ws);
      expect(age).toBeLessThan(STALE_ENOUGH_MS);
    } finally {
      ws.close();
    }
  });
});
