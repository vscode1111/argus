import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';

// Stopping a turn must not poison the conversation the model sees.
//
// The regression: `stop` killed the CLI, which left its transcript ending on a user
// message nobody answered. The CLI repairs that shape on the next `--resume` by splicing
// a fake assistant turn - model "<synthetic>", zero tokens, text "No response requested."
// - into the conversation, and it sends that to the model on every later turn (proven by
// asking the model to quote its own prior messages back). Five of them accumulated in one
// real session and the model started answering genuine questions with the same four words.
//
// The fix is not to repair the transcript, which Argus cannot do: the CLI only splices
// when the *last* message is a user message, so keeping the process alive is enough. The
// next send reuses it with no `--resume`, its answer lands after the abandoned message,
// and the abandoned message is no longer last - permanently, not just until the next
// resume, which is what the third turn here checks.
//
// Driven over a raw WS in its own temp workspace dir, matching stop-then-send: the
// behaviour is entirely server-side and the readout is a file on disk.
test.describe.configure({ mode: 'serial' });

// Three real CLI turns do not fit the global 30s. Justified per-test exception, see
// !notes/common/e2e-testing.md.
test.setTimeout(120_000);

const PLACEHOLDER = 'No response requested.';

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

// Same encoding the CLI uses for its per-workspace transcript folder: every non
// alphanumeric character becomes a dash, with no collapsing.
function transcriptPath(dir: string, sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

function countPlaceholders(file: string): number {
  if (!fs.existsSync(file)) return -1;
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes(PLACEHOLDER)) continue;
    let o: { type?: string; message?: { model?: string; content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'assistant' && o.message?.model === '<synthetic>') n++;
  }
  return n;
}

test('a stopped turn leaves no "No response requested." placeholder in the transcript', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-stop-placeholder-'));
  const ws = new WebSocket(`ws://localhost:3001/agent?nonce=${await nonce()}&dir=${encodeURIComponent(dir)}`, {
    origin: 'http://localhost:5173',
  });
  await new Promise<void>((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', (err) => rej(new Error(`WS connect failed: ${err.message}`)));
  });

  const state = { textChunks: 0, started: false, done: false, sessionId: '', logs: [] as string[] };
  ws.on('message', (m) => {
    const e = JSON.parse(m.toString());
    if (e.type === 'text_chunk') state.textChunks++;
    else if (e.type === 'log') state.logs.push(String(e.text));
    else if (e.type === 'sessionId' && e.id) state.sessionId = String(e.id);
    else if (e.type === 'thinking_start') state.started = true;
    else if (e.type === 'done' && state.started) state.done = true;
  });
  const until = async (cond: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !cond()) await new Promise(r => setTimeout(r, 100));
    return cond();
  };
  const resetTurn = () => { state.started = false; state.done = false; state.textChunks = 0; };

  try {
    // 1. A turn long enough to still be streaming when it is stopped.
    ws.send(JSON.stringify({ type: 'send', text: 'Count from 1 to 400, one number per line, no commentary.' }));
    expect(await until(() => state.textChunks > 0, 60_000), 'first turn should start streaming').toBe(true);
    expect(await until(() => !!state.sessionId, 30_000), 'the CLI should report a session id').toBe(true);
    const file = transcriptPath(dir, state.sessionId);

    // 2. Stop it, and let the interrupt settle. A send fired in the same tick deliberately
    //    falls back to kill-and-respawn (stop-then-send-integration covers that path), so
    //    waiting here is what exercises the fix rather than the fallback.
    state.logs = [];
    ws.send(JSON.stringify({ type: 'stop' }));
    expect(
      await until(() => state.logs.some(l => l.includes('interrupted turn ended')), 30_000),
      `the stop should interrupt and keep the CLI; logs: ${JSON.stringify(state.logs.slice(-8))}`,
    ).toBe(true);

    // 3. The next send must reuse that process. Reuse is the whole mechanism: no respawn
    //    means no `--resume`, which means the CLI never rebuilds the conversation from the
    //    transcript and never splices its repair into it.
    resetTurn();
    state.logs = [];
    ws.send(JSON.stringify({ type: 'send', text: 'Reply with exactly: PROBE-OK' }));
    expect(await until(() => state.done, 60_000), 'the follow-up turn should finish').toBe(true);
    const notable = state.logs.filter(l => /Spawning claude|Reusing claude/.test(l));
    expect(
      notable.some(l => l.includes('Reusing claude process')),
      `the interrupted process should be reused; saw: ${JSON.stringify(notable)}`,
    ).toBe(true);

    // 4. The readout. Under the old kill-on-stop this is 1: the resume for the follow-up
    //    turn found a transcript ending on the unanswered first prompt and repaired it.
    expect(countPlaceholders(file), `transcript ${file} should carry no synthetic placeholder`).toBe(0);

    // 5. And it must stay 0 through a real cold resume, not merely be deferred to one.
    //    Plan mode changes the spawn args, so the process cannot be reused and the CLI
    //    rebuilds the conversation from disk - the exact moment the repair would fire.
    resetTurn();
    state.logs = [];
    ws.send(JSON.stringify({ type: 'send', text: 'Reply with exactly: COLD-OK', mode: 'plan' }));
    expect(await until(() => state.done, 60_000), 'the cold-resumed turn should finish').toBe(true);
    expect(
      state.logs.some(l => l.includes('Spawning claude') && l.includes('--resume')),
      `the third turn should be a real --resume; saw: ${JSON.stringify(state.logs.filter(l => l.includes('claude')).slice(-4))}`,
    ).toBe(true);
    expect(countPlaceholders(file), 'a cold resume must not splice a placeholder either').toBe(0);
  } finally {
    ws.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
});
