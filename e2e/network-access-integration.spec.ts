import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocket } from 'ws';
import { waitForApp } from './helpers';

// These tests drive the real Settings "Network" tab and then prove the backend
// actually enforces the choice at the WebSocket upgrade. A browser cannot forge
// the Origin header, so we probe the gate directly with a Node `ws` client that
// can set an arbitrary Origin. They share one dev backend on :3001 (the same one
// the page is connected to) and mutate e2e/argus.json via the UI, so they must
// run serially and restore the config afterwards.
test.describe.configure({ mode: 'serial' });

const BACKEND = 'http://localhost:3001';
const CONFIG_PATH = path.resolve(__dirname, 'argus.json');

async function getNonce(): Promise<string> {
  const res = await fetch(`${BACKEND}/nonce`);
  return (await res.text()).trim();
}

// Resolves to 'open' if the upgrade succeeded, otherwise the HTTP status the
// server replied with on the upgrade: 403 = Origin rejected, 401 = bad nonce.
function probeOrigin(origin: string, nonce: string): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:3001/agent?nonce=${nonce}`, { origin });
    let settled = false;
    const done = (r: 'open' | number) => { if (!settled) { settled = true; resolve(r); } };
    ws.on('open', () => { ws.close(); done('open'); });
    ws.on('unexpected-response', (_req, res) => { done(res.statusCode ?? -1); });
    ws.on('error', () => { done(-1); });
  });
}

// The backend writes argus.json and re-reads it per upgrade, so a UI change lands
// asynchronously - poll the gate until it reflects the expected verdict.
async function expectOrigin(origin: string, nonce: string, expected: 'open' | number) {
  await expect.poll(() => probeOrigin(origin, nonce), { timeout: 15_000 }).toBe(expected);
}

async function openNetworkTab(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Network' }).click();
  // The toggle <input> is visually collapsed, so wait on the visible row label.
  await expect(page.getByText('Network access', { exact: true })).toBeVisible();
}

// The toggle's <input> is visually collapsed (0x0, opacity 0), so it is not
// directly clickable - click the row label, which is wired via htmlFor.
async function setNetworkAccess(page: Page, on: boolean) {
  const checkbox = page.getByLabel('Network access');
  if ((await checkbox.isChecked()) !== on) {
    await page.getByText('Network access', { exact: true }).click();
  }
  await expect(checkbox).toBeChecked({ checked: on });
}

test.describe('network access (integration)', () => {
  let original: string;
  test.beforeAll(() => { original = fs.readFileSync(CONFIG_PATH, 'utf8'); });
  test.afterAll(() => { fs.writeFileSync(CONFIG_PATH, original); });

  test('adding an allowed origin in the Network tab lets that origin connect', async ({ page }) => {
    await waitForApp(page);
    const nonce = await getNonce();

    // Baseline: an unconfigured external origin is rejected, but local always works.
    await expectOrigin('http://scub-tunnel.test', nonce, 403);
    await expectOrigin('http://localhost:5173', nonce, 'open');

    // Add the host through the UI (commits on Enter).
    await openNetworkTab(page);
    await setNetworkAccess(page, true);
    const origins = page.getByLabel('Allowed origins');
    await origins.fill('scub-tunnel.test');
    await origins.press('Enter');

    // The backend now allows the configured host, while an unrelated external
    // origin stays blocked.
    await expectOrigin('http://scub-tunnel.test', nonce, 'open');
    await expectOrigin('http://scub-evil.test', nonce, 403);
  });

  test('the Network access toggle is a kill switch for all non-local origins', async ({ page }) => {
    await waitForApp(page);
    const nonce = await getNonce();

    await openNetworkTab(page);

    // With network access on, private-LAN origins (and a configured host) are allowed.
    // Set allowedOrigins directly here so this test is independent of the previous test's state.
    await setNetworkAccess(page, true);
    const originsInput = page.getByLabel('Allowed origins');
    await originsInput.fill('scub-tunnel.test');
    await originsInput.press('Enter');
    await expectOrigin('http://10.1.2.3', nonce, 'open');
    await expectOrigin('http://scub-tunnel.test', nonce, 'open');

    // Flip the switch off: every non-local origin is now rejected, but localhost
    // (the local machine / this very page) is never locked out.
    await setNetworkAccess(page, false);
    await expectOrigin('http://10.1.2.3', nonce, 403);
    await expectOrigin('http://scub-tunnel.test', nonce, 403);
    await expectOrigin('http://localhost:5173', nonce, 'open');

    // Flip it back on and the LAN origin is allowed again.
    await setNetworkAccess(page, true);
    await expectOrigin('http://10.1.2.3', nonce, 'open');
  });

  test('turning Network access off disconnects a live non-local client at once', async ({ page }) => {
    await waitForApp(page);
    const nonce = await getNonce();

    await openNetworkTab(page);
    await setNetworkAccess(page, true);

    // Open a live connection from a private-LAN origin and keep it open.
    const ws = new WebSocket('ws://localhost:3001/agent?nonce=' + nonce, { origin: 'http://10.9.9.9' });
    const closeCode = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('unexpected-response', (_req, res) => reject(new Error('upgrade failed: ' + res.statusCode)));
      ws.on('error', reject);
    });

    // Flip the kill switch off: the live client must be dropped without a restart.
    await setNetworkAccess(page, false);
    const code = await Promise.race([
      closeCode,
      new Promise<string>((r) => setTimeout(() => r('still-open'), 10_000)),
    ]);
    ws.terminate();
    expect(code).toBe(4403);
  });
});
