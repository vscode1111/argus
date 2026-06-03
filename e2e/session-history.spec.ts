import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

const NOW = Date.now();

const SESSIONS = [
  { id: '11111111-1111-1111-1111-111111111111', title: 'scub-newest-session', lastPrompt: 'do the newest thing', updatedAt: NOW - 60_000 },
  { id: '22222222-2222-2222-2222-222222222222', title: 'scub-current-session', lastPrompt: 'this is the live one', updatedAt: NOW - 3_600_000 },
  { id: '33333333-3333-3333-3333-333333333333', title: 'scub-oldest-session', lastPrompt: 'an older request', updatedAt: NOW - 2 * 86_400_000 },
];

// Open the modal via the history button, then wait for the real (dev server)
// reply to land so a following mock dispatch is the final write that wins.
async function openModal(page: Page) {
  await page.getByRole('button', { name: 'Session history' }).click();
  await expect(page.getByRole('dialog', { name: 'Session History' })).toBeVisible();
  await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 15_000 });
}

test.describe('session history', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('history button opens the modal and lists sessions with the current one marked', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'sessionList', sessions: SESSIONS, currentId: SESSIONS[1].id });

    const dialog = page.getByRole('dialog', { name: 'Session History' });
    // One delete button per row -> a stable row count.
    await expect(dialog.getByRole('button', { name: 'Delete session' })).toHaveCount(3);

    await expect(dialog.getByText('scub-newest-session')).toBeVisible();
    await expect(dialog.getByText('scub-current-session')).toBeVisible();
    await expect(dialog.getByText('scub-oldest-session')).toBeVisible();

    // The live session row is highlighted (green background) rather than badged.
    await expect(dialog.locator('[class*="rowCurrent"]')).toHaveCount(1);
  });

  test('search filters sessions by title and prompt', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'sessionList', sessions: SESSIONS, currentId: SESSIONS[1].id });

    const dialog = page.getByRole('dialog', { name: 'Session History' });
    await dialog.getByRole('textbox', { name: 'Search sessions' }).fill('oldest');

    await expect(dialog.getByRole('button', { name: 'Delete session' })).toHaveCount(1);
    await expect(dialog.getByText('scub-oldest-session')).toBeVisible();
    await expect(dialog.getByText('scub-newest-session')).toHaveCount(0);
  });

  test('delete optimistically removes a row', async ({ page }) => {
    await openModal(page);
    // A fake (non-existent) session id: the dev server validates the UUID and
    // finds no file, so the real deleteSession is a no-op and nothing real is lost.
    const fake = { id: '00000000-0000-0000-0000-000000000099', title: 'scub-delete-me', lastPrompt: 'remove me', updatedAt: NOW - 5_000 };
    await send(page, { type: 'sessionList', sessions: [fake], currentId: undefined });

    const dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog.getByText('scub-delete-me')).toBeVisible();

    await dialog.getByRole('button', { name: 'Delete session' }).click();
    await expect(dialog.getByText('scub-delete-me')).toHaveCount(0);
  });

  test('sessionLoaded replays a conversation into the message list', async ({ page }) => {
    // The reducer handles sessionLoaded at the App level (independent of the modal).
    await send(page, {
      type: 'sessionLoaded',
      id: SESSIONS[1].id,
      messages: [
        { id: 'replay-1', role: 'user', content: 'scub-replay-question' },
        { id: 'replay-2', role: 'assistant', content: 'scub-replay-answer', blocks: [{ type: 'text', text: 'scub-replay-answer' }], outcome: 'success' },
      ],
    });

    await expect(page.getByText('scub-replay-question')).toBeVisible();
    await expect(page.getByText('scub-replay-answer')).toBeVisible();
  });

  test('rename: pencil opens an inline editor and commits a new title on Enter', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'sessionList', sessions: SESSIONS, currentId: SESSIONS[1].id });

    const dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog.getByText('scub-newest-session')).toBeVisible();

    // Pencil on the first row opens the inline editor prefilled with the title.
    await dialog.getByRole('button', { name: 'Rename session' }).first().click();
    const input = dialog.getByRole('textbox', { name: 'Rename session' });
    await expect(input).toHaveValue('scub-newest-session');

    // Edit and commit with Enter.
    await input.fill('scub-renamed-session');
    await input.press('Enter');

    // Editor closes; the row shows the new title optimistically.
    await expect(dialog.getByRole('textbox', { name: 'Rename session' })).toHaveCount(0);
    await expect(dialog.getByText('scub-renamed-session')).toBeVisible();
    await expect(dialog.getByText('scub-newest-session')).toHaveCount(0);
  });

  test('rename: Escape cancels the edit without changing the title or closing the modal', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'sessionList', sessions: SESSIONS, currentId: SESSIONS[1].id });

    const dialog = page.getByRole('dialog', { name: 'Session History' });
    await dialog.getByRole('button', { name: 'Rename session' }).first().click();
    const input = dialog.getByRole('textbox', { name: 'Rename session' });
    await input.fill('scub-should-not-stick');
    await input.press('Escape');

    // Editor closes, title unchanged, and the modal stays open.
    await expect(dialog.getByRole('textbox', { name: 'Rename session' })).toHaveCount(0);
    await expect(dialog.getByText('scub-newest-session')).toBeVisible();
    await expect(dialog.getByText('scub-should-not-stick')).toHaveCount(0);
    await expect(dialog).toBeVisible();
  });

  test('refresh button re-fetches the session list', async ({ page }) => {
    await openModal(page);
    await send(page, { type: 'sessionList', sessions: SESSIONS, currentId: SESSIONS[1].id });

    const dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog.getByText('scub-newest-session')).toBeVisible();

    // Clicking refresh re-requests the list; simulate a fresh server reply with
    // a different set and assert the modal re-renders it.
    await dialog.getByRole('button', { name: 'Refresh sessions' }).click();
    await send(page, {
      type: 'sessionList',
      sessions: [{ id: '44444444-4444-4444-4444-444444444444', title: 'scub-refreshed-session', lastPrompt: 'fresh', updatedAt: NOW }],
      currentId: undefined,
    });

    await expect(dialog.getByText('scub-refreshed-session')).toBeVisible();
    await expect(dialog.getByText('scub-newest-session')).toHaveCount(0);
  });

  test('Escape closes the modal', async ({ page }) => {
    await openModal(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Session History' })).toHaveCount(0);
  });
});
