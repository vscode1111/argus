import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Tests for the shared-channel broadcast feature: clients connecting to the same
// ?dir= join one channel and see each other's broadcast events (user messages,
// newSession/clear, sessionLoaded replay, streamed turns). Per-client events
// (settings, skills, filePreview, etc.) must NOT leak to other clients.
//
// Uses the real dev server on :3001. Each test creates a unique temp dir so
// channel state never bleeds between tests.

const BACKEND = 'http://localhost:3001';

async function getNonce(): Promise<string> {
  const res = await fetch(`${BACKEND}/nonce`);
  return (await res.text()).trim();
}

function makeTempDir(tag: string): string {
  const dir = path.join(os.tmpdir(), `argus-channel-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Opens a WS client for a specific workspace dir and resolves once connected.
function openClient(nonce: string, dir: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `ws://localhost:3001/agent?nonce=${encodeURIComponent(nonce)}&dir=${encodeURIComponent(dir)}`;
    const ws = new WebSocket(url, { origin: 'http://localhost:5173' });
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade failed: ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.on('close', () => resolve());
    ws.close();
  });
}

// Collect incoming messages into an array for a bounded time (ms).
// Returns as soon as `until` returns true for a collected message, or after `timeoutMs`.
function collectMessages(ws: WebSocket, timeoutMs: number, until?: (msgs: unknown[]) => boolean): Promise<unknown[]> {
  return new Promise((resolve) => {
    const msgs: unknown[] = [];
    const done = () => { ws.off('message', handler); clearTimeout(timer); resolve(msgs); };
    const timer = setTimeout(done, timeoutMs);
    const handler = (data: Buffer) => {
      try { msgs.push(JSON.parse(data.toString())); } catch { msgs.push(data.toString()); }
      if (until && until(msgs)) done();
    };
    ws.on('message', handler);
  });
}

// Wait until a specific message type appears in the stream.
function waitForType(ws: WebSocket, type: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', handler); reject(new Error(`timeout waiting for "${type}"`)); }, timeoutMs);
    const handler = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === type) { clearTimeout(timer); ws.off('message', handler); resolve(msg); }
      } catch { /* skip non-JSON */ }
    };
    ws.on('message', handler);
  });
}

// Checks that a given message type does NOT arrive within `timeoutMs`.
async function expectNoType(ws: WebSocket, type: string, timeoutMs = 800): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', handler); resolve(); }, timeoutMs);
    const handler = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === type) { clearTimeout(timer); ws.off('message', handler); reject(new Error(`unexpected "${type}" received by other client`)); }
      } catch { /* skip non-JSON */ }
    };
    ws.on('message', handler);
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('shared channel broadcast (integration)', () => {
  let dir: string;
  let nonce: string;
  let clientA: WebSocket;
  let clientB: WebSocket;

  test.beforeAll(async () => { nonce = await getNonce(); });

  test.afterEach(async () => {
    await closeClient(clientA).catch(() => {/* ignore */});
    await closeClient(clientB).catch(() => {/* ignore */});
  });

  test('newSession creates an isolated session for client A only; B keeps the old session', async () => {
    dir = makeTempDir('newsession');
    [clientA, clientB] = await Promise.all([openClient(nonce, dir), openClient(nonce, dir)]);

    // Verify A and B start in the same session: A's message broadcast reaches B.
    const bGotMsg = waitForType(clientB, 'message', 3000);
    clientA.send(JSON.stringify({ type: 'send', text: 'shared-start' }));
    await bGotMsg;

    // A creates a new isolated session. A gets 'clear'; B must NOT.
    const checkNoClear = expectNoType(clientB, 'clear', 800);
    clientA.send(JSON.stringify({ type: 'newSession' }));
    await waitForType(clientA, 'clear', 3000);
    await checkNoClear;

    // Now A is in a new session: A's messages must NOT reach B.
    const checkNoMsg = expectNoType(clientB, 'message', 800);
    clientA.send(JSON.stringify({ type: 'send', text: 'isolated-session-test' }));
    await checkNoMsg;

    clientA.send(JSON.stringify({ type: 'stop' }));
    clientB.send(JSON.stringify({ type: 'stop' }));
  });

  test('late-joining client B receives sessionLoaded replay after client A sends a user message', async () => {
    dir = makeTempDir('replay');
    clientA = await openClient(nonce, dir);

    // A sends a chat message. The server broadcasts { type: 'message', role: 'user', ... }
    // to all channel clients AND records it in channel history. The CLI will also spawn
    // (may fail, which is fine - we only need the history entry).
    clientA.send(JSON.stringify({ type: 'send', text: 'hello replay' }));

    // Wait for A to receive the broadcast user message (confirms it hit the channel)
    await waitForType(clientA, 'message', 3000);

    // B joins after the message. The server replays history immediately on connection,
    // which can arrive before the WS 'open' event resolves on the client side.
    // Attach the 'message' listener BEFORE awaiting open to avoid the race.
    const url = `ws://localhost:3001/agent?nonce=${encodeURIComponent(nonce)}&dir=${encodeURIComponent(dir)}`;
    clientB = new WebSocket(url, { origin: 'http://localhost:5173' });
    const replayPromise = waitForType(clientB, 'sessionLoaded', 5000);
    await new Promise<void>((resolve, reject) => {
      clientB.on('open', () => resolve());
      clientB.on('unexpected-response', (_req, res) => reject(new Error(`upgrade failed: ${(res as { statusCode: number }).statusCode}`)));
      clientB.on('error', reject);
    });
    const replay = await replayPromise as Record<string, unknown>;
    const messages = (replay.messages ?? []) as Array<{ role: string; content: string }>;
    // The replayed history must contain the user message A sent
    expect(messages.some((m) => m.role === 'user' && m.content === 'hello replay')).toBe(true);

    // Stop any in-progress CLI turn to avoid interference with other tests
    clientA.send(JSON.stringify({ type: 'stop' }));
  });

  test('getSettings from client A does NOT reach client B (per-client response)', async () => {
    dir = makeTempDir('per-client');
    [clientA, clientB] = await Promise.all([openClient(nonce, dir), openClient(nonce, dir)]);

    // Drain the initial sessionLoaded replay that B gets on join
    await collectMessages(clientB, 300);

    const check = expectNoType(clientB, 'settings', 800);
    clientA.send(JSON.stringify({ type: 'getSettings' }));
    // Client A should receive its own settings response
    await waitForType(clientA, 'settings', 3000);
    // Client B must NOT have received it
    await check;
  });

  test('getSkills from client A does NOT reach client B', async () => {
    dir = makeTempDir('per-client-skills');
    [clientA, clientB] = await Promise.all([openClient(nonce, dir), openClient(nonce, dir)]);

    await collectMessages(clientB, 300);

    const check = expectNoType(clientB, 'skills', 800);
    clientA.send(JSON.stringify({ type: 'getSkills' }));
    await waitForType(clientA, 'skills', 3000);
    await check;
  });

  test('resumeSession from client A does NOT reach client B (per-client navigation)', async () => {
    dir = makeTempDir('resume-isolation');
    [clientA, clientB] = await Promise.all([openClient(nonce, dir), openClient(nonce, dir)]);

    await collectMessages(clientB, 300);

    // A resumes a session by UUID. Even if the session doesn't exist on disk the server
    // still sends a per-client sessionLoaded (with empty messages). B must not receive it.
    const check = expectNoType(clientB, 'sessionLoaded', 800);
    const fakeId = '00000000-0000-0000-0000-000000000001';
    clientA.send(JSON.stringify({ type: 'resumeSession', id: fakeId }));
    await waitForType(clientA, 'sessionLoaded', 3000);
    await check;
  });

  test('switchModel broadcast reaches all clients on the channel', async () => {
    dir = makeTempDir('model-broadcast');
    [clientA, clientB] = await Promise.all([openClient(nonce, dir), openClient(nonce, dir)]);

    // Drain initial replay on B
    await collectMessages(clientB, 300);

    const bGotModel = waitForType(clientB, 'modelChanged', 3000);
    clientA.send(JSON.stringify({ type: 'switchModel', model: 'claude-haiku-4-5' }));
    const msg = await bGotModel as Record<string, unknown>;
    expect(msg.model).toBe('claude-haiku-4-5');

    // Restore model to empty (CLI default)
    clientA.send(JSON.stringify({ type: 'switchModel', model: '' }));
    await waitForType(clientA, 'modelChanged', 3000);
  });

  // --- Tests covering the two session-switching bugs ---
  //
  // Bug 1: resumeSession was calling killProc, so switching session mid-turn killed the
  //        running CLI process; the turn would never complete on any client.
  // Bug 2: after resumeSession the client was still in the channel's broadcast set, so
  //        streaming events (text_chunk, tool_start, done, …) kept arriving even though
  //        the client was now viewing a different session's history.

  test('active CLI turn is not killed when client B switches to a different session', async () => {
    // Bug 1 regression: switching session must not call killProc.
    dir = makeTempDir('no-kill-on-resume');
    [clientA, clientB] = await Promise.all([openClient(nonce, dir), openClient(nonce, dir)]);

    clientA.send(JSON.stringify({ type: 'send', text: 'scub-ping: reply with the single word "scub-ok"' }));

    // Wait for thinking_start on both clients (shared broadcast confirms the turn started).
    await Promise.all([
      waitForType(clientA, 'thinking_start', 10000),
      waitForType(clientB, 'thinking_start', 10000),
    ]);

    // B navigates away to a different session. With the old code this called killProc
    // on the shared channel proc, aborting A's turn too.
    const fakeId = '00000000-0000-0000-0000-000000000003';
    clientB.send(JSON.stringify({ type: 'resumeSession', id: fakeId }));
    await waitForType(clientB, 'sessionLoaded', 5000);

    // A must still receive done - if killProc was called it would never arrive.
    await waitForType(clientA, 'done', 60000);
  });

  test('browsing client does not receive session-streaming events from active CLI turn', async () => {
    // Bug 2 regression: after resumeSession the client must enter browsing mode and
    // be excluded from session-streaming broadcasts (text_chunk, tool_start, done, etc.).
    dir = makeTempDir('browsing-no-stream');
    [clientA, clientB] = await Promise.all([openClient(nonce, dir), openClient(nonce, dir)]);

    clientA.send(JSON.stringify({ type: 'send', text: 'scub-ping: reply with the single word "scub-ok"' }));

    // Wait for thinking_start on A; B also receives it (shared broadcast, browsing mode not set yet).
    await waitForType(clientA, 'thinking_start', 10000);

    // B switches to browsing mode before the turn produces text/done.
    const fakeId = '00000000-0000-0000-0000-000000000004';
    clientB.send(JSON.stringify({ type: 'resumeSession', id: fakeId }));
    await waitForType(clientB, 'sessionLoaded', 5000);

    // Track whether any session-streaming events reach B while it is in browsing mode.
    let bGotStreamEvent = false;
    const streamTypes = new Set(['text_chunk', 'thinking_chunk', 'tool_start', 'tool_end', 'done', 'error']);
    const listener = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (streamTypes.has(msg.type as string)) bGotStreamEvent = true;
      } catch { /* skip */ }
    };
    clientB.on('message', listener);

    // Let the turn complete on A; B must not receive any session-streaming events.
    await waitForType(clientA, 'done', 60000);
    // Small grace period for any stray in-flight frames.
    await new Promise((r) => setTimeout(r, 300));

    clientB.off('message', listener);
    expect(bGotStreamEvent).toBe(false);
  });

  test('resumeSession with a different id puts client into browsing mode (no session-stream events)', async () => {
    dir = makeTempDir('browsing-mode');
    [clientA, clientB] = await Promise.all([openClient(nonce, dir), openClient(nonce, dir)]);
    await collectMessages(clientB, 300);

    // A sends a user message; B (in the same entry) should see it.
    const bGotMessage = waitForType(clientB, 'message', 3000);
    clientA.send(JSON.stringify({ type: 'send', text: 'hello browsing test' }));
    await bGotMessage;

    // B resumes a different session (fake UUID) - enters browsing mode in this entry.
    const fakeId = '00000000-0000-0000-0000-000000000002';
    clientB.send(JSON.stringify({ type: 'resumeSession', id: fakeId }));
    await waitForType(clientB, 'sessionLoaded', 3000);

    // After entering browsing mode, B must NOT receive session-streaming events.
    const checkNoThinking = expectNoType(clientB, 'thinking_start', 800);
    const checkNoText = expectNoType(clientB, 'text_chunk', 800);

    // A creates a new isolated session. A moves to a new entry; B stays in the old one.
    // B must NOT receive the 'clear' from A's new session (it goes only to A's new entry).
    const checkNoClear = expectNoType(clientB, 'clear', 800);
    clientA.send(JSON.stringify({ type: 'newSession' }));
    await checkNoClear;
    await checkNoThinking;
    await checkNoText;

    // Cleanup: stop the in-progress turn in B's entry, and A's new empty session.
    clientB.send(JSON.stringify({ type: 'stop' }));
    clientA.send(JSON.stringify({ type: 'stop' }));
  });

  test('two clients connect to different dirs and do NOT share messages', async () => {
    const dirA = makeTempDir('isolation-a');
    const dirB = makeTempDir('isolation-b');
    clientA = await openClient(nonce, dirA);
    clientB = await openClient(nonce, dirB);

    await collectMessages(clientB, 300);

    // A sends newSession - B is on a different channel and must not receive clear
    const check = expectNoType(clientB, 'clear', 800);
    clientA.send(JSON.stringify({ type: 'newSession' }));
    // Wait for A to process it (it's on its own channel)
    await new Promise((r) => setTimeout(r, 300));
    // B must have seen nothing
    await check;
  });
});
