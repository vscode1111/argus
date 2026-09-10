# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: stop-then-send-integration.spec.ts >> a send right after a manual stop starts a real turn instead of being swallowed
- Location: e2e\stop-then-send-integration.spec.ts:41:5

# Error details

```
Error: a new CLI should be spawned; saw: []

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | import * as fs from 'fs';
  3  | import * as os from 'os';
  4  | import * as path from 'path';
  5  | import { WebSocket } from 'ws';
  6  | 
  7  | // A message sent immediately after a manual stop must start a real turn.
  8  | //
  9  | // The regression: `stop` killed the CLI but left s.currentProc set, and `close`
  10 | // arrives a beat later - so for that window the dying proc still had a writable
  11 | // stdin, and the next send was taken for a mid-turn inject (or reused the proc),
  12 | // wrote into a pipe nobody reads, and the turn ended on the pending close with no
  13 | // output. Timing-dependent, so the user saw it only "sometimes".
  14 | //
  15 | // Driven over a raw WS rather than the UI: the race lives entirely in the server,
  16 | // and a browser round trip would add exactly the delay that hides it. Runs against
  17 | // the shared :3001 e2e server in its own temp workspace dir, which is its own
  18 | // channel, so it cannot disturb another spec.
  19 | test.describe.configure({ mode: 'serial' });
  20 | 
  21 | // Two real CLI turns (one long enough to interrupt, one to answer) do not fit the
  22 | // global 30s. Justified per-test exception - see !notes/common/e2e-testing.md.
  23 | test.setTimeout(90_000);
  24 | 
  25 | // Playwright's webServer readiness check watches Vite on :5173, while the backend on
  26 | // :3001 comes up alongside it - so a spec that talks to :3001 directly (rather than
  27 | // through a page) can start before it is listening. Poll instead of assuming.
  28 | async function nonce(): Promise<string> {
  29 |   let last: unknown;
  30 |   for (let i = 0; i < 60; i++) {
  31 |     try {
  32 |       const res = await fetch('http://localhost:3001/nonce');
  33 |       if (res.ok) return (await res.text()).trim();
  34 |       last = `HTTP ${res.status}`;
  35 |     } catch (err) { last = err; }
  36 |     await new Promise(r => setTimeout(r, 500));
  37 |   }
  38 |   throw new Error(`backend on :3001 never became ready: ${last}`);
  39 | }
  40 | 
  41 | test('a send right after a manual stop starts a real turn instead of being swallowed', async () => {
  42 |   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-stop-send-'));
  43 |   const ws = new WebSocket(`ws://localhost:3001/agent?nonce=${await nonce()}&dir=${encodeURIComponent(dir)}`, {
  44 |     origin: 'http://localhost:5173',
  45 |   });
  46 |   await new Promise<void>((res, rej) => {
  47 |     ws.on('open', () => res());
  48 |     ws.on('error', (err) => rej(new Error(`WS connect failed: ${err.message}`)));
  49 |   });
  50 | 
  51 |   const state = { textChunks: 0, started: false, done: false, injected: false, logs: [] as string[] };
  52 |   ws.on('message', (m) => {
  53 |     const e = JSON.parse(m.toString());
  54 |     if (e.type === 'text_chunk') state.textChunks++;
  55 |     else if (e.type === 'log') state.logs.push(String(e.text));
  56 |     else if (e.type === 'user_inject') state.injected = true;
  57 |     else if (e.type === 'thinking_start') state.started = true;
  58 |     // `done` counts only once the turn it belongs to has begun: the stop broadcasts
  59 |     // its own `done` immediately, and mistaking that for the next turn's ending
  60 |     // makes this test pass on the broken code.
  61 |     else if (e.type === 'done' && state.started) state.done = true;
  62 |   });
  63 |   const until = async (cond: () => boolean, ms: number) => {
  64 |     const end = Date.now() + ms;
  65 |     while (Date.now() < end && !cond()) await new Promise(r => setTimeout(r, 100));
  66 |     return cond();
  67 |   };
  68 | 
  69 |   try {
  70 |     // A first turn that is still streaming when we interrupt it.
  71 |     ws.send(JSON.stringify({ type: 'send', text: 'Count from 1 to 400, one number per line, no commentary.' }));
  72 |     expect(await until(() => state.textChunks > 0, 60_000), 'first turn should start streaming').toBe(true);
  73 | 
  74 |     // Stop and send again in the same tick - the window the bug lived in.
  75 |     state.started = false; state.done = false; state.textChunks = 0; state.injected = false; state.logs = [];
  76 |     ws.send(JSON.stringify({ type: 'stop' }));
  77 |     ws.send(JSON.stringify({ type: 'send', text: 'Reply with exactly: PROBE-OK' }));
  78 | 
  79 |     // It must be a fresh spawn, not an inject into (or reuse of) the killed process.
  80 |     expect(await until(() => state.textChunks > 0, 60_000), 'second turn should produce output').toBe(true);
  81 |     expect(state.injected, 'the message must not be swallowed as a mid-turn inject').toBe(false);
  82 |     const notable = state.logs.filter(l => /Spawning claude|Reusing claude|Mid-turn inject|exited with code/.test(l));
> 83 |     expect(notable.some(l => l.includes('Spawning claude')), `a new CLI should be spawned; saw: ${JSON.stringify(notable)}`).toBe(true);
     |                                                                                                                              ^ Error: a new CLI should be spawned; saw: []
  84 |     expect(notable.some(l => l.includes('Reusing claude process')), 'the killed proc must not be reused').toBe(false);
  85 |     expect(await until(() => state.done, 60_000), 'second turn should finish normally').toBe(true);
  86 |   } finally {
  87 |     ws.close();
  88 |     try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  89 |   }
  90 | });
  91 | 
```