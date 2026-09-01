// Open the real .html file from the report through the real backend (a path link, so
// readFilePreview does the reading) and screenshot both views. Needs `yarn dev` on :5173.
const { chromium } = require('@playwright/test');
const path = require('path');

const FILE = 'd:\\_Projects\\scub111g\\people-research\\people\\tanya-gta\\разделы-для-психолога\\01-первая-встреча-темы-и-поведение.html';
const OUT = path.resolve('!notes/tasks/html-preview/scripts');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto('http://localhost:5173/?mock=1', { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Ask Argus').waitFor({ timeout: 15000 });

  // Through the tool row, as in the report. (A path link would not do: the folder name
  // is Cyrillic and FILE_PATH_RE is ASCII-only, so it never linkifies in prose.)
  const content = require('fs').readFileSync(FILE, 'utf8');
  await page.evaluate(({ file, content }) => {
    const input = { file_path: file };
    const fire = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
    fire({ type: 'thinking_start' });
    fire({ type: 'tool_start', call: { id: 'h1', name: 'Read', input } });
    fire({ type: 'tool_end', call: { id: 'h1', name: 'Read', input, result: content } });
    fire({ type: 'done' });
  }, { file: FILE, content });

  await page.locator('[class*="toolFileLink"]').first().click();
  const frame = page.getByTestId('html-preview');
  await frame.waitFor({ timeout: 15000 });
  // Wait for the sandboxed document to have painted something.
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'preview.png') });
  console.log('sandbox attr:', await frame.getAttribute('sandbox'));
  console.log('first heading inside:', await page.frameLocator('[data-testid="html-preview"]').locator('h1').first().textContent());

  // The modal overlay is aria-hidden, so role locators cannot see inside it.
  await page.locator('[role="dialog"] button', { hasText: 'Source' }).click();
  await page.locator('[data-line="1"]').waitFor({ timeout: 5000 });
  await page.screenshot({ path: path.join(OUT, 'source.png') });
  console.log('source view line 1:', (await page.locator('[data-line="1"]').textContent()).trim().slice(0, 60));

  await browser.close();
})();
