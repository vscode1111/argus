import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// A file/diff/image preview must survive whatever the running turn does behind it:
// the user opened it deliberately, and only the user closes it. Regression for
// modals vanishing mid-session (a tool block committing from the streaming message
// into a completed one unmounts the component that owned the open state).

function fire(page: Page, ...msgs: object[]) {
  return page.evaluate((list) => {
    for (const data of list) window.dispatchEvent(new MessageEvent('message', { data }));
  }, msgs);
}

const INPUT = {
  file_path: 'D:/_Projects/scub/app.ts',
  old_string: 'const x = 1;\nconst y = 2;',
  new_string: 'const x = 100;\nconst y = 200;',
};

const dialog = (page: Page) => page.locator('[role="dialog"]');

test.describe('preview modals survive an active session', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('diff opened mid-turn survives further streaming events', async ({ page }) => {
    await fire(page,
      { type: 'thinking_start' },
      { type: 'tool_start', call: { id: 'ed1', name: 'Edit', input: INPUT } },
      { type: 'tool_end', call: { id: 'ed1', name: 'Edit', input: INPUT, result: 'OK' } },
    );
    await page.locator('[class*="toolOutLink"]', { hasText: 'Diff' }).click();
    await expect(dialog(page)).toBeVisible();

    await fire(page, { type: 'text_chunk', text: 'Still working...' });
    await expect(dialog(page)).toBeVisible();

    await fire(page, { type: 'tool_start', call: { id: 'b1', name: 'Bash', input: { command: 'ls' } } });
    await expect(dialog(page)).toBeVisible();
  });

  test('diff opened mid-turn survives the turn finishing', async ({ page }) => {
    await fire(page,
      { type: 'thinking_start' },
      { type: 'tool_start', call: { id: 'ed2', name: 'Edit', input: INPUT } },
      { type: 'tool_end', call: { id: 'ed2', name: 'Edit', input: INPUT, result: 'OK' } },
    );
    await page.locator('[class*="toolOutLink"]', { hasText: 'Diff' }).click();
    await expect(dialog(page)).toBeVisible();

    await fire(page, { type: 'text_chunk', text: 'Done.' }, { type: 'done' });
    await expect(dialog(page)).toBeVisible();
  });

  test('diff from a finished turn survives the next turn starting', async ({ page }) => {
    await fire(page,
      { type: 'thinking_start' },
      { type: 'tool_start', call: { id: 'ed3', name: 'Edit', input: INPUT } },
      { type: 'tool_end', call: { id: 'ed3', name: 'Edit', input: INPUT, result: 'OK' } },
      { type: 'text_chunk', text: 'Done.' },
      { type: 'done' },
    );
    await page.locator('[class*="toolOutLink"]', { hasText: 'Diff' }).click();
    await expect(dialog(page)).toBeVisible();

    await fire(page, { type: 'thinking_start' }, { type: 'text_chunk', text: 'Next turn' });
    await expect(dialog(page)).toBeVisible();

    await fire(page, { type: 'done' });
    await expect(dialog(page)).toBeVisible();
  });

  // The two previews whose content comes from the backend over the WS (so these
  // also prove the hoisted host still does the readFilePreview round trip).
  test('an image preview opened mid-turn survives the turn finishing', async ({ page }) => {
    const input = { file_path: 'media/argus-icon.ico' };
    await fire(page,
      { type: 'thinking_start' },
      { type: 'tool_start', call: { id: 'im1', name: 'Read', input } },
      { type: 'tool_end', call: { id: 'im1', name: 'Read', input, result: '[image]' } },
    );
    await page.locator('[class*="toolSummary"]').first().click();
    const img = dialog(page).locator('img');
    await expect(img).toBeVisible({ timeout: 10_000 });

    await fire(page, { type: 'text_chunk', text: 'Done.' }, { type: 'done' });
    await expect(img).toBeVisible();
  });

  test('a file path link in streaming text survives the turn finishing', async ({ page }) => {
    await fire(page,
      { type: 'thinking_start' },
      { type: 'text_chunk', text: 'Look at webview/src/App.tsx for the layout.' },
    );
    const link = page.getByRole('link', { name: /App\.tsx/ }).first();
    await expect(async () => {
      if ((await dialog(page).count()) === 0) await link.click();
      await expect(dialog(page)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.locator('[data-line="1"]')).toContainText('import');

    await fire(page, { type: 'done' });
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('[data-line="1"]')).toContainText('import');
  });

  test('file output opened mid-turn survives the turn finishing', async ({ page }) => {
    const input = { file_path: 'D:/_Projects/scub/readme.md' };
    await fire(page,
      { type: 'thinking_start' },
      { type: 'tool_start', call: { id: 'rd1', name: 'Read', input } },
      { type: 'tool_end', call: { id: 'rd1', name: 'Read', input, result: 'line one\nline two\nline three' } },
    );
    await page.locator('[class*="toolSummary"]').first().click();
    await expect(dialog(page)).toBeVisible();

    await fire(page, { type: 'text_chunk', text: 'Done.' }, { type: 'done' });
    await expect(dialog(page)).toBeVisible();
  });
});
