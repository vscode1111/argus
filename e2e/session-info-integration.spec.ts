import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// The Settings "Info" tab reports which conversation this panel is in: the session id
// the CLI assigned, and the transcript file backing it. Both come from the live
// serverInfo reply, so they only appear once a turn has actually run.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

async function openInfoTab(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Info' }).click();
  return dialog;
}

test.describe('session info in Settings (integration)', () => {
  test('Info tab shows the live session id and its transcript path', async ({ page, context }) => {
    await waitForApp(page);
    // Own channel entry, so a concurrent worker cannot move this panel's sessionId.
    await page.getByRole('button', { name: 'New chat' }).click();

    // Before any turn the CLI has not issued a session id yet.
    let dialog = await openInfoTab(page);
    await expect(dialog.getByTestId('session-id')).toHaveText('(no session yet)');
    await page.keyboard.press('Escape');

    // Run one real turn so the CLI creates the session and its transcript.
    await page.getByPlaceholder('Ask Argus').fill('Reply with just "OK".');
    await page.getByRole('button', { name: 'Send' }).click();
    const stopBtn = page.getByRole('button', { name: 'Stop' });
    await expect(stopBtn).toBeVisible({ timeout: 15_000 });
    await expect(stopBtn).toHaveCount(0, { timeout: 60_000 });

    // The rows fill in from the serverInfo reply, so wait for that roundtrip rather
    // than reading straight after the modal opens.
    dialog = await openInfoTab(page);
    await expect(dialog.getByTestId('session-id')).toHaveText(UUID_RE, { timeout: 10_000 });
    const id = (await dialog.getByTestId('session-id').textContent() ?? '').trim();

    // The transcript path must point at that session's .jsonl inside the CLI's
    // per-project folder, which is what makes the row useful for finding it on disk.
    const filePath = (await dialog.getByTestId('session-path').textContent() ?? '').trim();
    expect(filePath).toContain(`${id}.jsonl`);
    expect(filePath.replace(/\\/g, '/')).toContain('/.claude/projects/');

    // Clicking either value copies it. Read the clipboard back rather than trusting the
    // "Copied!" label, which would still appear if the wrong text were written.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const widthBefore = (await dialog.boundingBox())?.width ?? 0;
    await dialog.getByTestId('session-path').click();
    await expect(dialog.getByTestId('session-path').getByText('Copied!')).toBeVisible();
    expect(await readClipboard(page)).toBe(filePath);

    // Regression: the modal is content-sized, so replacing the long transcript path
    // with "Copied!" used to collapse its width for a second and snap back. The value
    // must keep its box while the feedback shows.
    const widthDuring = (await dialog.boundingBox())?.width ?? 0;
    expect(Math.abs(widthDuring - widthBefore)).toBeLessThan(2);

    // The feedback is per row: copying the id must not label the path row too.
    await expect(dialog.getByTestId('session-path').getByText('Copied!')).toHaveCount(0, { timeout: 5_000 });
    await dialog.getByTestId('session-id').click();
    await expect(dialog.getByTestId('session-id').getByText('Copied!')).toBeVisible();
    await expect(dialog.getByTestId('session-path').getByText('Copied!')).toHaveCount(0);
    expect(await readClipboard(page)).toBe(id);

    // The workspace path row copies the same way.
    await expect(dialog.getByTestId('session-id').getByText('Copied!')).toHaveCount(0, { timeout: 5_000 });
    const workspacePath = (await dialog.getByTestId('workspace-path').textContent() ?? '').trim();
    await dialog.getByTestId('workspace-path').click();
    await expect(dialog.getByTestId('workspace-path').getByText('Copied!')).toBeVisible();
    expect(await readClipboard(page)).toBe(workspacePath);
  });

  // The extension and the daemon are separate installs that find each other through
  // one machine-global discovery file, so a panel can end up served by an older
  // daemon left running by another install - it connects fine and just quietly lacks
  // the newer features. The Info tab used to show only the UI version, which is never
  // the stale half, so the mismatch was invisible.
  test('Info tab reports the version of the server actually serving the panel', async ({ page }) => {
    await waitForApp(page);
    const dialog = await openInfoTab(page);

    const pkgVersion = require('../package.json').version as string;
    await expect(dialog.getByTestId('server-version')).toHaveText(pkgVersion, { timeout: 10_000 });

    // Matching versions must not be flagged: the warning only means something if it
    // stays quiet in the normal case.
    await expect(dialog.getByTestId('server-version')).not.toContainText('stale');
  });
});
