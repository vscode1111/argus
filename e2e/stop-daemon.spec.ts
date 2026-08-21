import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

// "Stop daemon" (Settings > Info) shuts down the server this panel is connected to -
// the in-app `yarn daemon:stop`. Only the arm step (client-only, sends nothing) and
// the result rendering (via a simulated reply) are covered here. The real second
// click is deliberately never performed: `stopDaemon` is not suppressed for mock
// runs, so it would reach the live e2e dev server on :3001, and if the "a server
// that cannot exit itself refuses" gate in index.ts ever regressed, that click would
// take the shared backend down mid-suite and cascade into every later test. Both real
// paths (a daemon stops, a non-daemon server refuses) are covered against isolated
// servers in daemon-lifecycle-integration.spec.ts instead.

async function openInfoTab(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Info' }).click();
  return dialog;
}

// Outgoing webview->server messages never reach window's own 'message' event (they go
// out over the real WS), so "nothing was sent" has to be asserted at the socket.
async function captureSentTypes(page: import('@playwright/test').Page, action: () => Promise<void>, waitMs = 300): Promise<string[]> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __sentTypes: string[] }).__sentTypes = seen;
    const origSend = WebSocket.prototype.send;
    (window as unknown as { __restoreSend: () => void }).__restoreSend = () => { WebSocket.prototype.send = origSend; };
    WebSocket.prototype.send = function (this: WebSocket, data: unknown) {
      try { const msg = JSON.parse(data as string); if (msg && typeof msg.type === 'string') seen.push(msg.type); } catch {}
      return origSend.call(this, data as string);
    };
  });
  await action();
  await page.waitForTimeout(waitMs);
  return await page.evaluate(() => {
    const w = window as unknown as { __sentTypes: string[]; __restoreSend: () => void };
    w.__restoreSend();
    return w.__sentTypes;
  });
}

test.describe('stop daemon button', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('arms on first click and auto-reverts, without sending a message', async ({ page }) => {
    const dialog = await openInfoTab(page);
    const btn = dialog.getByTestId('stop-daemon');
    await expect(btn).toHaveText('Stop daemon');

    const sent = await captureSentTypes(page, async () => {
      await btn.click();
      await expect(btn).toHaveText('Click again to confirm');
    }, 1000);
    // Still armed well inside the 4s window, and nothing went out - the request is
    // only sent by a second click, which this test never makes.
    await expect(btn).toHaveText('Click again to confirm');
    expect(sent).not.toContain('stopDaemon');

    await expect(btn).toHaveText('Stop daemon', { timeout: 5000 });
  });

  test('renders the stopped result from a simulated reply', async ({ page }) => {
    const dialog = await openInfoTab(page);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'daemonStopping', stopped: true } }));
    });
    await expect(dialog.getByTestId('stop-daemon-result')).toHaveText('Daemon stopped. Reconnect to start it again.');
  });

  test('renders the "not a daemon" result from a simulated reply', async ({ page }) => {
    const dialog = await openInfoTab(page);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'daemonStopping', stopped: false } }));
    });
    await expect(dialog.getByTestId('stop-daemon-result')).toHaveText('This server is not a daemon - nothing to stop.');
  });

  test('a restart does not render a stop result (different message)', async ({ page }) => {
    const dialog = await openInfoTab(page);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'daemonRestarting', port: 3017, url: 'http://localhost:3017/' } }));
    });
    await page.waitForTimeout(200);
    await expect(dialog.getByTestId('stop-daemon-result')).toHaveCount(0);
  });
});
