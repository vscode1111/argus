import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A send issued while the client is BROWSING another session must start a turn on the
// session it is looking at - not be injected into the stdin of the turn still running
// in the entry it navigated away from.
//
// The bug: handleSend only ever receives the entry state, never the ws, so it could not
// tell a browsing client from a live one and took its mid-turn-inject branch purely
// because the entry had a live proc. The text landed in the OTHER session's turn, where
// every client watching that session saw it appear as an inject bubble.
//
// Integration because "browsing" only exists while a real CLI process is mid-turn:
// handleResumeSession computes isBrowsing from `currentProc && !cliDone`, so there is no
// way to reach this state without spawning one.

// Defaults to the shared dev server the integration project runs against. The override
// exists so this spec can be verified against a throwaway server on a private port
// without stopping a dev server someone is working in (see the task notes).
const PORT = process.env.ARGUS_E2E_PORT ?? '3001';
const BACKEND = `http://localhost:${PORT}`;

// Long enough that the turn is still streaming while we browse away and send.
const LONG_PROMPT = 'List the numbers from 1 to 400, each on its own line. No other text.';
const BROWSED_TEXT = 'scub-browsed-send';

async function getNonce(): Promise<string> {
  const res = await fetch(`${BACKEND}/nonce`);
  return (await res.text()).trim();
}

function makeTempDir(tag: string): string {
  const dir = path.join(os.tmpdir(), `argus-browse-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Frames are buffered from construction, not from the caller's `record()` call. Joining an
// entry that already has state makes the server replay `sessionLoaded` synchronously during
// the upgrade, so that frame can arrive in the same TCP read as the handshake - `ws` then
// emits 'open' and 'message' in one synchronous callback, while `record()` only attaches in
// the promise continuation a microtask later, and the frame is missed. That is a flake by
// load, not by logic: it took out "the watcher to sync" once and passed on the re-run.
const EARLY = Symbol('early-frames');

function openClient(nonce: string, dir: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `ws://localhost:${PORT}/agent?nonce=${encodeURIComponent(nonce)}&dir=${encodeURIComponent(dir)}`;
    const ws = new WebSocket(url, { origin: 'http://localhost:5173' });
    const early: Msg[] = [];
    (ws as unknown as Record<symbol, Msg[]>)[EARLY] = early;
    ws.on('message', (data: Buffer) => {
      try { early.push(JSON.parse(data.toString()) as Msg); } catch { /* non-JSON */ }
    });
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

type Msg = Record<string, unknown>;

// Records every frame the client receives, so an assertion can be made about what did
// NOT arrive as well as what did. Seeded from the buffer openClient has been filling since
// construction, so a frame the server sent during the upgrade is not lost; the copy and the
// listener attach in the same synchronous step, so nothing is dropped or double-counted.
function record(ws: WebSocket): Msg[] {
  const early = (ws as unknown as Record<symbol, Msg[] | undefined>)[EARLY];
  const seen: Msg[] = early ? [...early] : [];
  ws.on('message', (data: Buffer) => {
    try { seen.push(JSON.parse(data.toString()) as Msg); } catch { /* non-JSON */ }
  });
  return seen;
}

async function waitForMsg(seen: Msg[], pred: (m: Msg) => boolean, timeoutMs: number, what: string): Promise<Msg> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = seen.find(pred);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function send(ws: WebSocket, msg: Msg): void {
  ws.send(JSON.stringify(msg));
}

test.describe('send while browsing another session (integration)', () => {
  // Three real CLI turns (a short one to create the second session, a long one to browse
  // away from, and the turn the browsed send must start) do not fit the flat 30s budget.
  test.setTimeout(90_000);

  test('the send starts a turn on the browsed session instead of injecting into the live one', async () => {
    const nonce = await getNonce();
    const dir = makeTempDir('routing');
    const ws = await openClient(nonce, dir);
    const seen = record(ws);

    try {
      // 1. A short turn, so the workspace has a second session on disk to browse to.
      send(ws, { type: 'send', text: 'Reply with exactly: ok' });
      const firstId = await waitForMsg(seen, m => m.type === 'sessionId' && !!m.id, 30_000, 'the first session id');
      const browsedId = String(firstId.id);
      await waitForMsg(seen, m => m.type === 'done', 45_000, 'the first turn to finish');

      // 2. A fresh session, then a long turn that will still be streaming below.
      send(ws, { type: 'newSession' });
      seen.length = 0;
      send(ws, { type: 'send', text: LONG_PROMPT });
      const liveId = await waitForMsg(seen, m => m.type === 'sessionId' && !!m.id, 30_000, 'the live session id');
      expect(String(liveId.id)).not.toBe(browsedId);

      // 3. Browse to the finished session while the long turn runs. This is the state
      //    that used to mis-route: the entry still points at the streaming session.
      send(ws, { type: 'resumeSession', id: browsedId });
      await waitForMsg(seen, m => m.type === 'sessionLoaded' && m.id === browsedId, 15_000, 'the browsed transcript');

      seen.length = 0;
      send(ws, { type: 'send', text: BROWSED_TEXT });

      // The send must open a normal turn: the text echoes back as a user message and a
      // new turn begins. Under the bug this client received neither - it was gated out
      // of the entry it had been injected into.
      await waitForMsg(
        seen,
        m => m.type === 'message' && (m.message as Msg | undefined)?.content === BROWSED_TEXT,
        20_000,
        'the user message echo',
      );
      await waitForMsg(seen, m => m.type === 'thinking_start', 20_000, 'a new turn to start');

      // And it must never have taken the mid-turn-inject branch.
      const injects = seen.filter(m => m.type === 'user_inject');
      expect(injects, 'a browsed send must not be injected into the live turn').toHaveLength(0);
    } finally {
      send(ws, { type: 'stop' });
      await closeClient(ws);
    }
  });

  test('a client watching the live session never sees the browsed send', async () => {
    const nonce = await getNonce();
    const dir = makeTempDir('leak');
    const browser = await openClient(nonce, dir);
    const seenBrowser = record(browser);

    try {
      // Create a second session to browse to, then start the long turn.
      send(browser, { type: 'send', text: 'Reply with exactly: ok' });
      const firstId = await waitForMsg(seenBrowser, m => m.type === 'sessionId' && !!m.id, 30_000, 'the first session id');
      const browsedId = String(firstId.id);
      await waitForMsg(seenBrowser, m => m.type === 'done', 45_000, 'the first turn to finish');

      send(browser, { type: 'newSession' });
      seenBrowser.length = 0;
      send(browser, { type: 'send', text: LONG_PROMPT });
      await waitForMsg(seenBrowser, m => m.type === 'sessionId' && !!m.id, 30_000, 'the live session id');

      // A second client joins the entry running that turn - this is the window that
      // showed the stray prompt in the bug report.
      const watcher = await openClient(nonce, dir);
      const seenWatcher = record(watcher);
      await waitForMsg(seenWatcher, m => m.type === 'sessionLoaded' || m.type === 'thinking_start', 15_000, 'the watcher to sync');

      // The first client browses away and sends.
      send(browser, { type: 'resumeSession', id: browsedId });
      await waitForMsg(seenBrowser, m => m.type === 'sessionLoaded' && m.id === browsedId, 15_000, 'the browsed transcript');
      seenWatcher.length = 0;
      send(browser, { type: 'send', text: BROWSED_TEXT });

      // Give the send time to be mis-routed before concluding it was not.
      await new Promise(r => setTimeout(r, 4_000));
      const leaked = seenWatcher.filter(
        m => (m.type === 'user_inject' && m.text === BROWSED_TEXT)
          || (m.type === 'message' && (m.message as Msg | undefined)?.content === BROWSED_TEXT),
      );
      expect(leaked, 'the browsed send must not reach the live session').toHaveLength(0);

      send(watcher, { type: 'stop' });
      await closeClient(watcher);
    } finally {
      send(browser, { type: 'stop' });
      await closeClient(browser);
    }
  });
});
