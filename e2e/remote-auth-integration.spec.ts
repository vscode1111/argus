import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The gate itself, against real servers. Two halves:
//
//  A. the shared dev server, which has no password configured - so it proves the strict
//     default (remote refused, local untouched) without touching any credential;
//  B. an isolated in-process server with a password, for the login exchange, the
//     lockout and the revocation.
//
// A connection to this machine's own LAN address has a NON-loopback peer address, so it
// takes the same path a phone does - which is what makes any of this testable without a
// second machine (verified: it is classified remote and refused).

const PORT = process.env.ARGUS_E2E_PORT ?? '3001';
const LAN = '192.168.0.136';
const ROOT = path.resolve(__dirname, '..');

function connect(host: string, port: string | number, query: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}:${port}/agent?${query}`);
    const done = (r: string) => { try { ws.close(); } catch { /* closing */ } resolve(r); };
    ws.on('open', () => done('open'));
    ws.on('unexpected-response', (_q, res) => done(`refused ${res.statusCode}`));
    ws.on('error', (e) => done(`error ${e.message}`));
  });
}

async function nonceStatus(host: string, port: string | number, token?: string): Promise<number> {
  const res = await fetch(`http://${host}:${port}/nonce${token ? `?auth=${token}` : ''}`);
  return res.status;
}

test.describe('remote access gate (integration)', () => {
  test('refuses a remote peer and leaves local untouched when no password is set', async () => {
    const localNonce = await nonceStatus('127.0.0.1', PORT);
    expect(localNonce).toBe(200);
    const nonce = await (await fetch(`http://127.0.0.1:${PORT}/nonce`)).text();
    const dir = encodeURIComponent(ROOT);

    // The control, and it is the one that matters most: the extension panel and local
    // dev must not have been asked for anything.
    expect(await connect('127.0.0.1', PORT, `nonce=${nonce}&dir=${dir}`)).toBe('open');

    // A client with no Origin header at all - the case that used to be treated as local
    // from anywhere, because the gate read a header instead of the peer address.
    expect(await connect(LAN, PORT, `nonce=${nonce}&dir=${dir}`)).toBe('refused 401');
    expect(await nonceStatus(LAN, PORT)).toBe(401);
    // Knowing the nonce is not enough either: it is not a credential.
    expect(await connect(LAN, PORT, `nonce=${nonce}&dir=${dir}&auth=${'f'.repeat(64)}`)).toBe('refused 401');
  });

  test('logs a remote client in, then locks it out, then revokes it', async () => {
    // Its own server and its own credential file: the shared one must stay password-free
    // for the test above, and the real ~/.claude/argus-auth.json is never touched.
    const priorAuthFile = process.env.ARGUS_AUTH_FILE;
    const authFile = path.join(os.tmpdir(), `argus-e2e-auth-${Date.now()}.json`);
    const cfgFile = path.join(os.tmpdir(), `argus-e2e-authcfg-${Date.now()}.json`);
    fs.writeFileSync(cfgFile, JSON.stringify({ allowNetworkAccess: true }));
    process.env.ARGUS_AUTH_FILE = authFile;
    process.env.ARGUS_CONFIG = cfgFile;
    process.env.ARGUS_USAGE_POLL = '0';

    const serverJs = path.join(ROOT, 'out', 'backend', 'index.js');
    if (!fs.existsSync(serverJs)) execSync('yarn compile', { cwd: ROOT, stdio: 'ignore' });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { startServer } = require(serverJs);
    const auth = require(path.join(ROOT, 'out', 'backend', 'auth.js'));
    const PW = 'scub-lan-password';
    const port = 3095;
    const server = await startServer({ port });

    const login = async (password: string) => {
      const res = await fetch(`http://${LAN}:${port}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'scub', password }),
      });
      return { status: res.status, body: await res.json() as { token?: string; error?: string } };
    };

    try {
      const dir = encodeURIComponent(ROOT);
      // With nothing configured, /login says so rather than counting it as a failure -
      // "nobody can get in yet" is a different answer from "wrong password".
      expect((await login(PW)).status).toBe(403);

      expect(auth.setPassword('scub', PW).ok).toBe(true);
      expect((await login('wrong-one')).status).toBe(401);

      const good = await login(PW);
      expect(good.status).toBe(200);
      const token = good.body.token!;
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      expect(await nonceStatus(LAN, port, token)).toBe(200);
      const nonce = await (await fetch(`http://${LAN}:${port}/nonce?auth=${token}`)).text();
      expect(await connect(LAN, port, `nonce=${nonce}&dir=${dir}&auth=${token}`)).toBe('open');
      // The token is the credential, so the nonce alone still gets nowhere.
      expect(await connect(LAN, port, `nonce=${nonce}&dir=${dir}`)).toBe('refused 401');
      // ...and a local peer never needed any of it.
      expect(await connect('127.0.0.1', port, `nonce=${nonce}&dir=${dir}`)).toBe('open');

      // Lockout: guessing over a LAN has to stop being free.
      for (let i = 0; i < 5; i++) await login(`bad-${i}`);
      const locked = await login(PW);   // even the RIGHT password, while locked out
      expect(locked.status).toBe(429);

      // Revocation: a password change must invalidate tokens minted against the old one.
      auth.resetAuthState();
      const fresh = (await login(PW)).body.token!;
      expect(await connect(LAN, port, `nonce=${nonce}&dir=${dir}&auth=${fresh}`)).toBe('open');
      expect(auth.setPassword('scub', 'scub-new-password', PW).ok).toBe(true);
      expect(await connect(LAN, port, `nonce=${nonce}&dir=${dir}&auth=${fresh}`)).toBe('refused 401');
    } finally {
      server.close();
      // Restore the suite-wide override; leaving this pointed at a deleted temp file
      // would make any later spec in this worker see "no password" for the wrong reason.
      process.env.ARGUS_AUTH_FILE = priorAuthFile;
      for (const f of [authFile, cfgFile]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    }
  });
});
