import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

// `yarn daemon:stop` must never remove the discovery file of a daemon that is still
// alive. That file is the only way anything reaches the daemon (the nonce exists
// nowhere else) and the port stays held, so a replacement dies on EADDRINUSE and the
// extension is stranded permanently - a far worse outcome than "stop didn't work".
// The script used to end in an unconditional unlink, reached even when the kill threw,
// and its own probe resolved a timeout to "not serving" rather than to 'busy', so a
// stalled daemon read as dead. Both are fixed; this pins them.
//
// No real daemon and no CLI here: every case is a plain HTTP/TCP server standing in
// for one, which is what makes the stalled case reproducible on demand.

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'daemon-stop.js');

const servers: Array<http.Server | net.Server> = [];
const sockets: net.Socket[] = [];
const files: string[] = [];

function track(s: http.Server | net.Server): void {
  servers.push(s);
  s.on('connection', (sock: net.Socket) => { sockets.push(sock); });
}

function tempFile(tag: string): string {
  const f = path.join(os.tmpdir(), `argus-stop-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  files.push(f);
  return f;
}

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A server that accepts connections and never answers: a stalled daemon. */
async function stalledPort(): Promise<number> {
  const s = net.createServer(() => { /* accept, never reply */ });
  track(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as net.AddressInfo).port;
}

function runStop(file: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, ARGUS_DAEMON_FILE: file },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (c) => { out += String(c); });
    p.stderr.on('data', (c) => { out += String(c); });
    p.on('exit', (code) => resolve({ code, out }));
  });
}

test.afterAll(async () => {
  for (const sock of sockets) sock.destroy();
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  for (const f of files) { try { fs.unlinkSync(f); } catch { /* gone */ } }
});

test.describe('daemon:stop safety', () => {
  test('a stalled daemon keeps its discovery file', async () => {
    const port = await stalledPort();
    const file = tempFile('busy');
    // A live pid is the point: the runner's own stands in for the daemon, so the only
    // thing separating "stop it" from "leave it" is how the probe reads the timeout.
    fs.writeFileSync(file, JSON.stringify({ port, nonce: 'x', pid: process.pid, version: '0', startedAt: 0 }));

    const { code, out } = await runStop(file);

    expect(fs.existsSync(file)).toBe(true);
    expect(code).not.toBe(0);
    expect(out).toContain('did not answer');
  });

  // Control for the one above: without it, a script that simply never deleted anything
  // would pass. A file whose port refuses connections really is stale and must go, or
  // it blocks every future launch.
  test('a stale discovery file is cleaned up', async () => {
    const port = await freePort(); // nothing listening
    const file = tempFile('stale');
    fs.writeFileSync(file, JSON.stringify({ port, nonce: 'x', pid: process.pid, version: '0', startedAt: 0 }));

    const { code } = await runStop(file);

    expect(fs.existsSync(file)).toBe(false);
    expect(code).toBe(0);
  });

  // The other control: the script must still do its job. A real, killable process that
  // answers /health with its own pid stands in for the daemon end to end.
  test('a daemon that answers is stopped and its file removed', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [
      '-e',
      `require('http').createServer((req,res)=>{`
      + `if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});`
      + `res.end(JSON.stringify({configPath:'x',pid:process.pid}));return;}`
      + `res.writeHead(404);res.end();}).listen(${port},'127.0.0.1');`,
    ], { stdio: 'ignore' });

    try {
      // Wait for it to be serving before asking anything to stop it.
      const up = await (async () => {
        for (let i = 0; i < 50; i++) {
          const ok = await new Promise<boolean>((resolve) => {
            const req = http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => { res.resume(); resolve(res.statusCode === 200); });
            req.on('error', () => resolve(false));
            req.setTimeout(300, () => { req.destroy(); resolve(false); });
          });
          if (ok) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      })();
      expect(up).toBe(true);

      const file = tempFile('live');
      fs.writeFileSync(file, JSON.stringify({ port, nonce: 'x', pid: child.pid, version: '0', startedAt: 0 }));

      const { code, out } = await runStop(file);

      expect(code).toBe(0);
      expect(out).toContain('stopped');
      expect(fs.existsSync(file)).toBe(false);
      expect(child.killed || child.exitCode !== null || !isAlive(child.pid!)).toBe(true);
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  });
});

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
