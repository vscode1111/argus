import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

/**
 * A hyphenated dotfile is a path like any other.
 *
 * `C:\Users\Admin\.claude\companies\CCS\credentials\.corp-account` broke both regexes,
 * whose filename suffix was `\.\w+` and `\w` excludes `-`:
 *   - in a code span it linked `...\credentials\.corp` - a *different* path, which does
 *     not exist, so the click opened `Error reading file: ENOENT`;
 *   - in prose it matched WIN_PATH_RE not at all, so markdown ate the backslashes and it
 *     rendered as `C:\Users\Admin.claude\...\credentials.corp-account`.
 *
 * The naming convention that produced it is routine (`.corp-account`, `.menu-cms`), so
 * both halves are asserted here.
 */

const DOTFILE = 'C:\\Users\\Admin\\.claude\\companies\\CCS\\credentials\\.corp-account';
const NORMAL = 'd:\\_Projects\\CCS\\!notes\\common\\vault-service-env-paths.md';

function emitText(page: Page, text: string) {
  return page.evaluate((t) => {
    const fire = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    fire({ type: 'thinking_start' });
    fire({ type: 'text_chunk', text: t });
    fire({ type: 'done' });
  }, text);
}

const links = (page: Page) => page.locator('.file-path-link');

test.describe('hyphenated dotfile paths', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('links the whole name in a code span, not up to the hyphen', async ({ page }) => {
    await emitText(page, 'Sealed file: `' + DOTFILE + '` holds the login.');

    const link = links(page).first();
    await expect(link).toBeVisible({ timeout: 5_000 });
    // The defect was a link whose text was a strict prefix of the visible path, so the
    // assertion is on the whole string rather than on "contains .corp-account".
    await expect(link).toHaveText(DOTFILE);
    await expect(link).toHaveAttribute('title', `Open ${DOTFILE}`);
  });

  test('keeps its backslashes in prose, where markdown would eat them', async ({ page }) => {
    await emitText(page, `Sealed file: ${DOTFILE} holds the login.`);

    const link = links(page).first();
    await expect(link).toBeVisible({ timeout: 5_000 });
    await expect(link).toHaveText(DOTFILE);
  });

  test('a normal extension still links whole and stops at the space', async ({ page }) => {
    // The control: a widened suffix that swallowed the following word, or one that
    // stopped early again, both fail here.
    await emitText(page, `See ${NORMAL} and ${DOTFILE} today.`);

    await expect(links(page)).toHaveCount(2);
    await expect(links(page).nth(0)).toHaveText(NORMAL);
    await expect(links(page).nth(1)).toHaveText(DOTFILE);
  });
});
