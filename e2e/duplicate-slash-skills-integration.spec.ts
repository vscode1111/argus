import { test, expect } from './provider-fixtures';
import { waitForApp } from './helpers';

test('slash menu shows each provider skill name once', { tag: ['@codex'] }, async ({ page }) => {
  const skillReplies: Array<{ skills?: Array<{ name?: string }>; error?: string }> = [];
  page.on('websocket', socket => socket.on('framereceived', frame => {
    try {
      const reply = JSON.parse(String(frame.payload));
      if (reply.type === 'skills') skillReplies.push(reply);
    } catch { /* Other frames are not skill replies. */ }
  }));
  await waitForApp(page);
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill('/skill-creator');

  // The menu requests the native skill list asynchronously. Wait for that response
  // before checking the rendered list, so provider startup is not a UI assertion race.
  await expect.poll(() => skillReplies.some(reply => reply.skills?.some(skill => skill.name === 'skill-creator')), {
    timeout: 30_000,
    message: 'provider skill list did not include skill-creator',
  }).toBe(true);

  const items = page.locator('[class*="slashMenuItem"]');
  await expect(items).toHaveCount(1);
  await expect(items.first().locator('[class*="slashMenuName"]')).toHaveText('/skill-creator');
});
