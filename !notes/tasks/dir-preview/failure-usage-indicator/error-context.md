# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: usage-indicator-integration.spec.ts >> usage indicator (integration) >> a modal fetch becomes the snapshot every other client reads
- Location: e2e\usage-indicator-integration.spec.ts:105:7

# Error details

```
Error: no accountUsage frame within 20000ms
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import { WebSocket } from 'ws';
  3   | import * as fs from 'fs';
  4   | import * as os from 'os';
  5   | import * as path from 'path';
  6   | import { waitForApp } from './helpers';
  7   | import {
  8   |   ensureCompiled,
  9   |   startDaemon,
  10  |   stopDaemon,
  11  |   readInfo,
  12  |   uniqueDaemonFile,
  13  |   type DaemonHandle,
  14  | } from './daemonHelpers';
  15  | 
  16  | // The header usage indicator against the real backend. The mock spec proves the
  17  | // rendering; this proves the wiring the mock cannot see - that `getUsageLimits`
  18  | // really reaches the server and comes back as a `usageLimits` frame, and that the
  19  | // header fills in from that reply with no injection.
  20  | 
  21  | const BACKEND = 'http://localhost:3001';
  22  | 
  23  | async function getNonce(): Promise<string> {
  24  |   const res = await fetch(`${BACKEND}/nonce`);
  25  |   return (await res.text()).trim();
  26  | }
  27  | 
  28  | function openClient(nonce: string): Promise<WebSocket> {
  29  |   return new Promise((resolve, reject) => {
  30  |     const ws = new WebSocket(`ws://localhost:3001/agent?nonce=${nonce}`, { origin: 'http://localhost:5173' });
  31  |     ws.on('open', () => resolve(ws));
  32  |     ws.on('unexpected-response', (_req, res) => reject(new Error('upgrade failed: ' + res.statusCode)));
  33  |     ws.on('error', reject);
  34  |   });
  35  | }
  36  | 
  37  | // Wait for the first frame of a given type, or reject on timeout.
  38  | function waitForFrame(ws: WebSocket, type: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  39  |   return new Promise((resolve, reject) => {
> 40  |     const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`no ${type} frame within ${timeoutMs}ms`)); }, timeoutMs);
      |                                                                       ^ Error: no accountUsage frame within 20000ms
  41  |     function onMsg(raw: Buffer) {
  42  |       let msg: Record<string, unknown>;
  43  |       try { msg = JSON.parse(raw.toString()); } catch { return; }
  44  |       if (msg.type !== type) return;
  45  |       clearTimeout(timer);
  46  |       ws.off('message', onMsg);
  47  |       resolve(msg);
  48  |     }
  49  |     ws.on('message', onMsg);
  50  |   });
  51  | }
  52  | 
  53  | // Whether the live usage API can answer right now, so a test can skip instead of
  54  | // flaking - the endpoint rate-limits aggressively (HTTP 429).
  55  | async function liveUsageAvailable(): Promise<boolean> {
  56  |   try {
  57  |     const p = path.join(os.homedir(), '.claude', '.credentials.json');
  58  |     const token = JSON.parse(fs.readFileSync(p, 'utf8'))?.claudeAiOauth?.accessToken;
  59  |     if (!token) return false;
  60  |     const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
  61  |       headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
  62  |       signal: AbortSignal.timeout(10_000),
  63  |     });
  64  |     if (!res.ok) return false;
  65  |     const data = (await res.json()) as { limits?: unknown[] };
  66  |     return Array.isArray(data.limits) && data.limits.length > 0;
  67  |   } catch {
  68  |     return false;
  69  |   }
  70  | }
  71  | 
  72  | test.describe('usage indicator (integration)', () => {
  73  |   // The round trip itself, independent of whether the API is healthy: one request
  74  |   // gets exactly one reply carrying a windows array (empty + `error` when the fetch
  75  |   // failed). Asserting only the happy path would make a wiring regression look like
  76  |   // a rate limit.
  77  |   test('getUsageLimits is answered with a usageLimits frame', async () => {
  78  |     const ws = await openClient(await getNonce());
  79  |     try {
  80  |       ws.send(JSON.stringify({ type: 'getUsageLimits' }));
  81  |       const msg = await waitForFrame(ws, 'usageLimits');
  82  |       expect(Array.isArray(msg.windows)).toBe(true);
  83  |       expect(typeof msg.fetchedAt).toBe('number');
  84  | 
  85  |       const windows = msg.windows as Array<Record<string, unknown>>;
  86  |       if (windows.length === 0) {
  87  |         // No data is only acceptable with a stated reason.
  88  |         expect(typeof msg.error).toBe('string');
  89  |       } else {
  90  |         for (const w of windows) {
  91  |           expect(typeof w.rateLimitType).toBe('string');
  92  |           expect(typeof w.utilization).toBe('number');
  93  |           expect(w.utilization as number).toBeGreaterThanOrEqual(0);
  94  |           expect(w.utilization as number).toBeLessThanOrEqual(1);
  95  |         }
  96  |       }
  97  |     } finally {
  98  |       ws.close();
  99  |     }
  100 |   });
  101 | 
  102 |   // Opening the Account & Usage modal fetches usage for that one client. The server adopts
  103 |   // those windows as the shared snapshot, so every other panel's indicator matches what the
  104 |   // modal shows instead of keeping an older copy.
  105 |   test('a modal fetch becomes the snapshot every other client reads', async () => {
  106 |     const nonce = await getNonce();
  107 |     const opener = await openClient(nonce);
  108 |     const other = await openClient(nonce);
  109 |     try {
  110 |       opener.send(JSON.stringify({ type: 'getAccountUsage', force: true }));
  111 |       // The reply arrives in two phases; the second carries the windows.
  112 |       let windows: Array<Record<string, unknown>> = [];
  113 |       for (let i = 0; i < 3 && windows.length === 0; i++) {
  114 |         const msg = await waitForFrame(opener, 'accountUsage');
  115 |         if (msg.usagePending) continue;
  116 |         windows = (msg.rateLimits as Array<Record<string, unknown>>) ?? [];
  117 |       }
  118 |       test.skip(windows.length === 0, 'live usage API unavailable (rate limited / offline)');
  119 | 
  120 |       // The other client now reads that same fetch: same windows, and data already older
  121 |       // than its own request, which an on-request fallback fetch could not produce.
  122 |       const reqAt = Date.now();
  123 |       other.send(JSON.stringify({ type: 'getUsageLimits' }));
  124 |       const snap = await waitForFrame(other, 'usageLimits');
  125 |       expect((snap.windows as unknown[]).length).toBe(windows.length);
  126 |       expect(reqAt - (snap.fetchedAt as number)).toBeGreaterThan(0);
  127 |       expect((snap.windows as Array<Record<string, unknown>>).map(w => w.rateLimitType))
  128 |         .toEqual(windows.map(w => w.rateLimitType));
  129 |     } finally {
  130 |       opener.close();
  131 |       other.close();
  132 |     }
  133 |   });
  134 | 
  135 |   test('the header indicator fills in from the server, with no injected data', async ({ page }) => {
  136 |     test.skip(!(await liveUsageAvailable()), 'live usage API unavailable (rate limited / offline)');
  137 | 
  138 |     // The real app on '/' (no ?mock=1), so getUsageLimits actually reaches the backend.
  139 |     await waitForApp(page);
  140 | 
```