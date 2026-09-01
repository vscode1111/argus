import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

// Record what the app tried to open externally. Must be installed before the app
// loads, since the click handler calls window.open directly.
async function spyOnOpen(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
}

const opened = (page: Page) =>
  page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

// A URL's path component is indistinguishable from a real path, so the linkifier used to
// claim it: `https://192.168.0.12/ui/scripts/main.js` rendered with
// `/192.168.0.12/ui/scripts/main.js` underlined, and clicking opened a preview for a file
// that does not exist. The URL must stay clickable - it just has to open as a URL.
// Every case pairs it with a real path in the same message, so "nothing is linkified
// anymore" cannot pass.
const URL = 'https://192.168.0.12/ui/scripts/main.js';
const LOCAL_URL = 'http://localhost:3001/webview.js';
const REAL_PATH = 'src/backend/session.ts:42';

test.describe('URLs open as URLs, not as file paths', () => {
  test.beforeEach(async ({ page }) => {
    await spyOnOpen(page);
    await waitForApp(page);
  });

  // The reported case: a pasted log inside a fenced block, where remark-gfm does not
  // autolink and the path scan is the only thing touching the text.
  test('a URL in a fenced code block is an external link, the path is a file link', async ({ page }) => {
    const log = [
      '```',
      `[WARNING] VMService ${URL} .. invalid VM 1 color`,
      `[ERROR] Failed to load resource: 500 @ ${REAL_PATH}`,
      '```',
    ].join('\n');

    await send(page, { type: 'message', message: { id: '1', role: 'assistant', content: log } });

    const url = page.locator('a.external-url-link');
    await expect(url).toHaveCount(1);
    await expect(url).toHaveText(URL);
    await expect(url).toHaveAttribute('href', URL);

    const paths = page.locator('a.file-path-link');
    await expect(paths).toHaveCount(1);
    await expect(paths).toHaveText(REAL_PATH);
  });

  test('clicking the URL opens it externally and never opens a file preview', async ({ page }) => {
    await send(page, {
      type: 'message',
      message: { id: '2', role: 'assistant', content: '```\nlog line ' + URL + '\n```' },
    });

    await page.locator('a.external-url-link').click();

    expect(await opened(page)).toEqual([URL]);
    // The file previewer is a dialog; a wrongly-classified URL used to open it empty.
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });

  test('a URL in inline code is not broken up mid-host', async ({ page }) => {
    await send(page, {
      type: 'message',
      message: { id: '3', role: 'assistant', content: `Bundle \`${LOCAL_URL}\` built from \`${REAL_PATH}\`.` },
    });

    const url = page.locator('a.external-url-link');
    await expect(url).toHaveCount(1);
    await expect(url).toHaveText(LOCAL_URL);

    const paths = page.locator('a.file-path-link');
    await expect(paths).toHaveCount(1);
    await expect(paths).toHaveText(REAL_PATH);
  });

  // In prose remark-gfm autolinks the URL itself, so it arrives as an <a> that
  // withLinkedPaths skips. It must still open through the host: a bare href navigates
  // the Argus page away in browser mode.
  test('a URL in prose stays one link and opens through the host', async ({ page }) => {
    await send(page, {
      type: 'message',
      message: { id: '4', role: 'assistant', content: `Panel at ${URL} is served from ${REAL_PATH}.` },
    });

    const link = page.locator(`a[href="${URL}"]`);
    await expect(link).toHaveText(URL);
    await link.click();
    expect(await opened(page)).toEqual([URL]);

    const paths = page.locator('a.file-path-link');
    await expect(paths).toHaveCount(1);
    await expect(paths).toHaveText(REAL_PATH);
  });

  // A user message is plain text, not markdown, so nothing else linkifies it.
  test('a URL in a user message is an external link', async ({ page }) => {
    await send(page, {
      type: 'message',
      message: { id: '5', role: 'user', content: `check ${URL} against ${REAL_PATH}` },
    });

    const url = page.locator('a.external-url-link');
    await expect(url).toHaveCount(1);
    await expect(url).toHaveText(URL);

    const paths = page.locator('a.file-path-link');
    await expect(paths).toHaveCount(1);
    await expect(paths).toHaveText(REAL_PATH);
  });

  // A link at the end of a sentence must not swallow the full stop.
  test('trailing sentence punctuation stays outside the link', async ({ page }) => {
    await send(page, {
      type: 'message',
      message: { id: '6', role: 'user', content: `panel is at ${URL}.` },
    });

    const url = page.locator('a.external-url-link');
    await expect(url).toHaveText(URL);
    await expect(page.locator('[class*="userMsg"]')).toContainText(`${URL}.`);
  });
});
