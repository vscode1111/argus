import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

// Folders starting with "!" (the !notes convention) are part of the path, but
// the linkifier used to stop at the bang and link only the tail, so clicking
// opened a path relative to the wrong root.
const WIN_PATH = 'd:\\_Projects\\CCS\\!notes\\common\\devops-duty-incidents.md';
const REL_PATH = 'image-configs\\!notes\\tasks\\B2BADM-6735\\notes.md';
const UNIX_PATH = '/home/user/!notes/common/INDEX.md';

test.describe('file paths containing a ! folder', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('links the whole windows path, not just the part after the bang', async ({ page }) => {
    await send(page, {
      type: 'message',
      message: { id: '1', role: 'assistant', content: `Saved to ${WIN_PATH} just now.` },
    });

    const link = page.getByRole('link', { name: /devops-duty-incidents\.md/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveText(WIN_PATH);
  });

  test('links a relative path through a bang folder', async ({ page }) => {
    await send(page, {
      type: 'message',
      message: { id: '2', role: 'assistant', content: `Updated ${REL_PATH} too.` },
    });

    const link = page.getByRole('link', { name: /B2BADM-6735/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveText(REL_PATH);
  });

  test('links a unix path through a bang folder', async ({ page }) => {
    await send(page, {
      type: 'message',
      message: { id: '3', role: 'assistant', content: `See ${UNIX_PATH} for details.` },
    });

    const link = page.getByRole('link', { name: /INDEX\.md/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveText(UNIX_PATH);
  });

  // Markdown keeps backslashes literal inside code spans, so the escaping that
  // protects them in prose must not run there - it doubled them and killed the link.
  test('links a bang path inside inline code without doubling backslashes', async ({ page }) => {
    await send(page, {
      type: 'message',
      message: { id: '4', role: 'assistant', content: `Rows in \`${WIN_PATH}\` and \`${REL_PATH}\` match.` },
    });

    const abs = page.getByRole('link', { name: /devops-duty-incidents\.md/ });
    await expect(abs).toBeVisible();
    await expect(abs).toHaveText(WIN_PATH);

    const rel = page.getByRole('link', { name: /B2BADM-6735/ });
    await expect(rel).toBeVisible();
    await expect(rel).toHaveText(REL_PATH);
  });
});
