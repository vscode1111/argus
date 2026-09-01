// The reported case exactly: a Read of the real .html with offset 359 / limit 140, the
// same shape as `...01-первая-встреча-темы-и-поведение.html:359-499` in the screenshot.
// Before the follow-up fix this opened as source, which is why the feature looked absent.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const FILE = 'd:\\_Projects\\scub111g\\people-research\\people\\tanya-gta\\разделы-для-психолога\\01-первая-встреча-темы-и-поведение.html';
const OUT = path.resolve('!notes/tasks/html-preview/scripts');
const OFFSET = 359;
const LIMIT = 140;

(async () => {
  const all = fs.readFileSync(FILE, 'utf8').split('\n');
  // What the Read tool hands back: the slice, each line prefixed with its number.
  const slice = all.slice(OFFSET - 1, OFFSET - 1 + LIMIT)
    .map((l, i) => `${String(OFFSET + i).padStart(6)}\t${l}`).join('\n');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto('http://localhost:5173/?mock=1', { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Ask Argus').waitFor({ timeout: 15000 });

  await page.evaluate(({ file, slice, offset, limit }) => {
    const input = { file_path: file, offset, limit };
    const fire = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
    fire({ type: 'thinking_start' });
    fire({ type: 'tool_start', call: { id: 'o1', name: 'Read', input } });
    fire({ type: 'tool_end', call: { id: 'o1', name: 'Read', input, result: slice } });
    fire({ type: 'done' });
  }, { file: FILE, slice, offset: OFFSET, limit: LIMIT });

  console.log('tool row:', (await page.locator('[class*="toolSummary"]').first().textContent()).slice(-30));
  await page.locator('[class*="toolFileLink"]').first().click();

  const frame = page.getByTestId('html-preview');
  await frame.waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'offset-preview.png') });
  const text = await page.frameLocator('[data-testid="html-preview"]').locator('body').innerText();
  console.log('rendered, first line inside frame:', text.split('\n').find(Boolean));

  await page.locator('[role="dialog"] button', { hasText: 'Source' }).click();
  await page.locator('[data-line="1"]').waitFor({ timeout: 5000 });
  // Does the source view number the slice by its real file lines, or from 1? The scroll
  // target passed by ToolCall is the absolute offset, so this decides whether the
  // existing scroll-to-line does anything at all for an offset read.
  const nums = await page.locator('[data-line]').evaluateAll(els => els.map(e => e.getAttribute('data-line')));
  console.log('source data-line range:', nums[0], '..', nums[nums.length - 1],
    '| target', OFFSET, nums.includes(String(OFFSET)) ? 'present' : 'ABSENT (no scroll, no highlight)');

  await browser.close();
})();
