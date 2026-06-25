import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// Exercises the per-session line-count column end to end against the real backend
// `readSessionMeta`/`listSessions`/`listAllSessions`: the dev server reads the
// actual ~/.claude/projects transcripts, sums the lines of text/code in each, and
// returns it as `lines`. The webview renders it as a right-aligned `rowCount` cell
// in both Session History tabs. These are integration tests because the count is
// computed by the backend from real transcript content.

// Sends a prompt and waits for the turn to complete (Stop appears then clears).
async function sendAndWait(page: Page, text: string) {
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  const stopBtn = page.getByRole('button', { name: 'Stop' });
  await expect(stopBtn).toBeVisible({ timeout: 15_000 });
  await expect(stopBtn).toHaveCount(0, { timeout: 90_000 });
}

// Parse the compact badge ("206" or "1.2k") back into a number for comparisons.
function parseCount(s: string): number {
  const m = s.trim().match(/^([\d.]+)(k?)$/i);
  if (!m) return 0;
  return parseFloat(m[1]) * (m[2] ? 1000 : 1);
}

// Open Session History, read the live (current) session row's line-count cell,
// then close the modal. Returns the parsed count.
async function readCurrentCount(page: Page): Promise<number> {
  await page.getByRole('button', { name: 'Session history' }).click();
  const dialog = page.getByRole('dialog', { name: 'Session History' });
  await expect(dialog).toBeVisible();
  await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });

  const current = dialog.locator('[class*="rowCurrent"]');
  await expect(current).toBeVisible({ timeout: 10_000 });
  const text = (await current.locator('[class*="rowCount"]').textContent())?.trim() ?? '';

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  return parseCount(text);
}

test.describe('session history - line count (integration)', () => {
  test('the live session row shows a transcript line count that grows with the conversation', async ({ page }) => {
    await waitForApp(page);

    // 1. Create a session whose assistant reply spans many lines, so the backend
    //    has real multi-line content to count.
    await sendAndWait(page, 'List the numbers from 1 to 20, each on its own line. No other text.');

    // 2. The current session's row carries a non-empty, positive line count read
    //    back from the real transcript (user prompt + multi-line assistant reply).
    const count1 = await readCurrentCount(page);
    expect(count1).toBeGreaterThan(0);

    // 3. Grow the same session with a second, longer multi-line reply.
    await sendAndWait(page, 'Now list the numbers from 21 to 60, each on its own line. No other text.');

    // 4. Re-reading the (now larger) transcript yields a strictly larger count -
    //    proving the number reflects real transcript content, not a constant.
    const count2 = await readCurrentCount(page);
    expect(count2).toBeGreaterThan(count1);
  });

  test('all-workspaces rows render a numeric line-count column from real transcripts', async ({ page }) => {
    await waitForApp(page);

    // Ensure this workspace has at least one real session, then open the global tab
    // (the dev machine already has many sessions across workspaces, all with content).
    await sendAndWait(page, 'Reply with just "OK".');

    await page.getByRole('button', { name: 'Session history' }).click();
    const dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('tab', { name: 'All workspaces' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Search all sessions' })).toBeVisible();
    await expect(dialog.getByText('Loading...')).toHaveCount(0, { timeout: 20_000 });

    // At least one global row renders, and each carries its own count cell.
    const rows = dialog.locator('[class*="allRowMain"]');
    await expect(rows.first()).toBeVisible();
    const counts = dialog.locator('[class*="rowCount"]');
    await expect(counts.first()).toBeVisible();

    // Real transcripts have content, so at least one row shows a positive count.
    const texts = await counts.allTextContents();
    const positive = texts.map(t => parseCount(t)).filter(n => n > 0);
    expect(positive.length).toBeGreaterThan(0);
  });
});
