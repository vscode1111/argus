import { test, expect, type Page } from '@playwright/test';
import { WebSocket } from 'ws';
import {
  ensureCompiled, ensureBuilt, startDaemon, stopDaemon, readInfo, isPortUp, waitFor,
  uniqueConfigFile, uniqueDaemonFile, writeDaemonConfig,
  type DaemonHandle,
} from './daemonHelpers';
import * as fs from 'fs';

// Exercises the daemon's in-process self-restart (the browser-served "Apply (restart
// daemon)" button). The daemon takes its port from an isolated ARGUS_CONFIG, so the
// test can move the port by rewriting that file and then sending `restartDaemon`.
// Serial, per-test ports + throwaway discovery/config files.
test.describe.configure({ mode: 'serial' });

function openWs(port: number, nonce: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/agent?nonce=${nonce}`);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test.describe('daemon restart (integration)', () => {
  let d: DaemonHandle | undefined;
  let cfg: string | undefined;

  test.beforeAll(() => { ensureCompiled(); });
  test.afterEach(() => {
    stopDaemon(d); d = undefined;
    if (cfg) { try { fs.unlinkSync(cfg); } catch { /* gone */ } cfg = undefined; }
  });

  test('restartDaemon moves the daemon to the new configured port and broadcasts the new URL', async () => {
    cfg = uniqueConfigFile('move');
    const file = uniqueDaemonFile('move');
    writeDaemonConfig(cfg, { daemonPort: 4040, daemonIdleMs: 600_000 });
    d = await startDaemon({ file, configPath: cfg });
    expect(readInfo(file).port).toBe(4040);

    const ws = await openWs(4040, readInfo(file).nonce);
    const restarting = new Promise<{ port: number; url: string }>((resolve) => {
      ws.on('message', (m) => { const e = JSON.parse(m.toString()); if (e.type === 'daemonRestarting') resolve(e); });
    });

    // The user changes the port in the UI (rewrites config) and clicks Apply.
    writeDaemonConfig(cfg, { daemonPort: 4041, daemonIdleMs: 600_000 });
    ws.send(JSON.stringify({ type: 'restartDaemon' }));

    const msg = await Promise.race([
      restarting,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no daemonRestarting broadcast')), 8000)),
    ]);
    expect(msg.port).toBe(4041);
    expect(msg.url).toBe('http://localhost:4041/');

    // The replacement comes up on the new port, the old one is gone, and the discovery
    // file is handed off to the new daemon.
    expect(await waitFor(async () => await isPortUp(4041), 10_000)).toBe(true);
    // The outgoing daemon exits shortly after handing off (it can briefly overlap the
    // replacement, which is on a different port), so wait for the old port to go down.
    expect(await waitFor(async () => !(await isPortUp(4040)), 5_000)).toBe(true);
    expect(readInfo(file).port).toBe(4041);
    ws.close();
  });

  test('restartDaemon on the same port hands off to a fresh process', async () => {
    cfg = uniqueConfigFile('same');
    const file = uniqueDaemonFile('same');
    writeDaemonConfig(cfg, { daemonPort: 4042, daemonIdleMs: 600_000 });
    d = await startDaemon({ file, configPath: cfg });
    const pid1 = readInfo(file).pid;

    const ws = await openWs(4042, readInfo(file).nonce);
    ws.send(JSON.stringify({ type: 'restartDaemon' })); // config unchanged -> same port

    // A new process must take over the same port (force-start replacement waits out
    // EADDRINUSE until the outgoing daemon releases it).
    expect(await waitFor(() => { try { const i = readInfo(file); return i.pid !== pid1; } catch { return false; } }, 10_000)).toBe(true);
    expect(await isPortUp(4042)).toBe(true);
    expect(readInfo(file).pid).not.toBe(pid1);
    ws.close();
  });
});

// The full browser flow: drive the daemon-served Settings UI to change the port and
// click "Apply (restart daemon)", then assert the live UI + the real daemon followed.
test.describe('daemon restart - browser UI (integration)', () => {
  let d: DaemonHandle | undefined;
  let cfg: string | undefined;

  test.beforeAll(() => { ensureCompiled(); ensureBuilt(); });
  test.afterEach(() => {
    stopDaemon(d); d = undefined;
    if (cfg) { try { fs.unlinkSync(cfg); } catch { /* gone */ } cfg = undefined; }
  });

  async function openNetworkTab(page: Page): Promise<void> {
    await page.goto('http://localhost:4044/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByPlaceholder('Ask Argus')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Network' }).click();
    await expect(page.getByText('Daemon port', { exact: true })).toBeVisible();
  }

  test('changing the port and clicking Apply restarts the daemon and shows the new URL', async ({ page }) => {
    cfg = uniqueConfigFile('ui');
    const file = uniqueDaemonFile('ui');
    writeDaemonConfig(cfg, { daemonPort: 4044, daemonIdleMs: 600_000 });
    d = await startDaemon({ file, configPath: cfg });

    await openNetworkTab(page);

    // Change the daemon port 4044 -> 4045 (commits to the config via updateSettings).
    const portInput = page.locator('#input-daemon-port');
    await portInput.fill('4045');
    await portInput.blur();

    await page.getByRole('button', { name: /Apply.*restart daemon/i }).click();

    // The tab can't follow the port change (same-origin to 4044), so it surfaces the
    // new URL; the real daemon must now be listening on 4045 and the address row updates.
    await expect(page.getByText('Daemon moved', { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('http://localhost:4045/', { exact: false })).toBeVisible();
    await expect(page.getByTestId('http-address')).toHaveText('http://localhost:4045');
    expect(await waitFor(async () => await isPortUp(4045), 10_000)).toBe(true);
    expect(readInfo(file).port).toBe(4045);
  });
});
