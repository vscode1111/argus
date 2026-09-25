// Fixes the two mock tests that asserted a player renders.
//
// They injected a made-up grant, so the media element fetched a token the real dev
// server has never heard of, got a 404, raised `error`, and the component correctly
// swapped itself for the failure card - the assertions then hunted for an <audio> that
// had already been replaced. The product was right and the test was wrong.
//
// The fix is to stop the test depending on a live fetch at all: intercept the media URL
// and never answer it. The element then sits in its loading state with no error, which
// is precisely the state these two tests are about - that the right ELEMENT is created
// with the right attributes. Whether bytes decode is the integration spec's job, where
// a real server serves a real file.
const fs = require('fs');

const FILE = 'd:/_Projects/scub111g/argus/e2e/media-preview.spec.ts';

const edits = [
  [
    `function fire(page: Page, data: object) {`,
    `/**
 * Hold every media request open without answering it.
 *
 * An injected grant names a token no server ever minted, so a real request 404s, the
 * element raises \`error\` and the component replaces it with the failure card - which
 * is correct behaviour that makes an "is there a <video>" assertion unwinnable. Hanging
 * the request keeps the element in its loading state: no error, no fallback, and the
 * element under test stays on the page. Deliberately never fulfilled; a 200 with fake
 * bytes would raise a *decode* error instead and land in the same place.
 */
async function hangMediaRequests(page: Page) {
  await page.route('**/media/**', () => { /* intentionally never answered */ });
}

function fire(page: Page, data: object) {`,
  ],
  [
    `  test('clicking a video asks for a grant, never for its contents', async ({ page }) => {
    await waitForApp(page);
    const watch = await watchRequests(page);`,
    `  test('clicking a video asks for a grant, never for its contents', async ({ page }) => {
    await waitForApp(page);
    await hangMediaRequests(page);
    const watch = await watchRequests(page);`,
  ],
  [
    `  test('an audio grant renders an audio element, not a video one', async ({ page }) => {
    await waitForApp(page);
    await emitPathMessage(page, AUDIO_PATH);`,
    `  test('an audio grant renders an audio element, not a video one', async ({ page }) => {
    await waitForApp(page);
    await hangMediaRequests(page);
    await emitPathMessage(page, AUDIO_PATH);`,
  ],
  // And pin the behaviour that the broken test accidentally discovered.
  [
    `test.describe('media preview', () => {`,
    `test.describe('media preview', () => {
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
`,
  ],
];

let src = fs.readFileSync(FILE, 'utf-8');
let failures = 0;
for (const [from, to] of edits) {
  if (src.split(from).length - 1 !== 1) {
    console.error(`FAIL: ${from.split('\n')[0].trim().slice(0, 60)}`);
    failures++;
    continue;
  }
  src = src.replace(from, to);
}
if (failures) process.exit(1);
fs.writeFileSync(FILE, src);
console.log(`applied ${edits.length} edits`);
