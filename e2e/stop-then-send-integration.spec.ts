import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';

// A message sent immediately after a manual stop must start a real turn.
//
// The regression: `stop` killed the CLI but left s.currentProc set, and `close`
// arrives a beat later - so for that window the dying proc still had a writable
// stdin, and the next send was taken for a mid-turn inject (or reused the proc),
// wrote into a pipe nobody reads, and the turn ended on the pending close with no
// output. Timing-dependent, so the user saw it only "sometimes".
//
// Driven over a raw WS rather than the UI: the race lives entirely in the server,
// and a browser round trip would add exactly the delay that hides it. Runs against
// the shared :3001 e2e server in its own temp workspace dir, which is its own
// channel, so it cannot disturb another spec.
test.describe.configure({ mode: 'serial' });

// Two real CLI turns (one long enough to interrupt, one to answer) do not fit the
// global 30s. Justified per-test exception - see !notes/common/e2e-testing.md.
test.setTimeout(90_000);

// Playwright's webServer readiness check watches Vite on :5173, while the backend on
// :3001 comes up alongside it - so a spec that talks to :3001 directly (rather than
// through a page) can start before it is listening. Poll instead of assuming.
async function nonce(): Promise<string> {
  let last: unknown;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://localhost:3001/nonce');
      if (res.ok) return (await res.text()).trim();
      last = `HTTP ${res.status}`;
    } catch (err) { last = err; }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`backend on :3001 never became ready: ${last}`);
}

test('a send right after a manual stop starts a real turn instead of being swallowed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-stop-send-'));
  const ws = new WebSocket(`ws://localhost:3001/agent?nonce=${await nonce()}&dir=${encodeURIComponent(dir)}`, {
    origin: 'http://localhost:5173',
  });
  await new Promise<void>((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', (err) => rej(new Error(`WS connect failed: ${err.message}`)));
  });

  const state = { textChunks: 0, started: false, done: false, injected: false, logs: [] as string[] };
  ws.on('message', (m) => {
    const e = JSON.parse(m.toString());
    if (e.type === 'text_chunk') state.textChunks++;
    else if (e.type === 'log') state.logs.push(String(e.text));
    else if (e.type === 'user_inject') state.injected = true;
    else if (e.type === 'thinking_start') state.started = true;
    // `done` counts only once the turn it belongs to has begun: the stop broadcasts
    // its own `done` immediately, and mistaking that for the next turn's ending
    // makes this test pass on the broken code.
    else if (e.type === 'done' && state.started) state.done = true;
  });
  const until = async (cond: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !cond()) await new Promise(r => setTimeout(r, 100));
    return cond();
  };

  try {
    // A first turn that is still streaming when we interrupt it.
    ws.send(JSON.stringify({ type: 'send', text: 'Count from 1 to 400, one number per line, no commentary.' }));
    expect(await until(() => state.textChunks > 0, 60_000), 'first turn should start streaming').toBe(true);

    // Stop and send again in the same tick - the window the bug lived in.
    state.started = false; state.done = false; state.textChunks = 0; state.injected = false; state.logs = [];
    ws.send(JSON.stringify({ type: 'stop' }));
    ws.send(JSON.stringify({ type: 'send', text: 'Reply with exactly: PROBE-OK' }));

    // It must be a fresh spawn, not an inject into (or reuse of) the killed process.
    expect(await until(() => state.textChunks > 0, 60_000), 'second turn should produce output').toBe(true);
    expect(state.injected, 'the message must not be swallowed as a mid-turn inject').toBe(false);
    const notable = state.logs.filter(l => /Spawning claude|Reusing claude|Mid-turn inject|exited with code/.test(l));
    expect(notable.some(l => l.includes('Spawning claude')), `a new CLI should be spawned; saw: ${JSON.stringify(notable)}`).toBe(true);
    expect(notable.some(l => l.includes('Reusing claude process')), 'the killed proc must not be reused').toBe(false);
    expect(await until(() => state.done, 60_000), 'second turn should finish normally').toBe(true);
  } finally {
    ws.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
});
