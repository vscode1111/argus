import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocket } from 'ws';
import {
  ensureCompiled, startDaemon, readInfo, isAlive, stopDaemon, waitFor,
  type DaemonHandle,
} from './daemonHelpers';

// Exercises the real daemon process (out/backend/daemon.js): its discovery file,
// nonce gate, single-instance guard, and connection-count idle self-shutdown. Each
// test gets its own port + throwaway discovery file (via env) so they never touch
// the user's real ~/.claude/argus-daemon.json. Serial to keep the spawned processes
// and port use predictable.
test.describe.configure({ mode: 'serial' });

const DAEMON_JS = path.resolve(__dirname, '..', 'out', 'backend', 'daemon.js');

// 'open' if the upgrade succeeded, else the HTTP status the server replied with
// (401 = bad/missing nonce).
function probe(port: number, nonce: string): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/agent?nonce=${nonce}`);
    let settled = false;
    const done = (r: 'open' | number) => { if (!settled) { settled = true; resolve(r); } };
    ws.on('open', () => { ws.close(); done('open'); });
    ws.on('unexpected-response', (_req, res) => done(res.statusCode ?? -1));
    ws.on('error', () => done(-1));
  });
}

test.describe('daemon lifecycle (integration)', () => {
  let d: DaemonHandle | undefined;

  test.beforeAll(() => ensureCompiled());
  test.afterEach(() => { stopDaemon(d); d = undefined; });

  test('writes a discovery file and gates connections by nonce', async () => {
    const PORT = 3911;
    d = await startDaemon({ port: PORT });

    const info = readInfo(d.file);
    expect(info.port).toBe(PORT);
    expect(info.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(info.pid).toBeGreaterThan(0);
    expect(isAlive(info.pid)).toBe(true);

    // The real nonce connects; a wrong one is rejected at the upgrade with 401.
    await expect(probe(PORT, info.nonce)).resolves.toBe('open');
    await expect(probe(PORT, 'wrong-nonce')).resolves.toBe(401);
  });

  test('a second launch exits without taking over the running daemon', async () => {
    const PORT = 3912;
    d = await startDaemon({ port: PORT });
    const first = readInfo(d.file);

    // A second daemon pointed at the same discovery file + port sees a live pid and
    // must exit 0 (idempotent launcher), leaving the original untouched.
    const code = await new Promise<number | null>((resolve) => {
      const p = spawn(process.execPath, [DAEMON_JS], {
        env: { ...process.env, ARGUS_DAEMON_PORT: String(PORT), ARGUS_DAEMON_FILE: d!.file },
        stdio: 'ignore',
      });
      p.on('exit', resolve);
    });

    expect(code).toBe(0);
    expect(isAlive(first.pid)).toBe(true);
    expect(readInfo(d.file).pid).toBe(first.pid); // file still points at the original
  });

  test('self-exits and cleans the discovery file after the last client disconnects', async () => {
    const PORT = 3913;
    d = await startDaemon({ port: PORT, idleMs: 2000 });
    const info = readInfo(d.file);

    // A connected client keeps the daemon alive past the idle window (idle is
    // connection-count based, not activity based).
    const ws = new WebSocket(`ws://localhost:${PORT}/agent?nonce=${info.nonce}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 3000)); // > idleMs while connected
    expect(isAlive(info.pid)).toBe(true);

    // After the last client drops, the daemon exits within the idle window and
    // removes its discovery file on the way out.
    ws.close();
    const exited = await waitFor(() => !isAlive(info.pid), 8000);
    expect(exited).toBe(true);
    expect(fs.existsSync(d.file)).toBe(false);
  });
});
