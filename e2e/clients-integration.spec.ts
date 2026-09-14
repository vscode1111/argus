import { test, expect, type Page } from '@playwright/test';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The wiring the mock spec cannot see: that a real server answers `listClients` with its
// real sockets, and that each row's session state comes from the session registry rather
// than from the socket alone. Raw Node `ws` clients, because "several clients, one of
// them mid-turn" is a server-side arrangement a single browser page cannot produce.
//
// ARGUS_E2E_PORT points the suite at a throwaway backend instead of a dev server in use.

const PORT = process.env.ARGUS_E2E_PORT ?? '3001';
const BACKEND = `http://localhost:${PORT}`;

interface ClientRow {
  id: number;
  current: boolean;
  address: string;
  local: boolean;
  kind: string;
  workspacePath?: string;
  sessionId?: string;
  running: boolean;
}

async function getNonce(): Promise<string> {
  const res = await fetch(`${BACKEND}/nonce`);
  return (await res.text()).trim();
}

function makeTempDir(tag: string): string {
  const dir = path.join(os.tmpdir(), `argus-clients-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function openClient(nonce: string, dir: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `ws://localhost:${PORT}/agent?nonce=${encodeURIComponent(nonce)}&dir=${encodeURIComponent(dir)}&client=browser`;
    const ws = new WebSocket(url, { origin: 'http://localhost:5173' });
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade failed: ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.on('close', () => resolve());
    ws.close();
  });
}

// Ask one client for the list and read its reply. The handler is attached before the
// request goes out, so a reply that shares a TCP read with another frame is still seen.
function listClients(ws: WebSocket, timeoutMs = 5000): Promise<ClientRow[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', handler); reject(new Error('no clientList reply')); }, timeoutMs);
    const handler = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as { type?: string; clients?: ClientRow[]; error?: string };
        if (msg.type !== 'clientList') return;
        clearTimeout(timer);
        ws.off('message', handler);
        if (msg.error) { reject(new Error(msg.error)); return; }
        resolve(msg.clients ?? []);
      } catch { /* skip non-JSON */ }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'listClients' }));
  });
}

// Ask one client to disconnect another and read the outcome.
function closeClient(ws: WebSocket, id: number, timeoutMs = 5000): Promise<{ id: number; closed: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', handler); reject(new Error('no clientClosed reply')); }, timeoutMs);
    const handler = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as { type?: string; id?: number; closed?: boolean; error?: string };
        if (msg.type !== 'clientClosed') return;
        clearTimeout(timer);
        ws.off('message', handler);
        resolve({ id: msg.id ?? -1, closed: !!msg.closed, error: msg.error });
      } catch { /* skip non-JSON */ }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'closeClient', id }));
  });
}

function waitForType(ws: WebSocket, type: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
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

test.describe('connected client list (integration)', () => {
  test('lists the sockets this server is really serving and marks the one that asked', async () => {
    const nonce = await getNonce();
    const dir = makeTempDir('list');
    const a = await openClient(nonce, dir);
    const b = await openClient(nonce, dir);

    try {
      const rows = await listClients(a);
      // Other workers and the dev page share this backend, so the list is a superset -
      // what must hold is that our two are in it and described correctly.
      const mine = rows.filter(r => r.workspacePath && path.resolve(r.workspacePath) === path.resolve(dir));
      expect(mine.length).toBe(2);
      expect(mine.filter(r => r.current).length).toBe(1);
      for (const r of mine) {
        expect(r.local).toBe(true);              // both raw clients are on this machine
        expect(r.address).toBeTruthy();
        expect(r.kind).toBe('browser');          // client=browser, which is what they passed
      }

      // A socket that goes away leaves the list: a panel showing ghosts would be worse
      // than no panel, since the count beside it is live.
      await closeSocket(b);
      await expect.poll(async () => {
        const after = await listClients(a);
        return after.filter(r => r.workspacePath && path.resolve(r.workspacePath) === path.resolve(dir)).length;
      }, { timeout: 5000 }).toBe(1);
    } finally {
      await closeSocket(a);
      await closeSocket(b);
    }
  });

  test('disconnects a raw client with the terminal close code, and refuses an id nobody owns', async () => {
    const nonce = await getNonce();
    const dir = makeTempDir('close');
    const ctl = await openClient(nonce, dir);
    const victim = await openClient(nonce, dir);

    try {
      const closed = new Promise<number>((resolve) => victim.on('close', (code: number) => resolve(code)));
      const rows = await listClients(ctl);
      const target = rows.find(r => !r.current && r.workspacePath && path.resolve(r.workspacePath) === path.resolve(dir));
      expect(target).toBeDefined();

      const result = await closeClient(ctl, target!.id);
      expect(result.closed).toBe(true);
      // The code is the whole mechanism: `ws-bridge.js` retries every other close, so a
      // plain 1000 would hand the connection straight back.
      expect(await closed).toBe(4001);

      // An id nobody owns is refused rather than silently reported as a success - the
      // caller has already removed that row, so a false "closed" would stick.
      const ghost = await closeClient(ctl, 999_999);
      expect(ghost.closed).toBe(false);
      expect(ghost.error).toBeTruthy();
    } finally {
      await closeSocket(ctl);
      await closeSocket(victim);
    }
  });

  test('a real page that is disconnected stays down and comes back only when asked', async ({ page }) => {
    // The decisive one: everything else can pass while the bridge quietly reconnects a
    // second later, which is the failure this feature is built to avoid.
    const nonce = await getNonce();
    const dir = makeTempDir('page');
    const ctl = await openClient(nonce, dir);

    try {
      await page.goto(`/?dir=${encodeURIComponent(dir)}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByPlaceholder('Ask Argus')).toBeVisible({ timeout: 10_000 });

      const inDir = async () => (await listClients(ctl))
        .filter(r => r.workspacePath && path.resolve(r.workspacePath) === path.resolve(dir) && !r.current);
      await expect.poll(async () => (await inDir()).length, { timeout: 10_000 }).toBe(1);

      const result = await closeClient(ctl, (await inDir())[0].id);
      expect(result.closed).toBe(true);

      // The page notices, and says so in a way that offers the way back - the pulsing
      // "reconnecting" dot would be a lie, because nothing is reconnecting.
      await expect(page.getByTestId('ws-reconnect')).toBeVisible({ timeout: 10_000 });

      // And it stays down. The bridge's first retry would have fired at ~1s.
      await page.waitForTimeout(3000);
      expect(await inDir()).toHaveLength(0);
      await expect(page.getByTestId('ws-reconnect')).toBeVisible();

      // Clicking it is the explicit "bring it back", and it really does.
      await page.getByTestId('ws-reconnect').click();
      await expect(page.getByTestId('ws-dot')).toHaveAttribute('title', 'Connected', { timeout: 10_000 });
      await expect.poll(async () => (await inDir()).length, { timeout: 10_000 }).toBe(1);
    } finally {
      await closeSocket(ctl);
    }
  });

  test('marks the connection whose session is mid-turn, and only that one', async () => {
    // One real CLI turn. The workspace is a temp dir, so the CLI loads no project
    // context and the turn is a fraction of what one costs in this repo - but a spawn
    // plus a round trip to the model still does not fit the suite's flat 30s budget.
    test.setTimeout(60_000);

    const nonce = await getNonce();
    const busyDir = makeTempDir('busy');
    const idleDir = makeTempDir('idle');
    const busy = await openClient(nonce, busyDir);
    const idle = await openClient(nonce, idleDir);

    try {
      const started = waitForType(busy, 'thinking_start');
      busy.send(JSON.stringify({ type: 'send', text: 'Reply with just the single word "ok".' }));
      await started;

      // Asked from the OTHER client: the row is built from the server's session
      // registry, so an idle observer sees the busy one as working.
      const during = await listClients(idle);
      const busyRow = during.find(r => r.workspacePath && path.resolve(r.workspacePath) === path.resolve(busyDir));
      const idleRow = during.find(r => r.workspacePath && path.resolve(r.workspacePath) === path.resolve(idleDir));
      expect(busyRow?.running).toBe(true);
      // The control: without it, a build that reported every row as running would pass.
      expect(idleRow?.running).toBe(false);

      // The id comes from the same registry, and it is NOT there at thinking_start: the
      // CLI names the session with its first event, a moment after the spawn, so the row
      // genuinely starts with none (measured - asserting it here was what failed first).
      await expect.poll(async () => {
        const rows = await listClients(idle);
        return rows.find(r => r.workspacePath && path.resolve(r.workspacePath) === path.resolve(busyDir))?.sessionId;
      }, { timeout: 20_000 }).toMatch(/^[0-9a-f-]{36}$/i);

      // And it stops being marked when the turn ends: "running" is a live reading, not
      // a flag set once at send.
      await waitForType(busy, 'done');
      await expect.poll(async () => {
        const after = await listClients(idle);
        return after.find(r => r.workspacePath && path.resolve(r.workspacePath) === path.resolve(busyDir))?.running;
      }, { timeout: 10_000 }).toBe(false);
    } finally {
      await closeSocket(busy);
      await closeSocket(idle);
    }
  });
});
