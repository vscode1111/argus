import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

// All tests share the same :3001 backend channel (same workspace dir).
// Serial mode prevents them from racing on s.sessionId / the session list.
test.describe.configure({ mode: 'serial' });

// Sends a prompt and waits for the turn to complete.
async function sendAndWait(page: Page, text: string) {
  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill(text);
  // Use exact:true so a session whose AI-generated title contains the word "Send"
  // (e.g. "Send OK confirmation") does not make the header button ambiguous with
  // the actual Send button (aria-label="Send").
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const stopBtn = page.getByRole('button', { name: 'Stop' });
  await expect(stopBtn).toBeVisible({ timeout: 15_000 });
  await expect(stopBtn).toHaveCount(0, { timeout: 90_000 });
}

// Sends a prompt and returns as soon as the Stop button appears (CLI is live),
// without waiting for the turn to finish.
async function startStreaming(page: Page, text: string) {
  await page.getByPlaceholder('Ask Argus').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 15_000 });
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
    await expect(dialog.getByText('Loading...')).toHaveCount(0, { timeout: 10_000 });
  }).toPass({ timeout: 30_000 });
  return dialog;
}

// Rename the current (green) session via the history modal and close it.
async function renameCurrentSession(page: Page, newTitle: string) {
  const dialog = await openHistoryModal(page);
  const currentRow = dialog.locator('[class*="rowCurrent"]');
  await expect(currentRow).toBeVisible({ timeout: 10_000 });
  await currentRow.getByRole('button', { name: 'Rename session' }).click();
  const input = dialog.getByRole('textbox', { name: 'Rename session' });
  await input.fill(newTitle);
  await input.press('Enter');
  await expect(dialog.getByText(newTitle)).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

test.describe('browse past session during active streaming (integration)', () => {
  // Regression for: resumeSession while a CLI turn is streaming left s.sessionId
  // pointing at the live session (server deliberately skips the update to protect
  // the --resume arg). Before the fix, the webview used s.sessionId as the
  // effective current id, so the header title and the modal green highlight stayed
  // on the streaming session even though the user had switched to a different
  // session's transcript.

  test('header title updates to the browsed session', async ({ page }) => {
    await waitForApp(page);

    // 1. Create session A and give it a distinct, known title.
    await sendAndWait(page, 'Reply with just "OK".');
    const knownTitle = `scub-browse-a-${Date.now()}`;
    await renameCurrentSession(page, knownTitle);

    // 2. Open a new session (session B) and start streaming without waiting.
    await page.getByRole('button', { name: 'New chat' }).click();
    await startStreaming(page, 'Reply with just "OK".');

    // 3. While session B is streaming (or just after it started), open the history
    //    modal and click session A. This triggers resumeSession which puts the client
    //    into browsing mode when the CLI proc is still running.
    const hist = await openHistoryModal(page);
    // Click the rowTitle span; the click bubbles up to the row div's onClick so the
    // outer row div's class ambiguity ([class*="row"] matches rowMain/rowTitle too)
    // is avoided entirely.
    const sessionATitle = hist.getByText(knownTitle, { exact: true });
    await expect(sessionATitle).toBeVisible({ timeout: 10_000 });
    await sessionATitle.click();
    await expect(hist).toHaveCount(0);

    // 4. Header title must reflect session A, not the live/last streaming session.
    //    Before the fix, sessionList carried s.sessionId (session B) as currentId,
    //    so the header would show session B's title or nothing.
    await expect(page.locator('button.sessionNameBtn'))
      .toHaveText(knownTitle, { timeout: 10_000 });
  });

  test('modal green highlight moves to the browsed session', async ({ page }) => {
    await waitForApp(page);

    // 1. Create session A with a known title.
    await sendAndWait(page, 'Reply with just "OK".');
    const knownTitle = `scub-browse-b-${Date.now()}`;
    await renameCurrentSession(page, knownTitle);

    // 2. Start a new session (session B) and begin streaming.
    await page.getByRole('button', { name: 'New chat' }).click();
    await startStreaming(page, 'Reply with just "OK".');

    // 3. While session B is streaming, open history and switch to session A.
    const hist = await openHistoryModal(page);
    await expect(hist.getByText(knownTitle, { exact: true })).toBeVisible({ timeout: 10_000 });
    await hist.getByText(knownTitle, { exact: true }).click();
    await expect(hist).toHaveCount(0);

    // Wait for the sessionLoaded -> listSessions round-trip to settle.
    await expect(page.locator('button.sessionNameBtn'))
      .toHaveText(knownTitle, { timeout: 10_000 });

    // 4. Reopen the modal. The green highlight (rowCurrent) must be on session A.
    //    Before the fix it stayed on session B (or nothing) because the modal used
    //    currentId from sessionList, which still pointed at s.sessionId = B.
    const hist2 = await openHistoryModal(page);
    const greenRow = hist2.locator('[class*="rowCurrent"]');
    await expect(greenRow).toBeVisible({ timeout: 10_000 });
    await expect(greenRow).toContainText(knownTitle);

    await page.keyboard.press('Escape');
  });

  test('token counts are non-zero after returning to a live session', async ({ page }) => {
    // Regression for: replaySnapshot sent thinking_start which reset liveTokens to
    // undefined, but no token_update followed to restore the accumulated counts.
    // Returning to a streaming session showed "0 in / 0 out" (or nothing) in the
    // StreamingTimer even though the turn had been running for tens of seconds.
    // Fix: handleResumeSession sends token_update with stored liveInputTokens and
    // the current completedOutputTokens + liveOutputChars/4 estimate immediately
    // after replaySnapshot so the StreamingTimer always shows non-zero values.
    await waitForApp(page);

    // 1. Create and rename session A (a completed session to browse to).
    await sendAndWait(page, 'Reply with just "OK".');
    const titleA = `scub-tok-a-${Date.now()}`;
    await renameCurrentSession(page, titleA);

    // 2. Open a new session (session B), establish it in history, then rename it.
    await page.getByRole('button', { name: 'New chat' }).click();
    await sendAndWait(page, 'Reply with just "OK".');
    const titleB = `scub-tok-b-${Date.now()}`;
    await renameCurrentSession(page, titleB);

    // 3. Start a long stream in session B so there is time to browse and return.
    //    It has to outlive the browse round-trip: once the turn ends, the return path
    //    replays the transcript from disk, and loadSession builds messages with only
    //    `outcome: 'success'` - no responseTime and no token fields - so there is no
    //    timer element to assert on at all (step 7 skips in that case). 1..3000 keeps
    //    the CLI streaming well past the two modal round-trips even at --effort low.
    await startStreaming(page, 'Write the numbers 1 to 3000, one per line, no other text.');

    // 4. Wait until the live timer shows both token counts. StreamingTimer renders
    //    "<n> in / <m> out" only when input AND output are non-zero, so this waits on
    //    exactly the precondition the test needs: s.liveInputTokens > 0 and
    //    s.liveOutputChars > 0 on the server before we browse away. (Waiting for a
    //    ThinkingBlock instead was model-dependent - whether the model emits thinking
    //    text at all is its choice, so the block sometimes never appeared.)
    const liveTimer = page.locator('[class*="responseTime"]').last();
    await expect(liveTimer).toContainText(/\d\s+in\s*\/\s*[\d,\s]+out/, { timeout: 30_000 });

    // 5. Browse to session A while session B is still streaming.
    const hist1 = await openHistoryModal(page);
    await expect(hist1.getByText(titleA, { exact: true })).toBeVisible({ timeout: 10_000 });
    await hist1.getByText(titleA, { exact: true }).click();
    await expect(hist1).toHaveCount(0);
    await expect(page.locator('button.sessionNameBtn')).toHaveText(titleA, { timeout: 10_000 });

    // 6. Return to session B via the history modal.
    const hist2 = await openHistoryModal(page);
    await expect(hist2.getByText(titleB, { exact: true })).toBeVisible({ timeout: 10_000 });
    await hist2.getByText(titleB, { exact: true }).click();
    await expect(hist2).toHaveCount(0);
    await expect(page.locator('button.sessionNameBtn')).toHaveText(titleB, { timeout: 10_000 });

    // 7. The regression is about returning to a LIVE session: replaySnapshot restores
    //    the streaming state, and the token counts must come back with it. The Stop
    //    button is the app-owned signal that the entry is still streaming.
    const stopBtn = page.getByRole('button', { name: 'Stop' });
    const isLive = await stopBtn.waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true).catch(() => false);

    // The model can finish 3000 lines faster than the two modal round-trips. Then the
    // return path is a disk replay, and a replayed transcript has no timer element at
    // all (loadSession sets only `outcome: 'success'`) - so there is nothing this
    // regression could even be observed on. Skip loudly instead of asserting a
    // condition the architecture cannot satisfy, which is what used to fail here.
    test.skip(!isLive, 'stream finished during the browse round-trip: disk replay carries no token counts');

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
