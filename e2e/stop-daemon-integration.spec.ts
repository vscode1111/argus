import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import {
  ensureCompiled, ensureBuilt, startDaemon, stopDaemon, readInfo, isAlive, isPortUp, waitFor,
  type DaemonHandle,
} from './daemonHelpers';

// The whole "Stop daemon" flow through the real UI: a browser opens the page a real
// daemon serves, clicks the actual Settings > Info button twice (arm, then confirm),
// and that daemon process really exits. Isolated port + throwaway discovery file, so
// this never touches the user's own daemon on :3017 - which would kill whatever
// conversation is running through it, including the one that spawned this suite.
test.describe.configure({ mode: 'serial' });

const PORT = 3921;
const BASE = `http://localhost:${PORT}`;

let d: DaemonHandle | undefined;

test.beforeAll(async () => {
  ensureCompiled();
  ensureBuilt();
  // Long idle window so the only thing that can stop this daemon is the button.
  d = await startDaemon({ port: PORT, idleMs: 600_000 });
});

test.afterAll(() => { stopDaemon(d); d = undefined; });

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

test('the Info tab button stops the real daemon it is connected to', async ({ page }) => {
  const info = readInfo(d!.file);
  await gotoDaemon(page);
  await expect(page.locator('[title="Connected"]')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Info' }).click();

  // This panel is talking to the daemon under test, not some other server.
  await expect(dialog.getByTestId('server-version')).not.toHaveText('-');

  const btn = dialog.getByTestId('stop-daemon');
  await btn.click();
  await expect(btn).toHaveText('Click again to confirm');
  await btn.click();

  // The daemon answers before it goes, so the panel reports it rather than just
  // silently losing the connection.
  await expect(dialog.getByTestId('stop-daemon-result')).toHaveText('Daemon stopped. Reconnect to start it again.');

  // And the process is really gone - no discovery file, nothing on the port.
  expect(await waitFor(() => !isAlive(info.pid), 8000)).toBe(true);
  expect(fs.existsSync(d!.file)).toBe(false);
  expect(await isPortUp(PORT)).toBe(false);
});
