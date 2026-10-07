import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

// "Stop all CLI processes" (Settings > Info) sends a machine-wide taskkill
// via the real backend - see killAllCliProcesses in src/backend/cli.ts.
// The mock host suppresses killAllCliProcesses before it reaches the real backend,
// so both confirmation clicks can be exercised without stopping host processes.

async function openInfoTab(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Info' }).click();
  return dialog;
}

// Outgoing webview->server messages never reach window's own 'message' event (they
// go out over the real WS connection), so asserting "nothing was sent" or "X was
// sent" has to intercept at the WebSocket level, not via addEventListener.
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
  const types = await page.evaluate(() => {
    const w = window as unknown as { __sentTypes: string[]; __restoreSend: () => void };
    w.__restoreSend();
    return w.__sentTypes;
  });
  return types;
}

test.describe('stop all CLI processes button', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('arms on first click and auto-reverts, without sending a message', async ({ page }) => {
    const dialog = await openInfoTab(page);
    const btn = dialog.getByTestId('kill-all-cli');
    await expect(btn).toHaveText('Stop all CLI processes');

    const sent = await captureSentTypes(page, async () => {
      await btn.click();
      await expect(btn).toHaveText('Click again to confirm');
    }, 1000);
    // Still armed well before the 4s window closes, and no killAllCliProcesses frame went
    // out (the real send only happens on the second click, which this test never does).
    await expect(btn).toHaveText('Click again to confirm');
    expect(sent).not.toContain('killAllCliProcesses');

    await expect(btn).toHaveText('Stop all CLI processes', { timeout: 5000 });
  });

  test('second click sends the shared stop request', async ({ page }) => {
    const suppressed: string[] = [];
    page.on('console', message => {
      const text = message.text();
      if (text.includes('[mock] suppressed')) suppressed.push(text.replace('[mock] suppressed ', '').trim());
    });
    const dialog = await openInfoTab(page);
    const btn = dialog.getByTestId('kill-all-cli');
    await btn.click();
    await btn.click();
    await expect(btn).toHaveText('Stopping...');
    await expect.poll(() => suppressed).toContain('killAllCliProcesses');
  });

  test('renders a success result from a simulated reply', async ({ page }) => {
    const dialog = await openInfoTab(page);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'killAllCliProcessesResult', count: 3 } }));
    });
    await expect(dialog.getByTestId('kill-all-cli-result')).toHaveText('Stopped 3 processes.');
  });

  test('renders a zero-count result from a simulated reply', async ({ page }) => {
    const dialog = await openInfoTab(page);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'killAllCliProcessesResult', count: 0 } }));
    });
    await expect(dialog.getByTestId('kill-all-cli-result')).toHaveText('No CLI processes were running.');
  });

  test('renders an error result from a simulated reply', async ({ page }) => {
    const dialog = await openInfoTab(page);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'killAllCliProcessesResult', count: 0, error: 'boom' } }));
    });
    const result = dialog.getByTestId('kill-all-cli-result');
    await expect(result).toHaveText('Failed to stop processes: boom');
  });

  test('re-fetches server info after a kill result, so CLI launches etc. do not go stale', async ({ page }) => {
    await openInfoTab(page);
    const sent = await captureSentTypes(page, async () => {
      await page.evaluate(() => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'killAllCliProcessesResult', count: 1 } }));
      });
    });
    expect(sent).toContain('getServerInfo');

    // And the row actually reflects a fresh reply, not a stale snapshot from mount.
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'serverInfo', port: 3001, cliLaunchCount: 42, sessionId: '', sessionPath: null, serverVersion: '0.0.80' } }));
    });
    await expect(page.getByTestId('cli-launches')).toHaveText('42');
  });
});
