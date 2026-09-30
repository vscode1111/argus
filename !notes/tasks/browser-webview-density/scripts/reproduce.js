const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1555, height: 830 } });
    await page.goto('http://localhost:5173/?mock=1');
    await page.getByPlaceholder('Ask Argus').waitFor();
    await page.evaluate(() => {
      const call = {
        id: 'scub-density', name: 'fileChange', kind: 'fileChange',
        input: { changes: [
          { path: 'D:/scub/one.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-scub-old\n+scub-new\n' },
          { path: 'D:/scub/two.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-scub-before\n+scub-after\n' },
        ] }, result: 'completed',
      };
      for (const data of [
        { type: 'thinking_start' },
        { type: 'tool_start', call: { ...call, input: { changes: [] }, result: undefined } },
        { type: 'tool_end', call },
        { type: 'done' },
      ]) window.dispatchEvent(new MessageEvent('message', { data }));
    });
    const metrics = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const tool = document.querySelector('[class*="toolCall"]');
      const rows = [...document.querySelectorAll('[class*="fileChangeRow"]')];
      if (!tool || rows.length !== 2) throw new Error('scub fixture did not render');
      return {
        bodyFontSize: body.fontSize,
        bodyLineHeight: body.lineHeight,
        toolLineHeight: getComputedStyle(tool).lineHeight,
        monoFont: getComputedStyle(rows[0]).fontFamily,
        fileRowSpacing: rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top,
        devicePixelRatio: window.devicePixelRatio,
      };
    });
    console.log(JSON.stringify(metrics));
    const fontMetrics = await page.evaluate(() => {
      const root = document.documentElement;
      const rows = [...document.querySelectorAll('[class*="fileChangeRow"]')];
      return ['Cascadia Code', 'Consolas', 'Courier New'].map(font => {
        root.style.setProperty('--vscode-editor-font-family', `${font}, monospace`);
        return { font, spacing: rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top,
          effective: getComputedStyle(rows[0]).fontFamily };
      });
    });
    console.log(JSON.stringify(fontMetrics));
    assert.equal(metrics.bodyFontSize, '13px');
    assert.equal(metrics.bodyLineHeight, 'normal');
    assert.match(metrics.monoFont, /^Consolas/);
    assert.equal(metrics.fileRowSpacing, 18, 'file rows should match the reference webview spacing');

    const staticPage = await browser.newPage();
    await staticPage.goto('http://localhost:3001/');
    await staticPage.getByPlaceholder('Ask Argus').waitFor();
    const staticMonoFont = await staticPage.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-family').trim());
    console.log(JSON.stringify({ staticMonoFont }));
    assert.match(staticMonoFont, /^Consolas/);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
