import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

/**
 * Clicking an image a tool read must ask for the image the TOOL returned, not for
 * whatever is at that path now.
 *
 * The regression: the preview re-read the file off disk, so any image the agent had
 * since renamed, packaged or deleted opened as `Error reading file: ENOENT` rendered
 * as line 1 of a text file - while the bytes the model actually saw were sitting in
 * the transcript the whole time. They no longer travel inside the message (a session
 * of 48 image reads shipped 23.4MB of base64 that nothing rendered), so the click has
 * to fetch them by tool call id.
 */

// 1x1 transparent PNG. Small enough to inline, real enough for <img> to accept.
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function emitRead(page: Page, id: string, path: string, result: string) {
  return page.evaluate(({ id, path, result }) => {
    const input = { file_path: path };
    function fire(data: object) {
      window.dispatchEvent(new MessageEvent('message', { data }));
    }
    fire({ type: 'thinking_start' });
    fire({ type: 'tool_start', call: { id, name: 'Read', input } });
    fire({ type: 'tool_end', call: { id, name: 'Read', input, result } });
    fire({ type: 'done' });
  }, { id, path, result });
}

function reply(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

// Outgoing webview->server messages never surface on window's own 'message' event.
// `readToolImage` is in the dev shim's MOCK_SUPPRESSED list (so the live backend
// cannot answer it in a mock run), and suppression is logged - which is exactly the
// hook needed to prove the app asked for it. `readFilePreview` is NOT suppressed, so
// it would reach the socket, and the prototype patch is what proves it did not.
async function watchRequests(page: Page) {
  const suppressed: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[mock] suppressed')) suppressed.push(t.replace('[mock] suppressed ', '').trim());
  });
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __sentTypes: string[] }).__sentTypes = seen;
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: unknown) {
      try {
        const msg = JSON.parse(data as string);
        if (msg && typeof msg.type === 'string') seen.push(msg.type);
      } catch { /* binary frame */ }
      return origSend.call(this, data as string);
    };
  });
  return {
    suppressed,
    sent: () => page.evaluate(() => (window as unknown as { __sentTypes: string[] }).__sentTypes.slice()),
  };
}

const dialog = (page: Page) => page.locator('[role="dialog"]');

test.describe('tool image preview', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('an image Read fetches the tool image by id, never re-reads the file', async ({ page }) => {
    const watch = await watchRequests(page);
    // The result the backend now sends for an image: a marker, no bytes.
    await emitRead(page, 'img-1', 'D:/scub/gone/scub-scan.png', '[image image/png 174 KB]');

    const link = page.locator('[class*="toolFileLink"]', { hasText: 'scub-scan.png' });
    await expect(link).toBeVisible();
    await link.click();

    await expect(async () => {
      expect(watch.suppressed).toContain('readToolImage');
    }).toPass({ timeout: 3_000 });
    expect(await watch.sent()).not.toContain('readFilePreview');

    // A reply for a different tool call must not fill this one: the match is on the
    // call id, which is what makes two images in one turn land in the right modal.
    await reply(page, { type: 'toolImage', toolUseId: 'img-OTHER', path: 'D:/scub/other.png', content: PNG_1PX });
    await expect(dialog(page).getByTestId('preview-loading')).toBeVisible();
    await expect(dialog(page).locator('img')).toHaveCount(0);

    await reply(page, { type: 'toolImage', toolUseId: 'img-1', path: 'D:/scub/gone/scub-scan.png', content: PNG_1PX });
    const img = dialog(page).locator('img');
    await expect(img).toBeVisible({ timeout: 5_000 });
    expect(await img.getAttribute('src')).toBe(PNG_1PX);
  });

  test('the modal opens on the click and spins inside until the image arrives', async ({ page }) => {
    // `readToolImage` is suppressed in mock mode, so nothing answers until this test
    // does - which is exactly the "the host is still reading" state to assert on.
    await emitRead(page, 'img-slow', 'D:/scub/gone/scub-slow.png', '[image image/png 174 KB]');
    await page.locator('[class*="toolFileLink"]', { hasText: 'scub-slow.png' }).click();

    // The window is up before any content exists, and it already says which file.
    await expect(dialog(page)).toBeVisible({ timeout: 5_000 });
    await expect(dialog(page)).toContainText('scub-slow.png');
    const spinner = dialog(page).getByTestId('preview-loading');
    await expect(spinner).toBeVisible();
    await expect(dialog(page).locator('img')).toHaveCount(0);

    await reply(page, { type: 'toolImage', toolUseId: 'img-slow', path: 'D:/scub/gone/scub-slow.png', content: PNG_1PX });
    await expect(dialog(page).locator('img')).toBeVisible({ timeout: 5_000 });
    await expect(spinner).toBeHidden();
  });

  test('a text Read still opens from the result it already has', async ({ page }) => {
    // The control. Without it, a build that asked for a tool image on every file - or
    // one that asked for nothing at all - would pass the test above.
    const watch = await watchRequests(page);
    await emitRead(page, 'txt-1', 'D:/scub/notes.md', '     1\thello scub');

    await page.locator('[class*="toolFileLink"]', { hasText: 'notes.md' }).click();
    await expect(dialog(page)).toBeVisible({ timeout: 5_000 });
    await expect(dialog(page)).toContainText('hello scub');

    expect(watch.suppressed).not.toContain('readToolImage');
    expect(await watch.sent()).not.toContain('readFilePreview');

    // Nothing was fetched, so nothing should have spun. Waited out past the spinner's
    // delay, otherwise this passes for the wrong reason.
    await page.waitForTimeout(400);
    await expect(page.getByTestId('preview-loading')).toBeHidden();
  });
});
