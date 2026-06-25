import { test, expect, type Page } from '@playwright/test';
import { WebSocket } from 'ws';
import { waitForApp } from './helpers';

// Proves the Settings "Network" tab shows a live count of connected WebSocket
// clients, driven by the server's clientCount push (broadcast on every connect
// and disconnect). We drive the real backend on :3001: the page itself is one
// client, and a few raw Node `ws` clients are opened/closed to move the count.
//
// The integration project runs several workers against the SAME backend, so the
// absolute count is noisy (other workers' pages connect and disconnect). The
// assertions are therefore noise-tolerant: opening N clients can only RAISE the
// count, so we assert a lower bound of (this page + N); closing them must drop
// the count below the peak we observed while they were open.

const BACKEND = 'http://localhost:3001';

async function getNonce(): Promise<string> {
  const res = await fetch(`${BACKEND}/nonce`);
  return (await res.text()).trim();
}

// Open a raw WS client and resolve once it is established. localhost is always an
// allowed Origin, and an absent ?dir= falls back to the server cwd (which exists).
function openClient(nonce: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:3001/agent?nonce=${nonce}`, { origin: 'http://localhost:5173' });
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) => reject(new Error('upgrade failed: ' + res.statusCode)));
    ws.on('error', reject);
  });
}

function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => { ws.on('close', () => resolve()); ws.close(); });
}

async function openNetworkTab(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Network' }).click();
  await expect(page.getByText('Network access', { exact: true })).toBeVisible();
}

const countLocator = (page: Page) => page.getByTestId('active-connections');
const readCount = (page: Page) =>
  countLocator(page).textContent().then((t) => parseInt((t ?? '').trim(), 10) || 0);

test.describe('active connection count (integration)', () => {
  test('the Network tab shows a live client count that tracks connects and disconnects', async ({ page }) => {
    await waitForApp(page);
    await openNetworkTab(page);

    // The pull (getClientCount on mount) resolves to a real number; this page is
    // itself one connected client, so the count is at least 1.
    await expect(countLocator(page)).toHaveText(/^\d+$/);
    await expect.poll(() => readCount(page)).toBeGreaterThanOrEqual(1);

    const nonce = await getNonce();
    const N = 3;

    // Opening N extra clients pushes the count up live (no refresh). Lower bound
    // (this page + N) is robust to other workers, whose clients only add.
    const extras = await Promise.all(Array.from({ length: N }, () => openClient(nonce)));
    await expect.poll(() => readCount(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(1 + N);
    const peak = await readCount(page);

    // Closing them pushes the count back down below the peak.
    await Promise.all(extras.map(closeClient));
    await expect.poll(() => readCount(page), { timeout: 10_000 }).toBeLessThan(peak);
  });
});
