import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

// "Stop all Claude CLI processes" (Settings > Info) sends a machine-wide taskkill
// via the real backend - see killAllClaude in src/backend/cli.ts. A real second
// click is intentionally never exercised here (mock or otherwise): killAllClaude
// is not in ws-bridge's MOCK_SUPPRESSED list, so it would reach the live dev
// backend and actually terminate every claude.exe on whatever machine runs this
// suite, including the CLI session driving an AI coding assistant on it. Only the
// arm step (client-only, no message sent) and the result rendering (via a
// simulated reply) are covered.

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

test.describe('stop all Claude CLI processes button', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('arms on first click and auto-reverts, without sending a message', async ({ page }) => {
    const dialog = await openInfoTab(page);
    const btn = dialog.getByTestId('kill-all-claude');
    await expect(btn).toHaveText('Stop all Claude CLI processes');

    const sent = await captureSentTypes(page, async () => {
      await btn.click();
      await expect(btn).toHaveText('Click again to confirm');
    }, 1000);
    // Still armed well before the 4s window closes, and no killAllClaude frame went
    // out (the real send only happens on the second click, which this test never does).
    await expect(btn).toHaveText('Click again to confirm');
    expect(sent).not.toContain('killAllClaude');

    await expect(btn).toHaveText('Stop all Claude CLI processes', { timeout: 5000 });
  });

  test('renders a success result from a simulated reply', async ({ page }) => {
    const dialog = await openInfoTab(page);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'killAllClaudeResult', count: 3 } }));
    });
    await expect(dialog.getByTestId('kill-all-claude-result')).toHaveText('Stopped 3 processes.');
  });

  test('renders a zero-count result from a simulated reply', async ({ page }) => {
    const dialog = await openInfoTab(page);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'killAllClaudeResult', count: 0 } }));
    });
    await expect(dialog.getByTestId('kill-all-claude-result')).toHaveText('No Claude CLI processes were running.');
  });

  test('renders an error result from a simulated reply', async ({ page }) => {
    const dialog = await openInfoTab(page);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'killAllClaudeResult', count: 0, error: 'boom' } }));
    });
    const result = dialog.getByTestId('kill-all-claude-result');
    await expect(result).toHaveText('Failed to stop processes: boom');
  });

  test('re-fetches server info after a kill result, so CLI launches etc. do not go stale', async ({ page }) => {
    await openInfoTab(page);
    const sent = await captureSentTypes(page, async () => {
      await page.evaluate(() => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'killAllClaudeResult', count: 1 } }));
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
