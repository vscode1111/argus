import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

/**
 * "@" is a filename character, and refusing it did not produce "no link" - it produced a
 * link to something else.
 *
 * Reported: `D:\_Projects\_tools\telegram\out\@snowy_137.json` (a per-handle dump) linked
 * only `D:\_Projects\_tools\telegram\out\`, which is a real folder, so the click opened a
 * directory listing instead of the file. The same split hit every `node_modules\@scope\…`
 * path (a folder link plus an orphan `@scope/...` fragment that resolves nowhere) and
 * every `…\garland@2x.png` retina asset, which truncated to a name that does not exist.
 *
 * The mid-segment cases are why "@" is allowed anywhere on the Windows branch rather than
 * only at the start of a segment; on the slash branches it is start-only, because that is
 * where a scoped name puts it while an address puts it in the middle.
 */

const AT_FILE = 'D:\\_Projects\\_tools\\telegram\\out\\@snowy_137.json';
const AT_MIDDLE = 'd:\\_Projects\\CCS\\apps\\client\\src\\assets\\img\\newYear\\garland@2x.png';
const SCOPED = 'd:/_Projects/CCS/b2b-admin/apps/server/node_modules/@v3group/apostille/dist/index.d.ts';
const PLAIN = 'd:\\_Projects\\CCS\\!notes\\common\\vault-service-env-paths.md';

function emitText(page: Page, text: string) {
  return page.evaluate((t) => {
    const fire = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    fire({ type: 'thinking_start' });
    fire({ type: 'text_chunk', text: t });
    fire({ type: 'done' });
  }, text);
}

const links = (page: Page) => page.locator('.file-path-link');

test.describe('paths containing @', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('links the whole @-file in a code span, not the folder above it', async ({ page }) => {
    await emitText(page, 'The key is sitting in plaintext at `' + AT_FILE + '` now.');

    const link = links(page).first();
    await expect(link).toBeVisible({ timeout: 5_000 });
    // The defect was a link whose text was a strict prefix of the visible path - and an
    // existing directory, so nothing about the click looked broken.
    await expect(link).toHaveText(AT_FILE);
    await expect(link).toHaveAttribute('title', `Open ${AT_FILE}`);
  });

  test('keeps its backslashes in prose, where markdown would eat them', async ({ page }) => {
    await emitText(page, `The key is sitting in plaintext at ${AT_FILE} now.`);

    const link = links(page).first();
    await expect(link).toBeVisible({ timeout: 5_000 });
    await expect(link).toHaveText(AT_FILE);
  });

  test('an @ inside a segment links whole (retina asset)', async ({ page }) => {
    // Deliberately a code span. In prose remark-gfm claims `garland@2x.png` as an email
    // autolink before the linkifier ever runs, so it still renders as a folder link plus
    // a `mailto:` one - a separate, pre-existing defect of the parser, not of the regex
    // (see !notes/tasks/at-in-filename-truncates-link/notes.md). Asserting the prose form
    // here would lock in that defect as expected behaviour.
    await emitText(page, 'Asset: `' + AT_MIDDLE + '` is the one.');

    await expect(links(page)).toHaveCount(1);
    await expect(links(page).first()).toHaveText(AT_MIDDLE);
  });

  test('a scoped package path is one link, not a folder plus a fragment', async ({ page }) => {
    await emitText(page, `Types come from ${SCOPED} here.`);

    // Exactly one: the old pair was `…/node_modules/` plus `@v3group/apostille/dist/index.d.ts`,
    // neither of which opens the file the text names.
    await expect(links(page)).toHaveCount(1);
    await expect(links(page).first()).toHaveText(SCOPED);
  });

  test('a handle and an email are not paths, while a real path in the same line still links', async ({ page }) => {
    // The control. Without it, admitting "@" everywhere on every branch would pass the
    // tests above; this corpus (a Telegram archive plus work chat) is full of both.
    await emitText(page, `@snowy_137 wrote to john@corp.com about ${PLAIN} yesterday.`);

    await expect(links(page)).toHaveCount(1);
    await expect(links(page).first()).toHaveText(PLAIN);
  });
});
