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

    // The token must be generated per run: a hard-coded one can end up in the CLI's
    // persistent per-project memory (~/.claude/projects/<cwd>/memory), which is
    // auto-loaded into every new session - a correctly reset session would then still
    // "know" it and fail this test for the wrong reason.
    const token = `scub-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    // 1. Establish the token in the current session. Deliberately avoid the word
    //    "remember": that reads as an instruction to persist, and the agent obeys it
    //    by writing the token to the project memory file - which both pollutes the
    //    user's real memory and makes step 3 legitimately able to recall it. Keeping
    //    the token conversational leaves it in session context only, which is exactly
    //    what "New chat" is supposed to discard.
    await sendAndWait(page, `My build tag for this conversation is ${token}. Reply with just "OK" - do not save this anywhere.`);
    await expect(page.getByText(token).first()).toBeVisible();

    // 2. New chat: the server kills the proc, drops the sessionId, and echoes
    //    `clear`, so the conversation is wiped from the UI.
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(page.getByText(token)).toHaveCount(0, { timeout: 10_000 });

    // 3. Ask about the token. The next send spawns a brand-new CLI session
    //    (no `--resume`), so the model cannot know the earlier token - it must
    //    not echo it back. Tools are off-limits so it cannot go looking for it.
    await sendAndWait(page, 'What build tag did I mention earlier in this conversation? Answer from conversation context only - do not read any files. If you have no record of it, reply "NO MEMORY".');

    const lastAssistant = page.locator('[class*="assistant"]').last();
    await expect(lastAssistant).not.toContainText(token, { timeout: 10_000 });
  });
});
