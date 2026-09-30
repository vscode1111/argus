const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const expected = 'rgb(117, 190, 255)';

(async () => {
  const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'] });
  try {
    for (const url of ['http://localhost:5173/?mock=1', 'http://localhost:3001/?mock=1']) {
      const page = await browser.newPage();
      await page.goto(url);
      await page.getByPlaceholder('Ask Argus').waitFor();
      await page.evaluate(() => {
        const call = { id: 'scub-command-color', name: 'Bash', kind: 'command', input: { command: 'echo scub-color' }, result: 'scub-result' };
        for (const data of [
          { type: 'thinking_start' },
          { type: 'tool_start', call: { ...call, result: undefined } },
          { type: 'tool_end', call },
          { type: 'done' },
        ]) window.dispatchEvent(new MessageEvent('message', { data }));
      });
      const command = page.getByText('echo scub-color', { exact: true });
      await command.waitFor();
      const color = await command.evaluate(element => getComputedStyle(element).color);
      console.log(JSON.stringify({ url, commandColor: color, expected }));
      assert.equal(color, expected);
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
