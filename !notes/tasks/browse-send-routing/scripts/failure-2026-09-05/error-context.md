# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: browse-send-routing-integration.spec.ts >> send while browsing another session (integration) >> a client watching the live session never sees the browsed send
- Location: e2e\browse-send-routing-integration.spec.ts:138:7

# Error details

```
Error: timed out after 15000ms waiting for the watcher to sync
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import { WebSocket } from 'ws';
  3   | import * as fs from 'fs';
  4   | import * as os from 'os';
  5   | import * as path from 'path';
  6   | 
  7   | // A send issued while the client is BROWSING another session must start a turn on the
  8   | // session it is looking at - not be injected into the stdin of the turn still running
  9   | // in the entry it navigated away from.
  10  | //
  11  | // The bug: handleSend only ever receives the entry state, never the ws, so it could not
  12  | // tell a browsing client from a live one and took its mid-turn-inject branch purely
  13  | // because the entry had a live proc. The text landed in the OTHER session's turn, where
  14  | // every client watching that session saw it appear as an inject bubble.
  15  | //
  16  | // Integration because "browsing" only exists while a real CLI process is mid-turn:
  17  | // handleResumeSession computes isBrowsing from `currentProc && !cliDone`, so there is no
  18  | // way to reach this state without spawning one.
  19  | 
  20  | // Defaults to the shared dev server the integration project runs against. The override
  21  | // exists so this spec can be verified against a throwaway server on a private port
  22  | // without stopping a dev server someone is working in (see the task notes).
  23  | const PORT = process.env.ARGUS_E2E_PORT ?? '3001';
  24  | const BACKEND = `http://localhost:${PORT}`;
  25  | 
  26  | // Long enough that the turn is still streaming while we browse away and send.
  27  | const LONG_PROMPT = 'List the numbers from 1 to 400, each on its own line. No other text.';
  28  | const BROWSED_TEXT = 'scub-browsed-send';
  29  | 
  30  | async function getNonce(): Promise<string> {
  31  |   const res = await fetch(`${BACKEND}/nonce`);
  32  |   return (await res.text()).trim();
  33  | }
  34  | 
  35  | function makeTempDir(tag: string): string {
  36  |   const dir = path.join(os.tmpdir(), `argus-browse-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  37  |   fs.mkdirSync(dir, { recursive: true });
  38  |   return dir;
  39  | }
  40  | 
  41  | function openClient(nonce: string, dir: string): Promise<WebSocket> {
  42  |   return new Promise((resolve, reject) => {
  43  |     const url = `ws://localhost:${PORT}/agent?nonce=${encodeURIComponent(nonce)}&dir=${encodeURIComponent(dir)}`;
  44  |     const ws = new WebSocket(url, { origin: 'http://localhost:5173' });
  45  |     ws.on('open', () => resolve(ws));
  46  |     ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade failed: ${res.statusCode}`)));
  47  |     ws.on('error', reject);
  48  |   });
  49  | }
  50  | 
  51  | function closeClient(ws: WebSocket): Promise<void> {
  52  |   return new Promise((resolve) => {
  53  |     if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
  54  |     ws.on('close', () => resolve());
  55  |     ws.close();
  56  |   });
  57  | }
  58  | 
  59  | type Msg = Record<string, unknown>;
  60  | 
  61  | // Records every frame the client receives, so an assertion can be made about what did
  62  | // NOT arrive as well as what did.
  63  | function record(ws: WebSocket): Msg[] {
  64  |   const seen: Msg[] = [];
  65  |   ws.on('message', (data: Buffer) => {
  66  |     try { seen.push(JSON.parse(data.toString()) as Msg); } catch { /* non-JSON */ }
  67  |   });
  68  |   return seen;
  69  | }
  70  | 
  71  | async function waitForMsg(seen: Msg[], pred: (m: Msg) => boolean, timeoutMs: number, what: string): Promise<Msg> {
  72  |   const deadline = Date.now() + timeoutMs;
  73  |   while (Date.now() < deadline) {
  74  |     const hit = seen.find(pred);
  75  |     if (hit) return hit;
  76  |     await new Promise(r => setTimeout(r, 100));
  77  |   }
> 78  |   throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
      |         ^ Error: timed out after 15000ms waiting for the watcher to sync
  79  | }
  80  | 
  81  | function send(ws: WebSocket, msg: Msg): void {
  82  |   ws.send(JSON.stringify(msg));
  83  | }
  84  | 
  85  | test.describe('send while browsing another session (integration)', () => {
  86  |   // Three real CLI turns (a short one to create the second session, a long one to browse
  87  |   // away from, and the turn the browsed send must start) do not fit the flat 30s budget.
  88  |   test.setTimeout(90_000);
  89  | 
  90  |   test('the send starts a turn on the browsed session instead of injecting into the live one', async () => {
  91  |     const nonce = await getNonce();
  92  |     const dir = makeTempDir('routing');
  93  |     const ws = await openClient(nonce, dir);
  94  |     const seen = record(ws);
  95  | 
  96  |     try {
  97  |       // 1. A short turn, so the workspace has a second session on disk to browse to.
  98  |       send(ws, { type: 'send', text: 'Reply with exactly: ok' });
  99  |       const firstId = await waitForMsg(seen, m => m.type === 'sessionId' && !!m.id, 30_000, 'the first session id');
  100 |       const browsedId = String(firstId.id);
  101 |       await waitForMsg(seen, m => m.type === 'done', 45_000, 'the first turn to finish');
  102 | 
  103 |       // 2. A fresh session, then a long turn that will still be streaming below.
  104 |       send(ws, { type: 'newSession' });
  105 |       seen.length = 0;
  106 |       send(ws, { type: 'send', text: LONG_PROMPT });
  107 |       const liveId = await waitForMsg(seen, m => m.type === 'sessionId' && !!m.id, 30_000, 'the live session id');
  108 |       expect(String(liveId.id)).not.toBe(browsedId);
  109 | 
  110 |       // 3. Browse to the finished session while the long turn runs. This is the state
  111 |       //    that used to mis-route: the entry still points at the streaming session.
  112 |       send(ws, { type: 'resumeSession', id: browsedId });
  113 |       await waitForMsg(seen, m => m.type === 'sessionLoaded' && m.id === browsedId, 15_000, 'the browsed transcript');
  114 | 
  115 |       seen.length = 0;
  116 |       send(ws, { type: 'send', text: BROWSED_TEXT });
  117 | 
  118 |       // The send must open a normal turn: the text echoes back as a user message and a
  119 |       // new turn begins. Under the bug this client received neither - it was gated out
  120 |       // of the entry it had been injected into.
  121 |       await waitForMsg(
  122 |         seen,
  123 |         m => m.type === 'message' && (m.message as Msg | undefined)?.content === BROWSED_TEXT,
  124 |         20_000,
  125 |         'the user message echo',
  126 |       );
  127 |       await waitForMsg(seen, m => m.type === 'thinking_start', 20_000, 'a new turn to start');
  128 | 
  129 |       // And it must never have taken the mid-turn-inject branch.
  130 |       const injects = seen.filter(m => m.type === 'user_inject');
  131 |       expect(injects, 'a browsed send must not be injected into the live turn').toHaveLength(0);
  132 |     } finally {
  133 |       send(ws, { type: 'stop' });
  134 |       await closeClient(ws);
  135 |     }
  136 |   });
  137 | 
  138 |   test('a client watching the live session never sees the browsed send', async () => {
  139 |     const nonce = await getNonce();
  140 |     const dir = makeTempDir('leak');
  141 |     const browser = await openClient(nonce, dir);
  142 |     const seenBrowser = record(browser);
  143 | 
  144 |     try {
  145 |       // Create a second session to browse to, then start the long turn.
  146 |       send(browser, { type: 'send', text: 'Reply with exactly: ok' });
  147 |       const firstId = await waitForMsg(seenBrowser, m => m.type === 'sessionId' && !!m.id, 30_000, 'the first session id');
  148 |       const browsedId = String(firstId.id);
  149 |       await waitForMsg(seenBrowser, m => m.type === 'done', 45_000, 'the first turn to finish');
  150 | 
  151 |       send(browser, { type: 'newSession' });
  152 |       seenBrowser.length = 0;
  153 |       send(browser, { type: 'send', text: LONG_PROMPT });
  154 |       await waitForMsg(seenBrowser, m => m.type === 'sessionId' && !!m.id, 30_000, 'the live session id');
  155 | 
  156 |       // A second client joins the entry running that turn - this is the window that
  157 |       // showed the stray prompt in the bug report.
  158 |       const watcher = await openClient(nonce, dir);
  159 |       const seenWatcher = record(watcher);
  160 |       await waitForMsg(seenWatcher, m => m.type === 'sessionLoaded' || m.type === 'thinking_start', 15_000, 'the watcher to sync');
  161 | 
  162 |       // The first client browses away and sends.
  163 |       send(browser, { type: 'resumeSession', id: browsedId });
  164 |       await waitForMsg(seenBrowser, m => m.type === 'sessionLoaded' && m.id === browsedId, 15_000, 'the browsed transcript');
  165 |       seenWatcher.length = 0;
  166 |       send(browser, { type: 'send', text: BROWSED_TEXT });
  167 | 
  168 |       // Give the send time to be mis-routed before concluding it was not.
  169 |       await new Promise(r => setTimeout(r, 4_000));
  170 |       const leaked = seenWatcher.filter(
  171 |         m => (m.type === 'user_inject' && m.text === BROWSED_TEXT)
  172 |           || (m.type === 'message' && (m.message as Msg | undefined)?.content === BROWSED_TEXT),
  173 |       );
  174 |       expect(leaked, 'the browsed send must not reach the live session').toHaveLength(0);
  175 | 
  176 |       send(watcher, { type: 'stop' });
  177 |       await closeClient(watcher);
  178 |     } finally {
```