// What does the rendered message actually contain for the reported path? Prints the
// link text and title against the plain text around it, so "the link is truncated" is
// an observation rather than a regex inference. Needs a live `yarn dev` on :5173.
const { chromium } = require('@playwright/test');

// Built by concatenation on purpose: a String.raw template would escape the backticks
// that make the code span, which silently turned the first case into prose and sent the
// first run of this probe down the wrong path.
const P = 'C:\\Users\\Admin\\.claude\\companies\\CCS\\credentials\\.corp-account';
const OK = 'd:\\_Projects\\CCS\\!notes\\common\\vault-service-env-paths.md';
const LINE = 'In code span: `' + P + '` (this is the reported case)';
const PROSE = 'In prose: ' + P + ' and a normal one ' + OK;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.goto('http://localhost:5173/?mock=1', { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Ask Argus').waitFor({ timeout: 15000 });

  await page.evaluate(({ line, prose }) => {
    const fire = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
    fire({ type: 'thinking_start' });
    fire({ type: 'text_chunk', text: line + '\n\n' + prose });
    fire({ type: 'done' });
  }, { line: LINE, prose: PROSE });

  await page.locator('.file-path-link').first().waitFor({ timeout: 5000 });

  const links = await page.locator('.file-path-link').evaluateAll((els) =>
    els.map((e) => ({ text: e.textContent, title: e.getAttribute('title') })));
  console.log('links:');
  for (const l of links) console.log('  text :', JSON.stringify(l.text), '\n  title:', JSON.stringify(l.title));

  // What the user sees around the link, to catch text the link left behind.
  const rendered = await page.locator('[class*="message"]').last().innerText();
  console.log('\nrendered text:\n' + rendered);

  await browser.close();
})();
