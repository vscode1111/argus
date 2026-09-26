import { test, expect } from '@playwright/test';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';

// Whether a daemon is really there is decided by probing its recorded port, never by
// its recorded pid. Driven here on the compiled bundle - these are pure functions over
// a port number, so there is no page, no CLI and no daemon to spawn.
//
// The regression: a dead daemon leaves a discovery file, Windows recycles its pid, and
// `isProcessAlive` says yes. That check cannot be tightened its way out - it already
// verifies the process is `node.exe` or `Code.exe`, and `Code.exe` has to stay allowed
// because the extension launches the daemon as Electron-as-node (verified on the real
// machine: the live daemon's command line is `Code.exe ...\out\backend\daemon.js`),
// while a VS Code install runs dozens of other `Code.exe` utility processes for a
// recycled pid to land on. Measured: a pid recycled 15h20m after the daemon died, onto
// `Code.exe --type=utility --utility-sub-type=node.mojom.NodeService`. The panel then
// showed Server "-" forever, because ensureDaemon read "already running" and never
// spawned, so the post-spawn verification that would have discarded the file never ran.

const ROOT = path.resolve(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const daemonInfo = require(path.join(ROOT, 'out', 'backend', 'daemonInfo.js')) as {
  probeDaemon(port: number, timeoutMs?: number): Promise<'up' | 'down' | 'busy'>;
  isDaemonUp(info: { port: number; pid: number; nonce: string; version: string; startedAt: number }): Promise<boolean>;
  isProcessAlive(pid: number): boolean;
};

function infoFor(port: number, pid: number) {
  return { port, pid, nonce: 'x', version: '0', startedAt: 0 };
}

/** A port with nothing on it: bind one, read it back, release it. */
async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

// Sockets are tracked and destroyed explicitly: `close()` only stops new connections
// and waits for open ones, and the stalled server below exists precisely to hold one
// open, so closing without this hangs the teardown rather than the test.
const servers: Array<http.Server | net.Server> = [];
const sockets: net.Socket[] = [];
function track(s: http.Server | net.Server): void {
  servers.push(s);
  s.on('connection', (sock: net.Socket) => { sockets.push(sock); });
}

async function serve(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler);
  track(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as net.AddressInfo).port;
}

test.afterAll(async () => {
  for (const sock of sockets) sock.destroy();
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
});

test.describe('daemon liveness', () => {
  test('a live pid with a dead port is not a live daemon', async () => {
    const port = await freePort();
    // The test runner's own pid stands in for the recycled one: alive, and it passes
    // the name check (node.exe), exactly like the Code.exe the real failure landed on.
    expect(daemonInfo.isProcessAlive(process.pid)).toBe(true);
    expect(await daemonInfo.probeDaemon(port, 2000)).toBe('down');
    expect(await daemonInfo.isDaemonUp(infoFor(port, process.pid))).toBe(false);
  });

  // Control. Without it, an isDaemonUp that always returned false would satisfy the
  // test above while making the extension respawn a daemon on every reconnect.
  test('a real /health answer is a live daemon', async () => {
    const port = await serve((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configPath: 'x', pid: process.pid }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    expect(await daemonInfo.probeDaemon(port, 2000)).toBe('up');
    expect(await daemonInfo.isDaemonUp(infoFor(port, process.pid))).toBe(true);
  });

  test('a non-Argus server holding the port is not a daemon', async () => {
    // A bare TCP connect would call this alive and hand the webview a URL to a
    // stranger's server; only our own /health JSON counts.
    const port = await serve((_req, res) => { res.writeHead(200); res.end('hello'); });
    expect(await daemonInfo.probeDaemon(port, 2000)).toBe('down');
  });

  // The safety property, and the reason a timeout is not treated as death. The daemon
  // is single-threaded, so a long synchronous stretch (a large transcript read) stalls
  // its HTTP handler. Calling that 'down' would discard the discovery file of a daemon
  // that still owns the port; its replacement then exits on EADDRINUSE, leaving no file
  // and no nonce - a permanent strand, worse than the bug this all fixes.
  test('a stalled daemon is busy, not dead', async () => {
    const s = net.createServer(() => { /* accept, never reply */ });
    track(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as net.AddressInfo).port;
    expect(await daemonInfo.probeDaemon(port, 800)).toBe('busy');
    expect(await daemonInfo.isDaemonUp(infoFor(port, process.pid))).toBe(true);
  });
});
