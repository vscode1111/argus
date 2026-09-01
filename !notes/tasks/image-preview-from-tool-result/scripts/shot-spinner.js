// Visual check of the preview spinner: emit an image Read, click it, and screenshot
// while the fetch is outstanding (mock mode never answers readToolImage), then again
// after the reply lands. Run against a live `yarn dev` on :5173.
const { chromium } = require('@playwright/test');
const path = require('path');

const OUT = path.resolve('!notes/tasks/image-preview-from-tool-result/scripts');
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.goto('http://localhost:5173/?mock=1', { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Ask Argus').waitFor({ timeout: 15000 });

  await page.evaluate(() => {
    const input = { file_path: 'D:/scub/out/скан-стр-2.png' };
    const fire = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
    fire({ type: 'thinking_start' });
    fire({ type: 'tool_start', call: { id: 'shot1', name: 'Read', input } });
    fire({ type: 'tool_end', call: { id: 'shot1', name: 'Read', input, result: '[image image/png 174 KB]' } });
    fire({ type: 'text_chunk', text: 'Обе страницы чистые.' });
    fire({ type: 'done' });
  });

  await page.locator('[class*="toolFileLink"]').first().click();
  await page.getByTestId('preview-loading').waitFor({ timeout: 5000 });
  await page.screenshot({ path: path.join(OUT, 'spinner.png') });
  console.log('spinner shot ->', path.join(OUT, 'spinner.png'));

  await page.evaluate((content) => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'toolImage', toolUseId: 'shot1', path: 'D:/scub/out/скан-стр-2.png', content },
    }));
  }, PNG_1PX);
  await page.locator('[role="dialog"] img').waitFor({ timeout: 5000 });
  console.log('spinner still visible after reply?', await page.getByTestId('preview-loading').isVisible());
  await page.screenshot({ path: path.join(OUT, 'after-reply.png') });

  await browser.close();
})();
