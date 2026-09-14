import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { waitForApp } from './helpers';

// The "Active connections" value in Settings > Network opens the list of clients this
// server is serving. `listClients` is in webview/index.html's MOCK_SUPPRESSED, so the
// live dev backend never answers here and these tests own the data - which is what lets
// them pin cases a dev machine will not produce on demand (a phone on the LAN, a client
// reading a past transcript, a server that cannot answer at all).

const ROW = '[data-testid="client-row"]';

function reply(clients: unknown[], extra: Record<string, unknown> = {}) {
  return { type: 'clientList', clients, ...extra };
}

// One local VS Code panel (the one reading the list) and one browser on the LAN, so
// every assertion below has a control row beside it in the same table.
const SAMPLE = [
  {
    id: 1, current: true, connectedAt: Date.now() - 3_600_000, address: '127.0.0.1', local: true,
    origin: 'vscode-webview://abc', kind: 'vscode', device: 'Windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Code/1.99',
    workspacePath: 'd:\\_Projects\\scub111g\\argus',
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', running: true,
  },
  {
    id: 2, current: false, connectedAt: Date.now() - 90_000, address: '192.168.0.12', local: false,
    origin: 'http://192.168.0.12:3017', kind: 'browser', device: 'iPhone',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1',
    workspacePath: '/home/scub/notes',
    sessionId: 'bbbbbbbb-5555-6666-7777-888888888888', running: false,
  },
];

async function openClientList(page: import('@playwright/test').Page, clients: unknown[] = SAMPLE, extra: Record<string, unknown> = {}) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Network' }).click();
  await page.getByTestId('active-connections').click();
  const dialog = page.getByRole('dialog', { name: 'Connected clients' });
  await expect(dialog).toBeVisible();
  // The modal registers its listener in an effect, so re-dispatch until it lands.
  await expect(async () => {
    await page.evaluate(payload => {
      window.dispatchEvent(new MessageEvent('message', { data: payload }));
    }, reply(clients, extra));
    await expect(dialog.getByTestId('clients-body')).not.toContainText('Loading...', { timeout: 250 });
  }).toPass({ timeout: 5000 });
  return { dialog, settings };
}

// Every outgoing message the dev shim swallows, which is the only observable proof the
// app asked for something at all (a suppressed message never reaches the socket).
function trackSuppressed(page: import('@playwright/test').Page): string[] {
  const seen: string[] = [];
  page.on('console', m => {
    const t = m.text();
    if (t.includes('[mock] suppressed')) seen.push(t.replace('[mock] suppressed ', '').trim());
  });
  return seen;
}

test.describe('connected client list', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('clicking the Active connections value asks the server for the client list', async ({ page }) => {
    const suppressed = trackSuppressed(page);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Network' }).click();
    await page.getByTestId('active-connections').click();

    await expect(page.getByRole('dialog', { name: 'Connected clients' })).toBeVisible();
    await expect.poll(() => suppressed).toContain('listClients');
  });

  test('renders each connection with its host, address, workspace, session and age', async ({ page }) => {
    const { dialog } = await openClientList(page);
    await expect(dialog.locator(ROW)).toHaveCount(2);

    const mine = dialog.locator(`${ROW}[data-client-id="1"]`);
    await expect(mine).toContainText('VS Code');
    await expect(mine).toContainText('127.0.0.1');
    await expect(mine).toContainText('argus');      // workspace, shown as its folder name
    await expect(mine).toContainText('aaaaaaaa');   // session, truncated to its first block
    await expect(mine).toContainText('1h 0m');      // connected-for, ticked from connectedAt

    const phone = dialog.locator(`${ROW}[data-client-id="2"]`);
    await expect(phone).toContainText('Browser');
    await expect(phone).toContainText('iPhone');
    await expect(phone).toContainText('192.168.0.12');
    await expect(phone).toContainText('notes');
  });

  test('marks the connection this panel is using, and only that one', async ({ page }) => {
    const { dialog } = await openClientList(page);
    await expect(dialog.locator(`${ROW}[data-client-id="1"]`).getByTestId('client-current-badge')).toBeVisible();
    await expect(dialog.locator(`${ROW}[data-client-id="2"]`).getByTestId('client-current-badge')).toHaveCount(0);
  });

  test('says which connections came from another device', async ({ page }) => {
    const { dialog } = await openClientList(page);
    // The address is the evidence, but only a reader who knows this machine's own
    // address can read 192.168.0.12 as remote - so the conclusion is stated too.
    await expect(dialog.locator(`${ROW}[data-client-id="2"]`).getByTestId('client-remote-badge')).toBeVisible();
    // Control: without it, badging every row would satisfy the assertion above.
    await expect(dialog.locator(`${ROW}[data-client-id="1"]`).getByTestId('client-remote-badge')).toHaveCount(0);
    await expect(dialog.getByTestId('clients-summary')).toHaveText('2 connections · 1 from another device');
  });

  test('states that every connection is local when none are remote', async ({ page }) => {
    // Stated rather than left blank: "is anyone else on this?" is the question the panel
    // exists to answer, and an absent badge cannot answer it.
    const { dialog } = await openClientList(page, [SAMPLE[0]]);
    await expect(dialog.getByTestId('clients-summary')).toHaveText('1 connection · all from this machine');
  });

  test('distinguishes a connection that is mid-turn from an idle one', async ({ page }) => {
    const { dialog } = await openClientList(page);
    const cell = (id: number) => dialog.locator(`${ROW}[data-client-id="${id}"] [data-testid="client-running"]`);
    await expect(cell(1)).toHaveText('yes');
    // The control: a build that painted every row "yes" (or every row "no") fails one
    // half of this pair.
    await expect(cell(2)).toHaveText('no');
  });

  test('marks a client that is reading a past transcript instead of its own session', async ({ page }) => {
    const { dialog } = await openClientList(page, [
      SAMPLE[0],
      { ...SAMPLE[1], viewingSessionId: 'cccccccc-9999-0000-1111-222222222222' },
    ]);
    // A browsing client's next send goes to the session it is reading, not the one its
    // entry is bound to - so the two ids differ and the row has to say which is which.
    await expect(dialog.locator(`${ROW}[data-client-id="2"]`).getByTestId('client-browsing-badge')).toBeVisible();
    await expect(dialog.locator(`${ROW}[data-client-id="1"]`).getByTestId('client-browsing-badge')).toHaveCount(0);
  });

  test('shows a dash for a session the CLI has not named yet', async ({ page }) => {
    const { dialog } = await openClientList(page, [{ ...SAMPLE[0], sessionId: undefined, running: false }]);
    const cells = await dialog.locator(`${ROW} td`).allTextContents();
    // A brand-new chat has no id until its first turn; printing an empty block, or
    // borrowing another row's id, would invent one.
    expect(cells).toContain('-');
  });

  test('reports why a listing failed instead of showing an empty server', async ({ page }) => {
    const { dialog } = await openClientList(page, [], { error: 'this server cannot list its connections' });
    await expect(dialog.getByTestId('clients-error')).toContainText('cannot list its connections');
    await expect(dialog.locator(ROW)).toHaveCount(0);
  });

  test('re-reads the list as soon as a connection opens or closes', async ({ page }) => {
    // The server pushes clientCount on every connect/disconnect, which is exactly the
    // moment this list went stale. Three pushes in a row have to produce three fresh
    // requests; the 3s background poll could account for at most one of them, so a
    // build that only polled fails this.
    const suppressed = trackSuppressed(page);
    await openClientList(page);
    const before = suppressed.filter(t => t === 'listClients').length;

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'clientCount', count: 4 } }));
      });
    }
    await expect
      .poll(() => suppressed.filter(t => t === 'listClients').length, { timeout: 2000 })
      .toBeGreaterThanOrEqual(before + 3);
  });

  test('the disconnect button asks the server to close that connection and drops the row', async ({ page }) => {
    // `closeClient` is suppressed in mock mode for the same reason `killCliProcess` is:
    // unsuppressed it would reach the live backend and drop another worker's page.
    const suppressed = trackSuppressed(page);
    const { dialog } = await openClientList(page);

    await dialog.locator(`${ROW}[data-client-id="2"]`).hover();
    await dialog.locator(`${ROW}[data-client-id="2"] [data-testid="client-disconnect"]`).click();

    await expect.poll(() => suppressed).toContain('closeClient');
    // Dropped optimistically; the next poll is the authority.
    await expect(dialog.locator(`${ROW}[data-client-id="2"]`)).toHaveCount(0);
    await expect(dialog.locator(`${ROW}[data-client-id="1"]`)).toHaveCount(1);
  });

  test('a refused disconnect says so instead of leaving the row silently gone', async ({ page }) => {
    const { dialog } = await openClientList(page);
    await dialog.locator(`${ROW}[data-client-id="2"]`).hover();
    await dialog.locator(`${ROW}[data-client-id="2"] [data-testid="client-disconnect"]`).click();

    // The row is already gone, so a refusal that said nothing would read as success
    // until the next poll quietly brought it back.
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'clientClosed', id: 2, closed: false, error: 'that connection is no longer open' },
      }));
    });
    await expect(dialog.getByTestId('client-disconnect-error')).toContainText('no longer open');
  });

  test('the disconnect button stays hidden until its row is hovered', async ({ page }) => {
    const { dialog } = await openClientList(page);
    const btn = dialog.locator(`${ROW}[data-client-id="2"] [data-testid="client-disconnect"]`);
    // Present for keyboard users, but not competing with the data until pointed at.
    await expect(btn).toHaveCSS('opacity', '0');
    await dialog.locator(`${ROW}[data-client-id="2"]`).hover();
    await expect(btn).not.toHaveCSS('opacity', '0');
  });

  test('warns that the current row disconnects this very panel', async ({ page }) => {
    const { dialog } = await openClientList(page);
    // Allowed, but it must not look like the same click as the others - it takes the
    // page you are reading offline.
    await expect(dialog.locator(`${ROW}[data-client-id="1"] [data-testid="client-disconnect"]`))
      .toHaveAttribute('title', /this panel's own connection/);
    await expect(dialog.locator(`${ROW}[data-client-id="2"] [data-testid="client-disconnect"]`))
      .not.toHaveAttribute('title', /this panel's own connection/);
  });

  test('Escape closes the client list and leaves Settings open', async ({ page }) => {
    const { dialog, settings } = await openClientList(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Both modals listen for Escape, so without the guard in SettingsModal one press
    // would close the pair.
    await expect(settings).toBeVisible();
  });
});

// The other half of the disconnect button, on the client that was disconnected. The
// bridge does not retry that one close, so the usual pulsing "reconnecting" dot would be
// a standing lie - it has to become the way back instead.
test.describe('disconnected-by-peer status', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  async function setStatus(page: import('@playwright/test').Page, connected: boolean, closedByPeer?: boolean) {
    await page.evaluate(([c, p]) => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'ws_status', connected: c, closedByPeer: p } }));
    }, [connected, closedByPeer] as [boolean, boolean | undefined]);
  }

  test('offers a Reconnect button after a deliberate disconnect, and only then', async ({ page }) => {
    await setStatus(page, false, true);
    await expect(page.getByTestId('ws-reconnect')).toBeVisible();
    await expect(page.getByTestId('ws-dot')).toHaveCount(0);

    // The control: an ordinary drop (daemon restart, network blip) IS retried by the
    // bridge, so it keeps the pulsing dot and must not offer a manual button - without
    // this, replacing the dot unconditionally would pass the assertion above.
    await setStatus(page, false, false);
    await expect(page.getByTestId('ws-reconnect')).toHaveCount(0);
    await expect(page.getByTestId('ws-dot')).toHaveAttribute('title', /reconnecting/);
  });

  test('goes back to the connected dot once the connection returns', async ({ page }) => {
    await setStatus(page, false, true);
    await expect(page.getByTestId('ws-reconnect')).toBeVisible();
    await setStatus(page, true);
    await expect(page.getByTestId('ws-reconnect')).toHaveCount(0);
    await expect(page.getByTestId('ws-dot')).toHaveAttribute('title', 'Connected');
  });
});

// The three descriptions a row makes about a connection are derived from request headers
// by pure functions, and each one has a case a real machine will not hand you on demand
// (an IPv6 loopback peer, a phone whose User-Agent also claims to be a Mac). Driven on
// the compiled bundle - no page, no server, since nothing here touches either.
test.describe('client description helpers', () => {
  const ROOT = path.resolve(__dirname, '..');
  const CLIENTS_JS = path.join(ROOT, 'out', 'backend', 'clients.js');
  let mod: {
    normalizeAddress: (a: string) => string;
    isLocalAddress: (a: string) => boolean;
    clientKind: (origin: string, browser: boolean) => string;
    deviceFromUserAgent: (ua: string) => string | undefined;
  };

  test.beforeAll(() => {
    if (!fs.existsSync(CLIENTS_JS)) execSync('yarn compile', { cwd: ROOT, stdio: 'ignore' });
    mod = require(CLIENTS_JS);
  });

  test('reads an IPv6-wrapped peer as the address a human would recognise', () => {
    // Node reports a v4 peer over a dual-stack socket as ::ffff:<addr>, and a loopback
    // connection made over IPv6 as ::1. Left raw, the panel answers "who is connected"
    // with a string the reader has to decode.
    expect(mod.normalizeAddress('::ffff:192.168.0.12')).toBe('192.168.0.12');
    expect(mod.normalizeAddress('::1')).toBe('127.0.0.1');
    expect(mod.normalizeAddress('192.168.0.12')).toBe('192.168.0.12');

    // The pair that decides the "remote" badge, and the whole point of the panel: an
    // IPv6 loopback must not be reported as another device.
    expect(mod.isLocalAddress('::1')).toBe(true);
    expect(mod.isLocalAddress('::ffff:127.0.0.1')).toBe(true);
    expect(mod.isLocalAddress('::ffff:192.168.0.12')).toBe(false);
  });

  test('tells a VS Code panel, a browser tab and something else apart', () => {
    expect(mod.clientKind('vscode-webview://abc', false)).toBe('vscode');
    expect(mod.clientKind('http://192.168.0.12:3017', false)).toBe('browser');
    expect(mod.clientKind('', true)).toBe('browser');   // client=browser, no Origin sent
    // A client that identifies as neither (a script, a probe, a future host) stays
    // unknown rather than being guessed into one of the two.
    expect(mod.clientKind('', false)).toBe('unknown');
  });

  test('names the device without being fooled by the platform a User-Agent borrows', () => {
    // An iPhone's UA says "like Mac OS X" and an Android's says "Linux", so a scan in
    // the obvious order reports the wrong device for the two cases that matter most -
    // the phone on the LAN is exactly the row this panel exists to explain.
    expect(mod.deviceFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1')).toBe('iPhone');
    expect(mod.deviceFromUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131')).toBe('Android');
    expect(mod.deviceFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1')).toBe('Mac');
    expect(mod.deviceFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131')).toBe('Windows');
    // Nothing recognisable reports nothing, rather than a guess the row would state as
    // fact next to an address.
    expect(mod.deviceFromUserAgent('curl/8.4.0')).toBeUndefined();
    expect(mod.deviceFromUserAgent('')).toBeUndefined();
  });
});
