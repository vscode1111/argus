import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { waitForApp } from './helpers';

// The web hosts (webview/index.html, media/browser.html) must render like the VS Code
// panel. The panel differs from a browser tab in exactly two ways: VS Code injects a
// default stylesheet (`@layer vscode-default`) and sets every --vscode-* theme token on
// the root element. The fixture carries both, taken from an installed VS Code
// (regenerate with !notes/tasks/browser-style-parity/scripts/make-panel-fixture.js).
//
// So the check is differential: render, record every element's computed style, apply
// what the panel adds, record again. Any property that changes is a place where the web
// and the extension disagree - an app style that relied on VS Code's defaults, or a
// token the web host does not define or defines with another value. Reported from a
// phone as a draft blockquote with no shading (scub-argus msg 211217).

const PANEL = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vscode-panel-style.json'), 'utf8')) as {
  defaultsCss: string; tokens: Record<string, string>; bodyClasses: string[];
};

const MARKDOWN = [
  '## Inventory report',
  '',
  'Stock moved **between warehouses** with `sku-114` and a [tracking link](https://example.com/track).',
  '',
  '> Draft (not sent): shipment ready for pickup.',
  '',
  '- first pallet',
  '- second pallet',
  '',
  '1. weigh',
  '2. label',
  '',
  '| Warehouse | Units |',
  '|---|---|',
  '| North | 40 |',
  '',
  '---',
  '',
  '```ts',
  "const status = 'ready';",
  '```',
].join('\n');

async function renderTranscript(page: Page) {
  await page.evaluate((md) => {
    const fire = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    fire({ type: 'message', message: { id: 'u1', role: 'user', content: 'Summarize the inventory' } });
    fire({ type: 'thinking_start' });
    fire({ type: 'thinking_chunk', text: 'Counting the pallets in each warehouse.' });
    fire({ type: 'tool_start', call: { id: 'b1', name: 'Bash', input: { command: 'ls stock', description: 'List stock files' } } });
    fire({ type: 'tool_end', call: { id: 'b1', name: 'Bash', input: { command: 'ls stock', description: 'List stock files' }, result: 'north.csv' } });
    fire({ type: 'tool_start', call: { id: 'r1', name: 'Read', input: { file_path: 'C:\\stock\\north.csv' } } });
    fire({ type: 'tool_end', call: { id: 'r1', name: 'Read', input: { file_path: 'C:\\stock\\north.csv' }, result: '1\tsku,units' } });
    fire({ type: 'tool_start', call: { id: 'e1', name: 'Edit', input: { file_path: 'C:\\stock\\north.csv', old_string: 'a', new_string: 'b' } } });
    fire({ type: 'tool_end', call: { id: 'e1', name: 'Edit', input: { file_path: 'C:\\stock\\north.csv', old_string: 'a', new_string: 'b' }, result: 'OK' } });
    fire({ type: 'text_chunk', text: md });
    fire({ type: 'done' });
    fire({ type: 'error', text: 'claude exited with code 1' });
  }, MARKDOWN);
  await expect(page.locator('blockquote').filter({ hasText: 'Draft (not sent)' })).toBeVisible({ timeout: 5_000 });
}

// Computed visual properties of every rendered element, keyed by DOM path. Layout
// properties are included on purpose: an inherited default such as body padding moves
// everything, and that is a difference the user sees.
function snapshot(page: Page): Promise<Record<string, Record<string, string>>> {
  return page.evaluate(() => {
    const PROPS = ['color', 'background-color', 'background-image', 'font-family', 'font-size', 'font-weight', 'line-height',
      'border-top-width', 'border-top-style', 'border-top-color', 'border-left-width', 'border-left-style', 'border-left-color',
      'border-right-width', 'border-bottom-width', 'border-bottom-color', 'border-radius', 'outline-style', 'outline-color',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'text-decoration-line', 'box-shadow', 'opacity', 'max-width', 'max-height', 'scrollbar-color', 'scrollbar-width'];
    const key = (el: Element) => {
      const parts: string[] = [];
      for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
        const p = n.parentElement; const same = p ? [...p.children].filter(c => c.tagName === n!.tagName) : [n];
        const cls = typeof n.className === 'string' && n.className ? '.' + n.className.split(/\s+/)[0].replace(/_[a-z0-9]{5}_\d+$/i, '') : '';
        parts.unshift(`${n.tagName.toLowerCase()}${cls}:${same.indexOf(n)}`);
      }
      return parts.join('>');
    };
    const out: Record<string, Record<string, string>> = {};
    for (const el of [document.documentElement, ...document.body.querySelectorAll('*')]) {
      if (['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName)) continue;
      const cs = getComputedStyle(el);
      out[key(el)] = Object.fromEntries(PROPS.map(p => [p, cs.getPropertyValue(p)]));
    }
    return out;
  });
}

function applyPanel(page: Page) {
  return page.evaluate((panel) => {
    const style = document.createElement('style');
    style.id = '_defaultStyles';
    style.textContent = panel.defaultsCss;
    document.head.prepend(style);
    for (const [k, v] of Object.entries(panel.tokens)) document.documentElement.style.setProperty(k, v);
    document.body.classList.add(...panel.bodyClasses);
  }, PANEL);
}

// The browser hosts prepend Apple's system font names so an iPhone gets its own UI font.
// Those two names do not exist on Windows, where both lists resolve to Segoe UI, so they
// are the one difference ignored - and only those two names, nothing else in the list.
const normalize = (prop: string, v: string) =>
  prop === 'font-family' ? v.replace(/^-apple-system, BlinkMacSystemFont, /, '') : v;

function diff(a: Record<string, Record<string, string>>, b: Record<string, Record<string, string>>) {
  const rows: string[] = [];
  for (const [k, props] of Object.entries(a)) {
    for (const [p, v] of Object.entries(props)) {
      if (b[k] && normalize(p, b[k][p]) !== normalize(p, v)) rows.push(`${k} { ${p}: web ${v} | panel ${b[k][p]} }`);
    }
  }
  return rows;
}

async function expectNoPanelDiff(page: Page, label: string) {
  const web = await snapshot(page);
  await applyPanel(page);
  const panel = await snapshot(page);
  const rows = diff(web, panel);
  await test.info().attach(`${label}-diff.txt`, { body: rows.join('\n') || 'none', contentType: 'text/plain' });
  expect(rows, `${label}: computed styles that differ between the web host and the VS Code panel`).toEqual([]);
}

test.describe('web host renders like the VS Code panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 1400 });
    await waitForApp(page);
  });

  test('transcript', async ({ page }) => {
    await renderTranscript(page);
    await expectNoPanelDiff(page, 'transcript');
  });

  // A render only reaches the states it shows; hover colours, badges and warnings are
  // tokens too. So every token the panel provides must be defined in both browser hosts
  // with the panel's value (font family excepted, see normalize).
  test('both browser hosts define every panel token with the panel value', () => {
    for (const host of ['webview/index.html', 'media/browser.html']) {
      const html = fs.readFileSync(path.resolve(__dirname, '..', host), 'utf8');
      const wrong: string[] = [];
      for (const [k, v] of Object.entries(PANEL.tokens)) {
        const m = new RegExp(`${k.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+);`).exec(html);
        const got = m?.[1].trim();
        if (normalize(k === '--vscode-font-family' ? 'font-family' : k, got ?? '') !== v) wrong.push(`${k}: ${got ?? 'MISSING'} (panel ${v})`);
      }
      expect(wrong, host).toEqual([]);
    }
  });

  test('settings dialog', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
    await expectNoPanelDiff(page, 'settings');
  });
});
