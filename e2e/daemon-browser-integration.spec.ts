import { test, expect, type Page } from '@playwright/test';
import {
  ensureCompiled, ensureBuilt, startDaemon, stopDaemon, type DaemonHandle,
} from './daemonHelpers';

// Proves the daemon serves the full webview directly over HTTP (no Vite): a plain
// browser opening http://localhost:<port>/ gets browser.html + the built bundle +
// the shared ws-bridge.js, and connects over the daemon's own same-origin WebSocket
// using a runtime-fetched nonce. One daemon for the whole file, on a private port +
// throwaway discovery file.
test.describe.configure({ mode: 'serial' });

const PORT = 3920;
const BASE = `http://localhost:${PORT}`;

let d: DaemonHandle | undefined;

test.beforeAll(async () => {
  ensureCompiled();
  ensureBuilt();
  d = await startDaemon({ port: PORT });
});

test.afterAll(() => { stopDaemon(d); d = undefined; });

// Navigate to the daemon URL and wait for React to mount, retrying the load a few
// times (mount can be slow under load), mirroring the dev waitForApp helper.
async function gotoDaemon(page: Page): Promise<void> {
  const placeholder = page.getByPlaceholder('Ask Argus');
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt === 1) await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    else await page.reload({ waitUntil: 'domcontentloaded' });
    try {
      await expect(placeholder).toBeVisible({ timeout: 10_000 });
      return;
    } catch {
      if (attempt === 3) throw new Error('daemon-served app failed to mount');
    }
  }
}

test('serves the app at / and connects over its own same-origin WebSocket', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await gotoDaemon(page);

  // The shared bridge factory is present and the same-origin WS connected.
  expect(await page.evaluate(() => typeof (window as unknown as { createArgusBridge?: unknown }).createArgusBridge)).toBe('function');
  await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('serves the static asset allowlist and 404s anything else', async () => {
  const cases: Array<[string, number, RegExp | null]> = [
    ['/', 200, /text\/html/],
    ['/ws-bridge.js', 200, /javascript/],
    ['/webview.js', 200, /javascript/],
    ['/webview.css', 200, /css/],
    ['/nonce', 200, /text\/plain/],
    ['/does-not-exist', 404, null],
  ];
  for (const [route, status, type] of cases) {
    const res = await fetch(BASE + route);
    expect(res.status, `status for ${route}`).toBe(status);
    if (type) expect(res.headers.get('content-type') ?? '', `content-type for ${route}`).toMatch(type);
  }

  // The runtime nonce served at /nonce is the one the browser page uses to connect.
  const nonce = (await (await fetch(BASE + '/nonce')).text()).trim();
  expect(nonce).toMatch(/^[0-9a-f]{32}$/);
});
