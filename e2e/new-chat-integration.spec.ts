import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Sends a prompt and waits for the turn to complete (Stop appears, then clears).
async function sendAndWait(page: Page, text: string) {
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  const stopBtn = page.getByRole('button', { name: 'Stop' });
  await expect(stopBtn).toBeVisible({ timeout: 15_000 });
  await expect(stopBtn).toHaveCount(0, { timeout: 90_000 });
}

test.describe('new chat (integration)', () => {
  test('New chat resets the session so earlier context is gone', async ({ page }) => {
    await waitForApp(page);

    // 1. Establish a unique token in the current session.
    await sendAndWait(page, 'Remember this token for later: scub-9920. Reply with just "OK".');
    await expect(page.getByText('scub-9920').first()).toBeVisible();

    // 2. New chat: the server kills the proc, drops the sessionId, and echoes
    //    `clear`, so the conversation is wiped from the UI.
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(page.getByText('scub-9920')).toHaveCount(0, { timeout: 10_000 });

    // 3. Ask about the token. The next send spawns a brand-new CLI session
    //    (no `--resume`), so the model cannot know the earlier token - it must
    //    not echo it back.
    await sendAndWait(page, 'What token did I ask you to remember earlier? If you have no record of it, reply "NO MEMORY".');

    const lastAssistant = page.locator('[class*="assistant"]').last();
    await expect(lastAssistant).not.toContainText('scub-9920', { timeout: 10_000 });
  });
});
