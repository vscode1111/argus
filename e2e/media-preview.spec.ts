import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { waitForApp } from './helpers';

/**
 * The media preview's UI half, plus the pure range parser behind it.
 *
 * Two things are worth pinning here that the integration spec cannot see cheaply. First,
 * that clicking a video asks for a **grant** and never for the file's contents - the
 * whole fix is that the bytes stop crossing the WebSocket, and a build that quietly went
 * back to `readFilePreview` would still play the video while re-creating the 51MB frame.
 * Second, that a path decides between `<video>` and `<audio>` correctly, which needs
 * both cases or "always render a video" passes.
 *
 * `mediaUrl` is in webview/index.html's MOCK_SUPPRESSED, so the live dev backend cannot
 * answer it during a mock run and the injected grant is the only data on screen; the
 * suppression is logged, which is also how we observe that the app asked.
 */

const VIDEO_PATH = 'd:\\scub\\clips\\scub-clip.mp4';
const AUDIO_PATH = 'd:\\scub\\clips\\scub-tone.wav';

// Real files for the cases whose answer must come from the real backend.
let fixtureDir: string;
let binFixture: string;
let txtFixture: string;

test.beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-media-mock-'));
  binFixture = path.join(fixtureDir, 'scub-blob.bin');
  const bin = Buffer.alloc(9000);
  for (let i = 0; i < bin.length; i++) bin[i] = i % 256; // contains NUL -> binary
  fs.writeFileSync(binFixture, bin);

  txtFixture = path.join(fixtureDir, 'scub-plain.txt');
  fs.writeFileSync(txtFixture, 'scub plain text fixture\nsecond line\n', 'utf-8');
});

test.afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

/**
 * The file viewer specifically. `[role="dialog"]` also matches the Dev Harness, which
 * is persisted in localStorage and sorts first in the DOM when it has ever been opened.
 */
const viewer = (page: Page) => page.locator('[role="dialog"][aria-label^="File viewer"]');

/**
 * Hold every media request open without answering it.
 *
 * An injected grant names a token no server ever minted, so a real request 404s, the
 * element raises `error` and the component replaces it with the failure card - which
 * is correct behaviour that makes an "is there a <video>" assertion unwinnable. Hanging
 * the request keeps the element in its loading state: no error, no fallback, and the
 * element under test stays on the page. Deliberately never fulfilled; a 200 with fake
 * bytes would raise a *decode* error instead and land in the same place.
 */
async function hangMediaRequests(page: Page) {
  await page.route('**/media/**', () => { /* intentionally never answered */ });
}

function fire(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

/**
 * Render a tool result holding a file path, which is the way a user meets a video in
 * practice: the agent mentions the file and the path linkifies.
 */
async function emitPathMessage(page: Page, filePath: string) {
  await page.evaluate((p) => {
    const fireOne = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    fireOne({ type: 'thinking_start' });
    fireOne({ type: 'text_chunk', text: `Saved to ${p}\n` });
    fireOne({ type: 'done' });
  }, filePath);
}

/** Watch what the app sends, including messages the mock shim suppresses. */
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
    sent: () => page.evaluate(() => (window as unknown as { __sentTypes: string[] }).__sentTypes),
  };
}

test.describe('media preview', () => {
  test('a dead playback link blames the link, not the codec', async ({ page }) => {
    await waitForApp(page);
    // 404 is what an expired grant really returns: grants live in the server's memory,
    // so every open preview dies when the daemon idle-exits. A media element reports
    // that with the SAME code as an undecodable container, so without asking the server
    // the card blamed the codec - sending the viewer to find a converter for a file
    // that was never broken. This is how the mock spec found it: the injected token
    // 404'd for real.
    await page.route('**/media/**', (route) => route.fulfill({ status: 404, body: '' }));

    await emitPathMessage(page, VIDEO_PATH);
    await page.locator('.file-path-link').first().click();
    await fire(page, {
      type: 'mediaGrant',
      path: VIDEO_PATH,
      token: 'scub-expired-token',
      kind: 'video',
      mediaType: 'video/mp4',
      size: 1024,
      port: 3001,
    });

    const card = page.locator('[data-testid="media-unsupported"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('link has expired');
    await expect(card).not.toContainText('no decoder');
  });

  test('a file the server serves but the browser cannot decode blames the codec', async ({ page }) => {
    await waitForApp(page);
    // The control for the test above. The server answers happily, so the only thing
    // left that can have failed is the decoder - and a build that had simply renamed
    // every failure "expired" would pass that test and fail this one.
    await page.route('**/media/**', (route) =>
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('not really an mp4') }));

    await emitPathMessage(page, VIDEO_PATH);
    await page.locator('.file-path-link').first().click();
    await fire(page, {
      type: 'mediaGrant',
      path: VIDEO_PATH,
      token: 'scub-undecodable',
      kind: 'video',
      mediaType: 'video/mp4',
      size: 17,
      port: 3001,
    });

    const card = page.locator('[data-testid="media-unsupported"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('no decoder');
    await expect(card).not.toContainText('expired');
  });

  test('clicking a video asks for a grant, never for its contents', async ({ page }) => {
    await waitForApp(page);
    await hangMediaRequests(page);
    const watch = await watchRequests(page);

    await emitPathMessage(page, VIDEO_PATH);
    await page.locator('.file-path-link').first().click();

    // The modal opens on the click itself, before any reply - over a remote link the
    // grant round trip is not instant, and a click that shows nothing reads as ignored.
    await expect(page.locator('[data-testid="preview-loading"]')).toBeVisible();

    await expect.poll(() => watch.suppressed).toContain('mediaUrl');
    // The regression guard: the bytes must not have been requested over the socket.
    // readFilePreview is NOT suppressed, so had it been sent it would appear here.
    expect(await watch.sent()).not.toContain('readFilePreview');

    await fire(page, {
      type: 'mediaGrant',
      path: VIDEO_PATH,
      token: 'scub-token-1',
      kind: 'video',
      mediaType: 'video/mp4',
      size: 22_546_903,
      port: 3001,
    });

    const player = page.locator('[data-testid="media-player"]');
    await expect(player).toBeVisible();
    await expect(page.locator('[data-testid="preview-loading"]')).toHaveCount(0);

    const video = page.locator('video');
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute('src', /\/media\/scub-token-1/);
    await expect(video).toHaveAttribute('controls', '');
    // Autoplay is requested. Whether the browser HONOURS it is the browser's call, not
    // ours (Chrome allows unmuted autoplay only with user activation), and Playwright
    // launches chromium with the policy disabled - measured, so an "it played"
    // assertion here would be about the flag rather than about this build. The
    // attribute is the part that is ours to get right.
    await expect(video).toHaveAttribute('autoplay', '');
    // Without this the timeline cannot appear until the file is fetched, which is the
    // behaviour being replaced.
    await expect(video).toHaveAttribute('preload', 'metadata');

    // No text rendering path may have run for media.
    await expect(page.locator('[data-line]')).toHaveCount(0);
    await expect(viewer(page).locator('select')).toHaveCount(0);
  });

  test('an audio grant renders an audio element, not a video one', async ({ page }) => {
    await waitForApp(page);
    await hangMediaRequests(page);
    await emitPathMessage(page, AUDIO_PATH);
    await page.locator('.file-path-link').first().click();

    await fire(page, {
      type: 'mediaGrant',
      path: AUDIO_PATH,
      token: 'scub-token-2',
      kind: 'audio',
      mediaType: 'audio/wav',
      size: 24_044,
      port: 3001,
    });

    await expect(page.locator('[data-testid="media-player"]')).toBeVisible();
    await expect(page.locator('audio')).toHaveCount(1);
    await expect(page.locator('video')).toHaveCount(0);
    // The caption is the only thing that says how big the file is, since an audio
    // element shows a duration but never a size.
    await expect(page.locator('[data-testid="media-player"]')).toContainText('23 KB');
    await expect(page.locator('[data-testid="media-player"]')).toContainText('audio/wav');
  });

  test('a refused grant explains itself instead of spinning', async ({ page }) => {
    await waitForApp(page);
    await emitPathMessage(page, VIDEO_PATH);
    await page.locator('.file-path-link').first().click();
    await expect(page.locator('[data-testid="preview-loading"]')).toBeVisible();

    await fire(page, {
      type: 'mediaGrant',
      path: VIDEO_PATH,
      error: 'Error reading file: ENOENT',
    });

    await expect(page.locator('[data-testid="preview-loading"]')).toHaveCount(0);
    await expect(viewer(page)).toContainText('Cannot play this file');
    await expect(viewer(page)).toContainText('ENOENT');
  });

  test('a binary file is described, and a text file still renders', async ({ page }) => {
    await waitForApp(page);

    // Real files and the real backend, no injected reply: `readFilePreview` is not
    // mock-suppressed, so an injected answer races the live one and the loser is
    // whichever the scheduler felt like. These two fixtures make the real reply the
    // answer under test.
    await emitPathMessage(page, binFixture);
    await page.locator('.file-path-link').first().click();

    const card = page.locator('[data-testid="preview-info"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Binary file');
    await expect(card).toContainText('8.8 KB');
    await expect(page.locator('[data-line]')).toHaveCount(0);

    // The control: an ordinary text file must still render as text, or a build that
    // showed the card for everything would pass the assertions above.
    await viewer(page).locator('[aria-label="Close"]').click();
    await emitPathMessage(page, txtFixture);
    await page.locator('.file-path-link').last().click();
    await expect(page.locator('[data-testid="preview-info"]')).toHaveCount(0);
    await expect(page.locator('[data-line]').first()).toBeVisible();
  });
});

/**
 * The range parser, on the compiled bundle. Pure, so it needs no page, no server and no
 * file - and it lives in the mock project for exactly that reason: an `-integration`
 * suffix would buy it a slot in the serial suite for nothing.
 *
 * The distinction worth keeping is "no range to honour" (undefined -> send everything)
 * versus "a range that cannot be met" (null -> 416). Collapsing them makes a bad request
 * silently return the whole file, which a player reads as a successful seek to 0.
 */
test.describe('parseRange', () => {
  const MEDIA_JS = path.resolve(__dirname, '..', 'out', 'backend', 'media.js');
  type ParseRange = (header: string | undefined, size: number) => { start: number; end: number } | undefined | null;
  let parseRange: ParseRange;

  test.beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    parseRange = (require(MEDIA_JS) as { parseRange: ParseRange }).parseRange;
  });

  test('parses the forms a media element actually sends', () => {
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
    expect(parseRange('bytes=-500', 1000)).toEqual({ start: 500, end: 999 });
    // An end past the file is clamped, not refused - Chrome asks for more than exists.
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    // A suffix longer than the file is the whole file.
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  test('absent or unparseable means send everything, not refuse', () => {
    expect(parseRange(undefined, 1000)).toBeUndefined();
    expect(parseRange('', 1000)).toBeUndefined();
    expect(parseRange('bytes=-', 1000)).toBeUndefined();
    expect(parseRange('items=0-10', 1000)).toBeUndefined();
    // Multi-range is deliberately answered with the whole file rather than multipart.
    expect(parseRange('bytes=0-99,200-299', 1000)).toBeUndefined();
  });

  test('a real but unmeetable range is a refusal, distinct from absent', () => {
    expect(parseRange('bytes=1000-1100', 1000)).toBeNull();
    expect(parseRange('bytes=5000-', 1000)).toBeNull();
    expect(parseRange('bytes=200-100', 1000)).toBeNull();
    expect(parseRange('bytes=-0', 1000)).toBeNull();
    // An empty file has no satisfiable range at all, so even byte 0 is past its end.
    expect(parseRange('bytes=0-', 0)).toBeNull();
  });
});
