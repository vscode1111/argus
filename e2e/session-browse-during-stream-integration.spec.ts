import { test, expect, type Page } from './provider-fixtures';
import { waitForApp } from './helpers';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// All tests share the same :3001 backend channel (same workspace dir).
// Serial mode prevents them from racing on s.sessionId / the session list.
test.describe.configure({ mode: 'serial' });

// Sends a prompt and returns as soon as the Stop button appears (CLI is live),
// without waiting for the turn to finish.
async function startStreaming(page: Page, text: string) {
  await page.getByPlaceholder('Ask Argus').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 15_000 });
}

const historyFixtures: string[] = [];
test.afterEach(() => {
  for (const file of historyFixtures.splice(0)) {
    try { fs.unlinkSync(file); } catch { /* already removed */ }
  }
});

// The older session is a finished transcript. Creating it directly keeps the
// browse assertion independent of how long a provider takes to answer a turn.
function createHistorySession(page: Page, title: string): string {
  const workspace = new URL(page.url()).searchParams.get('dir');
  if (!workspace) throw new Error('The test page has no isolated workspace');
  const id = randomUUID();
  const encodedDir = path.resolve(workspace).replace(/[^a-zA-Z0-9]/g, '-');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encodedDir);
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'system', subtype: 'init', cwd: workspace, session_id: id }),
    JSON.stringify({ type: 'custom-title', customTitle: title }),
    JSON.stringify({ type: 'user', cwd: workspace, message: { role: 'user', content: title } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Ready.' }] } }),
  ].join('\n') + '\n');
  historyFixtures.push(file);
  return id;
}

// Opens the Session History modal and waits for the session list to load.
// The list arrives over the WS, and under parallel integration load that round-trip
// occasionally outlasts a single wait. Reopening re-fires listSessions on mount, so
// retry the whole open rather than sitting on a request that may never land.
async function openHistoryModal(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Session History' });
  await expect(async () => {
    if (await dialog.count() > 0) {
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Session history' }).click();
    await expect(dialog).toBeVisible();
    // Short per-attempt wait: reopening re-fires listSessions, which recovers a lost
    // round-trip faster than sitting on one. Both budgets stay well inside the 30s
    // per-test timeout so a failure here is reported instead of timing the test out.
    await expect(dialog.getByText('Loading...')).toHaveCount(0, { timeout: 4_000 });
  }).toPass({ timeout: 12_000 });
  return dialog;
}

test.describe('browse past session during active streaming (integration)', () => {
  // Regression for: resumeSession while a CLI turn is streaming left s.sessionId
  // pointing at the live session (server deliberately skips the update to protect
  // the --resume arg). Before the fix, the webview used s.sessionId as the
  // effective current id, so the header title and the modal green highlight stayed
  // on the streaming session even though the user had switched to a different
  // session's transcript.

  test('header title updates to the browsed session', { tag: ["@shared"] }, async ({ page }) => {
    await waitForApp(page);

    // 1. Create a finished session A with a distinct title.
    const knownTitle = `History entry ${Date.now()}`;
    const sessionAId = createHistorySession(page, knownTitle);

    // 2. Open a new session (session B) and start streaming without waiting.
    await page.getByRole('button', { name: 'New chat' }).click();
    await startStreaming(page, 'Reply with just "OK".');

    // 3. While session B is streaming (or just after it started), open the history
    //    modal and click session A. This triggers resumeSession which puts the client
    //    into browsing mode when the CLI proc is still running.
    const hist = await openHistoryModal(page);
    // Select session A by its stable ID, independent of provider-generated titles.
    const sessionARow = hist.locator(`[data-session-id="${sessionAId}"]`);
    await expect(sessionARow).toBeVisible({ timeout: 10_000 });
    await sessionARow.click();
    await expect(hist).toHaveCount(0);

    // 4. Header title must reflect session A, not the live/last streaming session.
    //    Before the fix, sessionList carried s.sessionId (session B) as currentId,
    //    so the header would show session B's title or nothing.
    await expect(page.locator('button.sessionNameBtn'))
      .toHaveText(knownTitle, { timeout: 10_000 });
  });

  test('modal green highlight moves to the browsed session', { tag: ["@shared"] }, async ({ page }) => {
    // Session setup and the modal round-trips can outlast the flat 30s under suite load.
    // The first session is stopped as soon as it has an ID; the second stays live for
    // the browsing assertion.
    test.setTimeout(90_000);
    await waitForApp(page);

    // 1. Create session A and keep its stable id. A provider-side rename is not
    // needed to test which session receives the current-row highlight.
    const sessionAId = createHistorySession(page, 'Previous conversation');

    // 2. Start a new session (session B) and begin streaming.
    await page.getByRole('button', { name: 'New chat' }).click();
    await startStreaming(page, 'Reply with just "OK".');

    // 3. While session B is streaming, open history and switch to session A.
    const hist = await openHistoryModal(page);
    const sessionARow = hist.locator(`[data-session-id="${sessionAId}"]`);
    await expect(sessionARow).toBeVisible({ timeout: 10_000 });
    await sessionARow.click();
    await expect(hist).toHaveCount(0);

    // 4. Reopen the modal. The green highlight (rowCurrent) must be on session A.
    //    Before the fix it stayed on session B (or nothing) because the modal used
    //    currentId from sessionList, which still pointed at s.sessionId = B.
    const hist2 = await openHistoryModal(page);
    const greenRow = hist2.locator('[class*="rowCurrent"]');
    await expect(greenRow).toBeVisible({ timeout: 10_000 });
    await expect(greenRow).toHaveAttribute('data-session-id', sessionAId);

    await page.keyboard.press('Escape');
  });

  // This UI check needs a provider that publishes usage before its turn ends.
  test('token counts are non-zero after returning to a live session', { tag: ["@claude", "@claude-live"] }, async ({ page }) => {
    // Regression for: replaySnapshot sent thinking_start which reset liveTokens to
    // undefined, but no token_update followed to restore the accumulated counts.
    // Returning to a streaming session showed "0 in / 0 out" (or nothing) in the
    // StreamingTimer even though the turn had been running for tens of seconds.
    // Fix: handleResumeSession sends token_update with stored liveInputTokens and
    // the current completedOutputTokens + liveOutputChars/4 estimate immediately
    // after replaySnapshot so the StreamingTimer always shows non-zero values.
    //
    // The live provider must emit a measured token update before the browse check.
    test.setTimeout(60_000);
    await waitForApp(page);

    // 1. Create a finished session A to browse to. Session B is the live turn.
    const titleA = `Earlier session ${Date.now()}`;
    const sessionAId = createHistorySession(page, titleA);

    // 2. A foreground tool call holds session B open for the browse round-trip.
    // Native usage arrives at the tool boundary, before the sleep finishes.
    await startStreaming(page, 'Run exactly `sleep 20` with the shell tool in the foreground, then reply DONE.');
    await expect.poll(() => new URL(page.url()).searchParams.get('session'), { timeout: 30_000 }).toBeTruthy();
    const sessionBId = new URL(page.url()).searchParams.get('session')!;

    // 3. Wait until the live timer shows both token counts. StreamingTimer renders
    //    "<n> in / <m> out" only when input AND output are non-zero, so this waits on
    //    exactly the precondition the test needs: s.liveInputTokens > 0 and
    //    s.liveOutputChars > 0 on the server before we browse away. (Waiting for a
    //    ThinkingBlock instead was model-dependent - whether the model emits thinking
    //    text at all is its choice, so the block sometimes never appeared.)
    const liveTimer = page.locator('[class*="responseTime"]').last();
    await expect(liveTimer).toContainText(/\d\s+in\s*\/\s*[\d,\s]+out/, { timeout: 30_000 });

    // 4. Browse to session A while session B is still streaming.
    const hist1 = await openHistoryModal(page);
    const sessionARow = hist1.locator(`[data-session-id="${sessionAId}"]`);
    await expect(sessionARow).toBeVisible({ timeout: 10_000 });
    await sessionARow.click();
    await expect(hist1).toHaveCount(0);
    await expect(page.locator('button.sessionNameBtn')).toHaveText(titleA, { timeout: 10_000 });

    // 5. Return to session B via the history modal.
    const hist2 = await openHistoryModal(page);
    const sessionBRow = hist2.locator(`[data-session-id="${sessionBId}"]`);
    await expect(sessionBRow).toBeVisible({ timeout: 10_000 });
    await sessionBRow.click();
    await expect(hist2).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(sessionBId);

    // 6. The regression is about returning to a LIVE session: replaySnapshot restores
    //    the streaming state, and the token counts must come back with it. The Stop
    //    button is the app-owned signal that the entry is still streaming.
    const stopBtn = page.getByRole('button', { name: 'Stop' });
    const isLive = await stopBtn.waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true).catch(() => false);

    expect(isLive, 'the foreground command must keep the turn live through the browse').toBe(true);

    const timer = page.locator('[class*="responseTime"]').last();
    await expect(timer).toContainText('in /', { timeout: 15_000 });
    await expect(timer).toContainText('out');
    const timerText = await timer.textContent() ?? '';
    const m = timerText.match(/(\d[\d\s,]*)\s+in\s*\/\s*(\d[\d\s,]*)\s+out/);
    expect(m).not.toBeNull();
    const inVal  = parseInt((m![1] ?? '0').replace(/[\s,]/g, ''), 10);
    const outVal = parseInt((m![2] ?? '0').replace(/[\s,]/g, ''), 10);
    expect(inVal).toBeGreaterThan(0);
    expect(outVal).toBeGreaterThan(0);

    // Stop the stream so the next test starts from a clean state.
    await stopBtn.click();
    await expect(stopBtn).toHaveCount(0, { timeout: 30_000 });
  });
});
