# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: usage-indicator-integration.spec.ts >> usage indicator (integration) >> a modal fetch becomes the snapshot every other client reads
- Location: e2e\usage-indicator-integration.spec.ts:105:7

# Error details

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0
```

# Test source

```ts
  31  |     ws.on('open', () => resolve(ws));
  32  |     ws.on('unexpected-response', (_req, res) => reject(new Error('upgrade failed: ' + res.statusCode)));
  33  |     ws.on('error', reject);
  34  |   });
  35  | }
  36  | 
  37  | // Wait for the first frame of a given type, or reject on timeout.
  38  | function waitForFrame(ws: WebSocket, type: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  39  |   return new Promise((resolve, reject) => {
  40  |     const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`no ${type} frame within ${timeoutMs}ms`)); }, timeoutMs);
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
  111 |       // The reply arrives in two phases; the second carries the windows. The settled
  112 |       // frame is the answer whether or not it has any - looping until `windows` filled
  113 |       // waited for a third frame that the handler has no code to send, so a rate-limited
  114 |       // API (empty `rateLimits` plus `usageError`, the correct no-data reply) timed out
  115 |       // here instead of reaching the skip below. Measured: exactly two frames per request.
  116 |       let windows: Array<Record<string, unknown>> = [];
  117 |       for (let i = 0; i < 3; i++) {
  118 |         const msg = await waitForFrame(opener, 'accountUsage');
  119 |         if (msg.usagePending) continue;
  120 |         windows = (msg.rateLimits as Array<Record<string, unknown>>) ?? [];
  121 |         break;
  122 |       }
  123 |       test.skip(windows.length === 0, 'live usage API unavailable (rate limited / offline)');
  124 | 
  125 |       // The other client now reads that same fetch: same windows, and data already older
  126 |       // than its own request, which an on-request fallback fetch could not produce.
  127 |       const reqAt = Date.now();
  128 |       other.send(JSON.stringify({ type: 'getUsageLimits' }));
  129 |       const snap = await waitForFrame(other, 'usageLimits');
  130 |       expect((snap.windows as unknown[]).length).toBe(windows.length);
> 131 |       expect(reqAt - (snap.fetchedAt as number)).toBeGreaterThan(0);
      |                                                  ^ Error: expect(received).toBeGreaterThan(expected)
  132 |       expect((snap.windows as Array<Record<string, unknown>>).map(w => w.rateLimitType))
  133 |         .toEqual(windows.map(w => w.rateLimitType));
  134 |     } finally {
  135 |       opener.close();
  136 |       other.close();
  137 |     }
  138 |   });
  139 | 
  140 |   test('the header indicator fills in from the server, with no injected data', async ({ page }) => {
  141 |     test.skip(!(await liveUsageAvailable()), 'live usage API unavailable (rate limited / offline)');
  142 | 
  143 |     // The real app on '/' (no ?mock=1), so getUsageLimits actually reaches the backend.
  144 |     await waitForApp(page);
  145 | 
  146 |     const indicator = page.getByTestId('usage-indicator');
  147 |     await expect(indicator).toBeVisible({ timeout: 20_000 });
  148 | 
  149 |     const bars = indicator.locator('[data-window]');
  150 |     const count = await bars.count();
  151 |     expect(count).toBeGreaterThan(0);
  152 |     expect(count).toBeLessThanOrEqual(3);
  153 | 
  154 |     // Real percentages, and the session window sorts first like the modal's bars.
  155 |     for (const pct of await bars.evaluateAll(els => els.map(e => Number(e.getAttribute('data-percent'))))) {
  156 |       expect(Number.isFinite(pct)).toBe(true);
  157 |       expect(pct).toBeGreaterThanOrEqual(0);
  158 |       expect(pct).toBeLessThanOrEqual(100);
  159 |     }
  160 |     await expect(bars.first()).toHaveAttribute('data-window', 'five_hour');
  161 |     expect(await indicator.getAttribute('title')).toContain('Session (5hr):');
  162 |   });
  163 | });
  164 | 
  165 | // The daemon is the only process that polls. The dev server on :3001 above answers
  166 | // from the on-request fallback, so it cannot show this: here a real daemon is spawned
  167 | // with the poller enabled and asked for usage it was never asked to fetch.
  168 | test.describe('daemon usage poller (integration)', () => {
  169 |   test.describe.configure({ mode: 'serial' });
  170 | 
  171 |   let d: DaemonHandle | undefined;
  172 | 
  173 |   test.beforeAll(() => { ensureCompiled(); });
  174 |   test.afterEach(() => { stopDaemon(d); d = undefined; });
  175 | 
  176 |   function openWs(port: number, nonce: string): Promise<WebSocket> {
  177 |     const ws = new WebSocket(`ws://localhost:${port}/agent?nonce=${nonce}`);
  178 |     return new Promise((resolve, reject) => {
  179 |       ws.on('open', () => resolve(ws));
  180 |       ws.on('error', reject);
  181 |     });
  182 |   }
  183 | 
  184 |   // How old the returned data already was when we asked for it. The poller's snapshot
  185 |   // predates the request (it was fetched at daemon startup), while the on-request
  186 |   // fallback stamps the moment it answers - so age is what tells the two apart, not
  187 |   // an absolute cutoff: the startup poll is a network round trip and lands a few
  188 |   // hundred ms AFTER the daemon starts listening.
  189 |   const STALE_ENOUGH_MS = 1_500;
  190 | 
  191 |   async function usageAge(ws: WebSocket): Promise<{ age: number; count: number }> {
  192 |     const reqAt = Date.now();
  193 |     ws.send(JSON.stringify({ type: 'getUsageLimits' }));
  194 |     const msg = await waitForFrame(ws, 'usageLimits', 10_000);
  195 |     return { age: reqAt - (msg.fetchedAt as number), count: (msg.windows as unknown[]).length };
  196 |   }
  197 | 
  198 |   // Ask until the answer is the poller's snapshot rather than a fresh fallback fetch.
  199 |   async function servedFromSnapshot(ws: WebSocket, timeoutMs: number): Promise<boolean> {
  200 |     const deadline = Date.now() + timeoutMs;
  201 |     let last = { age: -1, count: 0 };
  202 |     while (Date.now() < deadline) {
  203 |       last = await usageAge(ws);
  204 |       if (last.count > 0 && last.age > STALE_ENOUGH_MS) return true;
  205 |       await new Promise(r => setTimeout(r, 500));
  206 |     }
  207 |     console.log(`last reply: ${last.count} windows, ${last.age}ms old at request time`);
  208 |     return false;
  209 |   }
  210 | 
  211 |   test('the daemon polls on its own and serves every client from that one fetch', async () => {
  212 |     test.skip(!(await liveUsageAvailable()), 'live usage API unavailable (rate limited / offline)');
  213 | 
  214 |     const file = uniqueDaemonFile('usage-poll');
  215 |     d = await startDaemon({ port: 4051, file, idleMs: 600_000, usagePoll: true });
  216 | 
  217 |     const a = await openWs(4051, readInfo(file).nonce);
  218 |     const b = await openWs(4051, readInfo(file).nonce);
  219 |     try {
  220 |       // Both clients read the same central snapshot - that is the "any number of
  221 |       // clients, one poller" claim.
  222 |       expect(await servedFromSnapshot(a, 15_000)).toBe(true);
  223 |       expect(await servedFromSnapshot(b, 15_000)).toBe(true);
  224 |     } finally {
  225 |       a.close();
  226 |       b.close();
  227 |     }
  228 |   });
  229 | 
  230 |   // Control: without the poller the same request is answered by a fetch made now, so
  231 |   // the test above is really detecting the poller and not just any usage reply.
```