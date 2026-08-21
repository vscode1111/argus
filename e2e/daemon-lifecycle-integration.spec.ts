import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { WebSocket } from 'ws';
import {
  ensureCompiled, startDaemon, readInfo, isAlive, isPortUp, stopDaemon, waitFor,
  uniqueConfigFile, writeDaemonConfig,
  type DaemonHandle,
} from './daemonHelpers';

// Exercises the real daemon process (out/backend/daemon.js): its discovery file,
// nonce gate, single-instance guard, requested shutdown (Settings "Stop daemon"),
// and connection-count idle self-shutdown. Each
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

  test('records daemonLastStartAt in its config on launch', async () => {
    const PORT = 3914;
    const configPath = uniqueConfigFile('last-start');
    writeDaemonConfig(configPath, { daemonPort: PORT });
    const before = Date.now();
    d = await startDaemon({ configPath });

    // The daemon stamps its launch time into the config right after binding (the
    // daily model-data refresh gates on it staying fresh; the refresh itself is
    // disabled for test daemons via ARGUS_MODEL_REFRESH=0 in daemonHelpers).
    const stamped = await waitFor(() => {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return typeof cfg.daemonLastStartAt === 'number' && cfg.daemonLastStartAt >= before;
      } catch { return false; }
    }, 5000);
    expect(stamped).toBe(true);

    // The kill-switch kept the refresh from running (no real CLI turn): the
    // refresh timestamp is still at its default.
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg.modelDataUpdatedAt ?? 0).toBe(0);
  });

  test('stopDaemon shuts the daemon down and cleans its discovery file', async () => {
    const PORT = 3915;
    d = await startDaemon({ port: PORT, idleMs: 600_000 }); // long idle: only the request may stop it
    const info = readInfo(d.file);

    const ws = new WebSocket(`ws://localhost:${PORT}/agent?nonce=${info.nonce}`);
    const stopping = new Promise<{ stopped: boolean }>((resolve, reject) => {
      ws.on('message', (m) => { const e = JSON.parse(m.toString()); if (e.type === 'daemonStopping') resolve(e); });
      ws.on('error', reject);
    });
    await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'stopDaemon' }));

    // Every client is told before the socket dies, so the UI can report it.
    const msg = await Promise.race([
      stopping,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no daemonStopping broadcast')), 8000)),
    ]);
    expect(msg.stopped).toBe(true);

    // Then the process really exits and leaves no discovery file behind - the same
    // end state as `yarn daemon:stop`, so nothing blocks the next launch.
    expect(await waitFor(() => !isAlive(info.pid), 8000)).toBe(true);
    expect(fs.existsSync(d.file)).toBe(false);
    expect(await isPortUp(PORT)).toBe(false);
    ws.close();
  });

  test('a server that cannot exit itself refuses to stop', async () => {
    // The dev server's exact configuration: startServer with no onIdleShutdown, i.e.
    // no permission to end the process. Run in-process here rather than against the
    // shared :3001 dev server, so a regression in this gate cannot kill the suite.
    const PORT = 3916;
    const server = spawn(process.execPath, [
      '-e',
      `require(${JSON.stringify(path.resolve(__dirname, '..', 'out', 'backend', 'index.js'))})`
      + `.startServer({ port: ${PORT} }).then(() => console.log('up'));`,
    ], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, ARGUS_CONFIG: uniqueConfigFile('nodaemon') }, stdio: 'ignore' });
    try {
      expect(await waitFor(() => isPortUp(PORT), 10_000)).toBe(true);
      const nonce = await new Promise<string>((resolve, reject) => {
        http.get(`http://localhost:${PORT}/nonce`, (res) => {
          let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve(body));
        }).on('error', reject);
      });

      const ws = new WebSocket(`ws://localhost:${PORT}/agent?nonce=${nonce}`);
      const reply = new Promise<{ stopped: boolean }>((resolve, reject) => {
        ws.on('message', (m) => { const e = JSON.parse(m.toString()); if (e.type === 'daemonStopping') resolve(e); });
        ws.on('error', reject);
      });
      await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
      ws.send(JSON.stringify({ type: 'stopDaemon' }));

      const msg = await Promise.race([
        reply,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no daemonStopping reply')), 8000)),
      ]);
      expect(msg.stopped).toBe(false);

      // And it is still serving - the request was answered, not obeyed.
      await new Promise((r) => setTimeout(r, 800));
      expect(await isPortUp(PORT)).toBe(true);
      expect(isAlive(server.pid!)).toBe(true);
      ws.close();
    } finally {
      try { server.kill(); } catch { /* already gone */ }
    }
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
