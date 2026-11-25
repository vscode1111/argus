import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { waitForApp } from './helpers';

// A blockquote in a reply (how drafts are shown) used to be shaded only in the VS Code
// panel: VS Code's injected webview stylesheet gives it --vscode-textBlockQuote-background,
// while the browser hosts had neither that rule nor the token, so the draft rendered as
// plain text indistinguishable from the prose around it (reported from a phone,
// scub-argus msg 211217). The app now owns the rule and both browser hosts define the
// token. Computed colours, not declarations: an undefined token computes to transparent.

const MARKDOWN = ['Draft (not sent):', '', '> Shipment report for the warehouse team.', '', 'Should I send it?'].join('\n');

function emitReply(page: Page) {
  return page.evaluate((md) => {
    const fire = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    fire({ type: 'thinking_start' });
    fire({ type: 'text_chunk', text: md });
    fire({ type: 'done' });
  }, MARKDOWN);
}

test('a blockquote in a reply is shaded with the theme quote colour', async ({ page }) => {
  await waitForApp(page);
  await emitReply(page);
  const quote = page.locator('blockquote').filter({ hasText: 'Shipment report' });
  await expect(quote).toBeVisible({ timeout: 5_000 });
  await expect(quote).toHaveCSS('background-color', 'rgb(36, 37, 38)');
  // Control: the shading must differ from the paragraph beside it, or it is invisible.
  const paragraph = page.locator('p').filter({ hasText: 'Should I send it?' });
  const surface = await paragraph.evaluate(el => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
    }
    return 'none';
  });
  expect(surface).not.toBe('rgb(36, 37, 38)');
});

test('both browser hosts define the blockquote tokens identically', () => {
  const token = (file: string) => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    return ['background', 'border'].map(k => new RegExp(`--vscode-textBlockQuote-${k}:\\s*([^;]+);`).exec(html)?.[1]);
  };
  const dev = token('webview/index.html');
  expect(dev).toEqual(['#242526', '#2A2B2CFF']);
  expect(token('media/browser.html')).toEqual(dev);
});
