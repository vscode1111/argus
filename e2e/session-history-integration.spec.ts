import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Sends a prompt and waits for the turn to complete (Stop button appears, then
// disappears when streaming ends).
async function sendAndWait(page: Page, text: string) {
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  const stopBtn = page.getByRole('button', { name: 'Stop' });
  await expect(stopBtn).toBeVisible({ timeout: 15_000 });
  await expect(stopBtn).toHaveCount(0, { timeout: 90_000 });
}

test.describe('session history (integration)', () => {
  test('creates a session, lists it, resumes it, and continues context', async ({ page }) => {
    test.setTimeout(240_000);
    await waitForApp(page);

    // 1. Establish a fact in a fresh session. The unique token lets us prove later
    //    that the resumed session still carries the earlier context.
    await sendAndWait(page, 'Remember this token for later: scub-7731. Reply with just "OK".');

    // 2. Open the history modal; the dev server (cwd = repo root) lists the real
    //    transcripts for this project, including the session we just created.
    await page.getByRole('button', { name: 'Session history' }).click();
    const dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog).toBeVisible();
    await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });

    // At least one session exists, and the live one is highlighted (green row).
    await expect(dialog.getByRole('button', { name: 'Delete session' }).first()).toBeVisible({ timeout: 10_000 });
    await expect(dialog.locator('[class*="rowCurrent"]')).toBeVisible({ timeout: 10_000 });

    // 3. Resume the current session: the modal closes and the stored conversation
    //    is replayed back into the message list.
    await dialog.locator('[class*="rowCurrent"]').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('scub-7731')).toBeVisible({ timeout: 10_000 });

    // 4. Continue the conversation. Because resume spawns the CLI with
    //    `--resume <sessionId>`, the model must still know the earlier token.
    await sendAndWait(page, 'What token did I ask you to remember? Reply with just the token.');

    // The latest assistant message recalls the token from the resumed context.
    await expect(page.getByText('scub-7731').last()).toBeVisible({ timeout: 10_000 });
    const messages = page.locator('[class*="assistant"]');
    await expect(messages.last()).toContainText('scub-7731', { timeout: 10_000 });
  });

  test('renames a session and the new title survives a backend re-list', async ({ page }) => {
    test.setTimeout(180_000);
    await waitForApp(page);

    // 1. Create a real session so a transcript exists to rename.
    await sendAndWait(page, 'Reply with just "OK".');

    // 2. Open the history modal and rename the current (live) session.
    await page.getByRole('button', { name: 'Session history' }).click();
    const dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog).toBeVisible();
    await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });

    const newTitle = `scub-renamed-${Date.now()}`;
    const currentRow = dialog.locator('[class*="rowCurrent"]');
    await expect(currentRow).toBeVisible({ timeout: 10_000 });
    await currentRow.getByRole('button', { name: 'Rename session' }).click();

    const input = dialog.getByRole('textbox', { name: 'Rename session' });
    await expect(input).toBeVisible();
    await input.fill(newTitle);
    await input.press('Enter');

    // Optimistic update: the renamed title shows immediately.
    await expect(dialog.getByText(newTitle)).toBeVisible({ timeout: 10_000 });

    // 3. Close and reopen the modal so the list is rebuilt from disk. The server
    //    appended a fresh `ai-title` line, so listSessions() must read it back -
    //    proving the rename persisted, not just the in-memory optimistic update.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: 'Session history' }).click();
    const dialog2 = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog2).toBeVisible();
    await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });
    await expect(dialog2.getByText(newTitle)).toBeVisible({ timeout: 10_000 });
  });
});
