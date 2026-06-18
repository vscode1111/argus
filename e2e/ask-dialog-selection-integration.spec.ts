import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('selecting non-first option: Claude acknowledges the correct choice', async ({ page }) => {
  await waitForApp(page);

  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill(
    'Use AskUserQuestion with exactly these 4 options (single-select, no multiSelect): ' +
    'label "Alpha", label "Beta", label "Gamma", label "Delta". ' +
    'Question text: "Pick one". Header: "Pick". ' +
    'After I answer, respond with ONLY the label I chose, nothing else.'
  );
  await page.getByRole('button', { name: 'Send' }).click();

  const dialog = page.locator('[class*="askDialog"]');
  await expect(dialog).toBeVisible({ timeout: 60_000 });

  // Verify all 4 options rendered
  const optionLabels = dialog.locator('[class*="questionOptionLabel"]');
  await expect(async () => {
    const count = await optionLabels.count();
    // 4 options + auto-injected "Other" = 5
    expect(count).toBeGreaterThanOrEqual(4);
  }).toPass({ timeout: 5_000 });

  // Select the third option ("Gamma")
  await optionLabels.filter({ hasText: 'Gamma' }).click();

  const selected = dialog.locator('[class*="questionOptionSelected"]');
  await expect(selected.locator('[class*="questionOptionLabel"]')).toHaveText('Gamma');

  // Submit
  const submitBtn = dialog.getByRole('button', { name: 'Submit answers' });
  await expect(submitBtn).toBeEnabled();
  await submitBtn.click();

  // Result summary should show Gamma
  const summary = dialog.locator('[class*="askResultSummary"]');
  await expect(summary).toContainText('Gamma', { timeout: 10_000 });

  // Wait for Claude's response and verify it contains "Gamma" (not "Alpha")
  const messageArea = page.locator('[class*="messageList"], [class*="messages"]');
  await expect(async () => {
    const text = await messageArea.textContent();
    expect(text).toContain('Gamma');
  }).toPass({ timeout: 60_000 });

  // Claude's final reply (markdown text in messageContent) must reference the
  // chosen label. Scope to assistant messages: the user prompt lists every label
  // and the dialog UI shows them too, but neither is inside an assistant
  // messageContent block, so this isolates Claude's actual response without
  // relying on a specific <p> wrapper being rendered.
  const assistantText = page.locator('[class*="assistant"] [class*="messageContent"]');
  await expect(async () => {
    const texts = await assistantText.allTextContents();
    expect(texts.some(t => t.includes('Gamma'))).toBe(true);
  }).toPass({ timeout: 20_000 });
});

test('selecting last option: Claude acknowledges correct choice', async ({ page }) => {
  await waitForApp(page);

  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill(
    'Use AskUserQuestion with exactly 3 options (single-select): ' +
    'label "First", label "Second", label "Third". ' +
    'Question: "Which one?". Header: "Choice". ' +
    'After I answer, reply with ONLY the exact label I picked.'
  );
  await page.getByRole('button', { name: 'Send' }).click();

  const dialog = page.locator('[class*="askDialog"]');
  await expect(dialog).toBeVisible({ timeout: 60_000 });

  // Select the last real option ("Third")
  const optionLabels = dialog.locator('[class*="questionOptionLabel"]');
  await optionLabels.filter({ hasText: 'Third' }).click();

  const selected = dialog.locator('[class*="questionOptionSelected"]');
  await expect(selected.locator('[class*="questionOptionLabel"]')).toHaveText('Third');

  await dialog.getByRole('button', { name: 'Submit answers' }).click();

  const summary = dialog.locator('[class*="askResultSummary"]');
  await expect(summary).toContainText('Third', { timeout: 10_000 });

  // Claude's response must contain "Third"
  const messageArea = page.locator('[class*="messageList"], [class*="messages"]');
  await expect(async () => {
    const text = await messageArea.textContent();
    expect(text).toContain('Third');
  }).toPass({ timeout: 60_000 });
});
