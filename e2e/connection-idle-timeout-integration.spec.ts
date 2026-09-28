import { test, expect, type Page } from './provider-fixtures';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureCompiled, ensureBuilt, startDaemon, stopDaemon, type DaemonHandle,
} from './daemonHelpers';

// The client-side half of the idle-connection timeout: once the server closes a real
// browser connection for being idle (channel.ts CLOSE_CODE_IDLE), the page must not
// silently reconnect via the ordinary backoff loop - closing it again next sweep would
// achieve nothing, since simply rejoining does not touch the server's idle clock. But
// unlike a manual "disconnect me" from Connected Clients, it SHOULD come back on its own
// the moment the tab is looked at again, with no click needed - that automatic path is
// the whole reason this feature exists as a *timeout* rather than a second copy of the
// disconnect button.
//
// One daemon for the whole file, configured with a short connectionIdleTimeoutSec and a
// fast sweep interval (ARGUS_REAP_SWEEP_MS) so the wait is seconds, not minutes.
test.describe.configure({ mode: 'serial' });

const PORT = 3098;
const BASE = `http://localhost:${PORT}`;

let d: DaemonHandle | undefined;
let configPath: string;

test.beforeAll(async () => {
  ensureCompiled();
  ensureBuilt();
  configPath = path.join(os.tmpdir(), `argus-e2e-connidle-cfg-${Date.now()}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ connectionIdleTimeoutSec: 1 }));
  // Env vars are inherited fresh by the spawned child process, so this is safe even
  // though other spec files in the same (serial, workers:1) run may load the compiled
  // backend in-process with a different value - that capture happens per-process, and
  // this daemon is its own process.
  process.env.ARGUS_REAP_SWEEP_MS = '300';
  d = await startDaemon({ port: PORT, configPath, idleMs: 5 * 60_000 });
});

test.afterAll(() => {
  stopDaemon(d);
  d = undefined;
  delete process.env.ARGUS_REAP_SWEEP_MS;
  try { fs.unlinkSync(configPath); } catch { /* already gone */ }
});

function makeTempDir(tag: string): string {
  const dir = path.join(os.tmpdir(), `argus-connidle-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// document.hidden/visibilityState are read-only getters, so a real "tab backgrounded"
// simulation has to override them before dispatching the event ws-bridge.js listens for.
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

async function gotoDaemon(page: Page, dir: string): Promise<void> {
  const placeholder = page.getByPlaceholder('Ask Argus');
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt === 1) await page.goto(`${BASE}/?dir=${encodeURIComponent(dir)}`, { waitUntil: 'domcontentloaded' });
    else await page.reload({ waitUntil: 'domcontentloaded' });
    try {
      await expect(placeholder).toBeVisible({ timeout: 10_000 });
      return;
    } catch {
      if (attempt === 3) throw new Error('app failed to mount');
    }
  }
}

test('an idle-closed page stays down while hidden, and reconnects on its own once visible - no click', { tag: ["@shared"] }, async ({ page }) => {
  const dir = makeTempDir('auto');
  await gotoDaemon(page, dir);
  await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 10_000 });

  // Nothing else touches this connection, so the real sweep (300ms) closes it once it
  // has sat past the configured 1s idle limit - no server-side trigger needed, this is
  // the real reaper running on its real timer against a real socket.
  const reconnectBtn = page.getByTestId('ws-reconnect');
  await expect(reconnectBtn).toBeVisible({ timeout: 10_000 });
  await expect(reconnectBtn).toHaveAttribute('title', /reconnects automatically/i);

  // Simulate the tab being backgrounded - it must stay down. No click, no visibility
  // change yet, so nothing should bring it back on its own.
  await setHidden(page, true);
  await page.waitForTimeout(1500);
  await expect(reconnectBtn).toBeVisible();
  await expect(page.locator('[title="Connected"]')).toHaveCount(0);

  // The decisive step: becoming visible again is itself the "explicit" way back, with
  // no click on the Reconnect button at all.
  await setHidden(page, false);
  await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 10_000 });
  await expect(reconnectBtn).toHaveCount(0);
});

test('a peer-style disconnect does not auto-reconnect on the same visibility trigger', { tag: ["@shared"] }, async ({ page }) => {
  // The control for the test above: without it, a build that resurrected ANY terminal
  // close on visibility (not just an idle one) would pass the primary test too, since
  // both closes look identical from the outside except for their reason.
  const dir = makeTempDir('peer');
  await gotoDaemon(page, dir);
  await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 10_000 });

  // A second raw client disconnects this page's own connection, the same way the
  // Connected Clients "disconnect" button does - CLOSE_CODE_DISCONNECTED, not an idle
  // reap, so nothing here depends on the configured idle timeout at all.
  const nonce = (await (await fetch(`${BASE}/nonce`)).text()).trim();
  const ctl = new WebSocket(
    `ws://localhost:${PORT}/agent?nonce=${encodeURIComponent(nonce)}&dir=${encodeURIComponent(dir)}&client=browser`,
    { origin: BASE },
  );
  await new Promise<void>((resolve, reject) => {
    ctl.on('open', () => resolve());
    ctl.on('error', reject);
  });

  const targetId = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no clientList reply')), 5000);
    ctl.on('message', (data: Buffer) => {
      let msg: { type?: string; clients?: Array<{ id: number; current: boolean; workspacePath?: string }> };
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== 'clientList') return;
      clearTimeout(timer);
      const row = (msg.clients ?? []).find(
        r => !r.current && r.workspacePath && path.resolve(r.workspacePath) === path.resolve(dir),
      );
      if (!row) { reject(new Error('page connection not found in clientList')); return; }
      resolve(row.id);
    });
    ctl.send(JSON.stringify({ type: 'listClients' }));
  });
  ctl.send(JSON.stringify({ type: 'closeClient', id: targetId }));

  const reconnectBtn = page.getByTestId('ws-reconnect');
  await expect(reconnectBtn).toBeVisible({ timeout: 10_000 });
  // The two reasons must read differently even before the visibility check below.
  await expect(reconnectBtn).not.toHaveAttribute('title', /reconnects automatically/i);

  await setHidden(page, true);
  await setHidden(page, false);
  await page.waitForTimeout(1500);
  // Still down: for a peer close, becoming visible is not an "explicit" ask.
  await expect(reconnectBtn).toBeVisible();
  await expect(page.locator('[title="Connected"]')).toHaveCount(0);

  // The manual click still works regardless of reason - it is the one thing both closes
  // share as a way back.
  await reconnectBtn.click();
  await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 10_000 });

  ctl.close();
});
