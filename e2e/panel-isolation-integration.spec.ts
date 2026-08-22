import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Tests for per-panel session isolation (?panel=<id>). Two VS Code panels open on the
// same workspace used to join the channel's default entry, so a turn started in one
// panel was broadcast into the other (a reply appearing with no user bubble). Each
// panel now passes a stable id and owns its own session entry, while a reconnect of
// that same id (webview reload, daemon restart) rejoins the entry it already owns.
//
// Uses the real dev server on :3001, one unique temp dir per test. ARGUS_E2E_PORT
// overrides the port so the suite can be pointed at a throwaway backend instead.

const PORT = process.env.ARGUS_E2E_PORT ?? '3001';
const BACKEND = `http://localhost:${PORT}`;

async function getNonce(): Promise<string> {
  const res = await fetch(`${BACKEND}/nonce`);
  return (await res.text()).trim();
}

function makeTempDir(tag: string): string {
  const dir = path.join(os.tmpdir(), `argus-panel-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function wsUrl(nonce: string, dir: string, panel: string): string {
  return `ws://localhost:${PORT}/agent?nonce=${encodeURIComponent(nonce)}`
    + `&dir=${encodeURIComponent(dir)}&panel=${encodeURIComponent(panel)}`;
}

// Opens a client for one panel id. The listener must be attachable before 'open'
// resolves (the server can replay immediately on join), so the raw socket is returned
// alongside a promise that settles once connected.
function openPanel(nonce: string, dir: string, panel: string): { ws: WebSocket; opened: Promise<void> } {
  const ws = new WebSocket(wsUrl(nonce, dir, panel), { origin: 'http://localhost:5173' });
  const opened = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade failed: ${(res as { statusCode: number }).statusCode}`)));
    ws.on('error', reject);
  });
  return { ws, opened };
}

function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.on('close', () => resolve());
    ws.close();
  });
}

function waitForType(ws: WebSocket, type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
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

async function expectNoType(ws: WebSocket, type: string, timeoutMs = 1000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', handler); resolve(); }, timeoutMs);
    const handler = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === type) { clearTimeout(timer); ws.off('message', handler); reject(new Error(`unexpected "${type}" leaked to the other panel`)); }
      } catch { /* skip non-JSON */ }
    };
    ws.on('message', handler);
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('per-panel session isolation (integration)', () => {
  let nonce: string;
  const open: WebSocket[] = [];

  test.beforeAll(async () => { nonce = await getNonce(); });

  test.afterEach(async () => {
    for (const ws of open.splice(0)) await closeClient(ws).catch(() => {/* ignore */});
  });

  test('two panels in one workspace do not receive each other turns', async () => {
    const dir = makeTempDir('isolation');
    const a = openPanel(nonce, dir, 'panel-a');
    const b = openPanel(nonce, dir, 'panel-b');
    open.push(a.ws, b.ws);
    await Promise.all([a.opened, b.opened]);

    // The regression: B used to receive A's user message and the whole streamed reply,
    // because both landed in the channel's default entry.
    const noMessage = expectNoType(b.ws, 'message');
    const noStream = expectNoType(b.ws, 'thinking_start');
    a.ws.send(JSON.stringify({ type: 'send', text: 'scub-panel-isolation' }));
    await waitForType(a.ws, 'message', 3000);
    await Promise.all([noMessage, noStream]);

    a.ws.send(JSON.stringify({ type: 'stop' }));
  });

  test('reconnecting with the same panel id rejoins that panel session', async () => {
    const dir = makeTempDir('rejoin');
    const first = openPanel(nonce, dir, 'panel-reconnect');
    open.push(first.ws);
    await first.opened;

    first.ws.send(JSON.stringify({ type: 'send', text: 'scub-panel-rejoin' }));
    await waitForType(first.ws, 'message', 3000);
    first.ws.send(JSON.stringify({ type: 'stop' }));
    await closeClient(first.ws);

    // Same panel id reconnects (webview reload / daemon restart). Its entry survives the
    // 30s grace window, so the conversation must come back. Replay is deferred to
    // webviewReady, mirroring the deep-link path.
    const again = openPanel(nonce, dir, 'panel-reconnect');
    open.push(again.ws);
    await again.opened;
    const replayed = waitForType(again.ws, 'sessionLoaded', 5000);
    again.ws.send(JSON.stringify({ type: 'webviewReady' }));
    const messages = ((await replayed).messages ?? []) as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.role === 'user' && m.content === 'scub-panel-rejoin')).toBe(true);
  });

  test('a different panel id starts an empty session in the same workspace', async () => {
    const dir = makeTempDir('distinct');
    const first = openPanel(nonce, dir, 'panel-one');
    open.push(first.ws);
    await first.opened;
    first.ws.send(JSON.stringify({ type: 'send', text: 'scub-panel-one' }));
    await waitForType(first.ws, 'message', 3000);
    first.ws.send(JSON.stringify({ type: 'stop' }));

    // A second panel joining the same workspace must not inherit the first panel's
    // history - that inheritance is what produced the duplicated reply.
    const second = openPanel(nonce, dir, 'panel-two');
    open.push(second.ws);
    const noReplay = expectNoType(second.ws, 'sessionLoaded', 1500);
    await second.opened;
    second.ws.send(JSON.stringify({ type: 'webviewReady' }));
    await noReplay;
  });
});
