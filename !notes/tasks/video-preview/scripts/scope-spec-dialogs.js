// Scopes the mock spec's dialog locators to the file viewer.
//
// `[role="dialog"]` is not unique on this page: the Dev Harness is also one, and it is
// persisted in localStorage, so on any profile where it has been switched on it sorts
// FIRST in the DOM and a bare locator silently reads it instead. That is how a markdown
// regression check reported "does not render" against a perfectly good preview during
// this task. A fresh Playwright context has no localStorage so the harness is hidden and
// the specs would pass today - which is exactly what makes it worth pinning now rather
// than discovering it as a flake later.
const fs = require('fs');

const FILE = 'd:/_Projects/scub111g/argus/e2e/media-preview.spec.ts';

const edits = [
  [
    `function fire(page: Page, data: object) {`,
    `/**
 * The file viewer specifically. \`[role="dialog"]\` also matches the Dev Harness, which
 * is persisted in localStorage and sorts first in the DOM when it has ever been opened.
 */
const viewer = (page: Page) => page.locator('[role="dialog"][aria-label^="File viewer"]');

function fire(page: Page, data: object) {`,
  ],
  [
    `    await expect(page.locator('[data-line]')).toHaveCount(0);
    await expect(page.locator('[role="dialog"] select')).toHaveCount(0);`,
    `    await expect(page.locator('[data-line]')).toHaveCount(0);
    await expect(viewer(page).locator('select')).toHaveCount(0);`,
  ],
  [
    `    await expect(page.locator('[data-testid="preview-loading"]')).toHaveCount(0);
    await expect(page.locator('[role="dialog"]')).toContainText('Cannot play this file');
    await expect(page.locator('[role="dialog"]')).toContainText('ENOENT');`,
    `    await expect(page.locator('[data-testid="preview-loading"]')).toHaveCount(0);
    await expect(viewer(page)).toContainText('Cannot play this file');
    await expect(viewer(page)).toContainText('ENOENT');`,
  ],
  [
    `    await page.locator('[role="dialog"] [aria-label="Close"]').click();`,
    `    await viewer(page).locator('[aria-label="Close"]').click();`,
  ],
];

let src = fs.readFileSync(FILE, 'utf-8');
let failures = 0;
for (const [from, to] of edits) {
  if (src.split(from).length - 1 !== 1) {
    console.error(`FAIL: ${from.split('\n')[0].slice(0, 60)}`);
    failures++;
    continue;
  }
  src = src.replace(from, to);
}
if (failures) process.exit(1);
fs.writeFileSync(FILE, src);
console.log(`scoped ${edits.length} locators to the file viewer`);
