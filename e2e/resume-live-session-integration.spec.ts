import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Returning to a session that is streaming RIGHT NOW must land the client in the live
// turn: the progress indicator comes back and further output keeps arriving.
//
// The bug: handleResumeSession only ever rebinds the client's OWN entry's sessionId and
// replays that entry's snapshot. When the session is being streamed by a different entry
// (another panel, or - since the browse-send fix - the entry the client detached from),
// the client got the transcript off disk, which stops at the last committed turn: no
// thinking_start, no indicator, and no further frames as the turn continued elsewhere.
//
// Integration because the whole point is a real CLI process mid-turn in another entry.

const PORT = process.env.ARGUS_E2E_PORT ?? '3001';
const BACKEND = `http://localhost:${PORT}`;

// Long enough to still be streaming while the second client resumes it.
const LONG_PROMPT = 'List the numbers from 1 to 400, each on its own line. No other text.';

async function getNonce(): Promise<string> {
  const res = await fetch(`${BACKEND}/nonce`);
  return (await res.text()).trim();
}

function makeTempDir(tag: string): string {
  const dir = path.join(os.tmpdir(), `argus-resumelive-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// client=browser makes the server give this socket its own SessionEntry (fresh), which is
// what puts the two clients in different entries - the situation under test.
function openClient(nonce: string, dir: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `ws://localhost:${PORT}/agent?nonce=${encodeURIComponent(nonce)}`
      + `&dir=${encodeURIComponent(dir)}&client=browser`;
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

type Msg = Record<string, unknown>;

function record(ws: WebSocket): Msg[] {
  const seen: Msg[] = [];
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

const STREAM_FRAMES = new Set(['text_chunk', 'thinking_chunk', 'tool_start', 'tool_end', 'done']);

function send(ws: WebSocket, msg: Msg): void {
  ws.send(JSON.stringify(msg));
}

test.describe('resuming a session that is streaming elsewhere (integration)', () => {
  // Two real CLI turns plus a live resume do not fit the flat 30s budget.
  test.setTimeout(90_000);

  test('the resumed client gets the live indicator and keeps receiving output', async () => {
    const nonce = await getNonce();
    const dir = makeTempDir('attach');
    const streamer = await openClient(nonce, dir);
    const seenStreamer = record(streamer);
    let viewer: WebSocket | undefined;

    try {
      // Start a long turn. client=browser gives this socket its own entry.
      send(streamer, { type: 'send', text: LONG_PROMPT });
      const idMsg = await waitForMsg(seenStreamer, m => m.type === 'sessionId' && !!m.id, 30_000, 'the live session id');
      const liveId = String(idMsg.id);

      // A second client in its own entry - the panel the user switches back from.
      viewer = await openClient(nonce, dir);
      const seenViewer = record(viewer);

      // Confirm the turn is genuinely still running before resuming it, or the test
      // proves nothing (a finished session legitimately has no indicator to show).
      expect(seenStreamer.some(m => m.type === 'done'), 'turn ended too early to test a live resume').toBe(false);

      send(viewer, { type: 'resumeSession', id: liveId });

      // The live indicator: replaying an in-progress entry opens with thinking_start.
      await waitForMsg(seenViewer, m => m.type === 'thinking_start', 20_000, 'the progress indicator');

      // And it must keep updating, not just paint one frame and freeze.
      seenViewer.length = 0;
      await waitForMsg(
        seenViewer,
        m => STREAM_FRAMES.has(String(m.type)),
        25_000,
        'continued streaming output after the resume',
      );
    } finally {
      if (viewer) { send(viewer, { type: 'stop' }); await closeClient(viewer); }
      send(streamer, { type: 'stop' });
      await closeClient(streamer);
    }
  });
});
