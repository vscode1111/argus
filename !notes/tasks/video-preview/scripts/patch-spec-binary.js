// Removes an injection race from the binary-card test.
//
// The test injected a `filePreview` reply for a made-up path. But `readFilePreview` is
// NOT in MOCK_SUPPRESSED (deliberately - tool-image-preview.spec.ts proves a request
// never reaches the socket, which requires it to be able to), so the live dev backend
// answered the same request with `Error reading file: ENOENT` and the two replies raced.
// The injected one happened to win at first and lost once timings shifted, which is the
// worst kind of test: green until it is load-bearing.
//
// No other spec injects a filePreview, and that is the tell - they all use real paths
// against the real backend. So does this now: real fixture files, whose real replies are
// exactly the two cases under test. Nothing to race with, and it covers the server's
// binary sniff and the card together.
const fs = require('fs');

const FILE = 'd:/_Projects/scub111g/argus/e2e/media-preview.spec.ts';

const OLD_TEST = `  test('a binary file is described, and a text file still renders', async ({ page }) => {
    await waitForApp(page);
    await emitPathMessage(page, 'd:\\\\scub\\\\blob\\\\scub-blob.bin');
    await page.locator('.file-path-link').first().click();

    await fire(page, {
      type: 'filePreview',
      path: 'd:\\\\scub\\\\blob\\\\scub-blob.bin',
      content: '',
      binary: { size: 9000 },
    });

    const card = page.locator('[data-testid="preview-info"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Binary file');
    await expect(card).toContainText('8.8 KB');
    await expect(page.locator('[data-line]')).toHaveCount(0);

    // The control, in the same run: an ordinary text reply must still render as text,
    // or a build that showed the card for everything would pass the assertions above.
    await viewer(page).locator('[aria-label="Close"]').click();
    await emitPathMessage(page, 'd:\\\\scub\\\\blob\\\\scub-plain.txt');
    await page.locator('.file-path-link').last().click();
    await fire(page, {
      type: 'filePreview',
      path: 'd:\\\\scub\\\\blob\\\\scub-plain.txt',
      content: 'scub plain text fixture\\nsecond line\\n',
    });
    await expect(page.locator('[data-testid="preview-info"]')).toHaveCount(0);
    await expect(page.locator('[data-line]').first()).toBeVisible();
  });`;

const NEW_TEST = `  test('a binary file is described, and a text file still renders', async ({ page }) => {
    await waitForApp(page);

    // Real files and the real backend, no injected reply: \`readFilePreview\` is not
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
  });`;

const FIXTURE_SETUP = `const VIDEO_PATH = 'd:\\\\scub\\\\clips\\\\scub-clip.mp4';
const AUDIO_PATH = 'd:\\\\scub\\\\clips\\\\scub-tone.wav';`;

const FIXTURE_SETUP_NEW = `const VIDEO_PATH = 'd:\\\\scub\\\\clips\\\\scub-clip.mp4';
const AUDIO_PATH = 'd:\\\\scub\\\\clips\\\\scub-tone.wav';

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
  fs.writeFileSync(txtFixture, 'scub plain text fixture\\nsecond line\\n', 'utf-8');
});

test.afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});`;

const edits = [
  [
    `import { test, expect, type Page } from '@playwright/test';
import * as path from 'path';`,
    `import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';`,
  ],
  [FIXTURE_SETUP, FIXTURE_SETUP_NEW],
  [OLD_TEST, NEW_TEST],
];

let src = fs.readFileSync(FILE, 'utf-8');
let failures = 0;
for (const [from, to] of edits) {
  const n = src.split(from).length - 1;
  if (n !== 1) {
    console.error(`FAIL (${n} matches): ${from.split('\n')[0].trim().slice(0, 60)}`);
    failures++;
    continue;
  }
  src = src.replace(from, to);
}
if (failures) process.exit(1);
fs.writeFileSync(FILE, src);
console.log(`applied ${edits.length} edits`);
