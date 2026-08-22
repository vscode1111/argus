import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// The running-session marker end to end against the real backend: `listActiveSessions`
// in channel.ts reports every entry that holds a live CLI process mid-turn, and
// `notifyActiveSessions` pushes that set to every client of every workspace channel.
// These are integration tests because the set is derived from real spawned processes,
// and because the point of the feature is that a turn started in one panel is visible
// in another one's history list.

// A prompt long enough that the turn is still running while the modal opens.
const LONG_PROMPT = 'List the numbers from 1 to 300, each on its own line. No other text.';

async function startTurn(page: Page, prompt: string) {
  await page.getByPlaceholder('Ask Argus').fill(prompt);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 15_000 });
}

// The browser shim keeps ?session=<id> in step with the live session, so the id the
// CLI assigned is readable from the address bar once its first event lands.
async function currentSessionId(page: Page): Promise<string> {
  let id: string | null = null;
  await expect.poll(
    () => { id = new URL(page.url()).searchParams.get('session'); return id; },
    { timeout: 20_000 },
  ).not.toBeNull();
  return id!;
}

async function openHistory(page: Page) {
  await page.getByRole('button', { name: 'Session history' }).click();
  const dialog = page.getByRole('dialog', { name: 'Session History' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('running-session marker (integration)', () => {
  test('the live session is marked while its turn runs and unmarked when it ends', async ({ page }) => {
    await waitForApp(page);
    await startTurn(page, LONG_PROMPT);
    const id = await currentSessionId(page);

    // Mid-turn: the session's own row is both the current one and marked as working.
    const dialog = await openHistory(page);
    const row = dialog.locator(`[data-session-id="${id}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole('img', { name: 'Working now' })).toHaveCount(1, { timeout: 15_000 });

    // The modal must be closed to reach Stop: the centered-modal shell renders a
    // full-viewport `.overlay` (position: fixed; inset: 0) as its click-outside-to-close
    // catcher, so it swallows every click behind it. Stopping with the list open is not
    // something a user can do either. The "mark clears while the list stays open" case is
    // the second test's job, where the stop comes from a different page.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop' }).click();

    // Reopening reads the ids from App state (server-pushed), not from the row cache,
    // so the finished turn is unmarked.
    const reopened = await openHistory(page);
    const stoppedRow = reopened.locator(`[data-session-id="${id}"]`);
    await expect(stoppedRow).toBeVisible({ timeout: 15_000 });
    await expect(stoppedRow.getByRole('img', { name: 'Working now' })).toHaveCount(0, { timeout: 15_000 });
  });

  test('a turn running in one panel is marked in another panel list', async ({ page, context }) => {
    await waitForApp(page);
    const other = await context.newPage();
    await waitForApp(other);

    // The second page is a separate client with its own session entry, so anything it
    // shows about the first page's session came from the server's active set.
    await startTurn(page, LONG_PROMPT);
    const id = await currentSessionId(page);

    const dialog = await openHistory(other);
    const row = dialog.locator(`[data-session-id="${id}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole('img', { name: 'Working now' })).toHaveCount(1, { timeout: 15_000 });

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(row.getByRole('img', { name: 'Working now' })).toHaveCount(0, { timeout: 15_000 });
    await other.close();
  });
});
