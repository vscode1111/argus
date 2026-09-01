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

// 1x1 transparent PNG, standing in for what the host reads out of the transcript.
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

  // A preview whose content comes from the host over the WS, rather than from data the
  // message already carried. The file-path-link test below still does that round trip
  // for real (readFilePreview is not suppressed in mock mode); an image now asks for
  // `readToolImage`, which is suppressed, so the reply is injected here and the real
  // round trip for it lives in tool-image-preview-integration.spec.ts.
  test('an image preview opened mid-turn survives the turn finishing', async ({ page }) => {
    const input = { file_path: 'media/argus-icon.png' };
    await fire(page,
      { type: 'thinking_start' },
      { type: 'tool_start', call: { id: 'im1', name: 'Read', input } },
      { type: 'tool_end', call: { id: 'im1', name: 'Read', input, result: '[image image/png 2 KB]' } },
    );
    await page.locator('[class*="toolSummary"]').first().click();
    const img = dialog(page).locator('img');
    // The modal registers its listener in an effect, so re-dispatch until it lands.
    await expect(async () => {
      await fire(page, { type: 'toolImage', toolUseId: 'im1', path: input.file_path, content: PNG_1PX });
      await expect(img).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });

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
