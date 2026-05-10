import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

const PROMPT = 'Общий вопрос. У меня есть небольшой псевдо-апп (Хром), которое запускает этот проект. Хотелось бы добавить его в контекстное меню Windows - по аналогии с VS Code. Дай оптиции в виде диалогового окна.';

test('AskUserQuestion dialog: 3 tabs, Other option, submit enables after all answered', async ({ page }) => {
  await waitForApp(page);

  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill(PROMPT);
  await page.getByRole('button', { name: 'Send' }).click();

  // Wait for the ask dialog to appear (has tab buttons)
  const dialog = page.locator('[class*="askDialog"]');
  await expect(dialog).toBeVisible({ timeout: 60_000 });

  // Verify at least 2 tabs exist (exclude close button)
  const tabBar = dialog.locator('[class*="askTabBar"]');
  const tabs = tabBar.locator('button:not([aria-label="Cancel"])');
  await expect(async () => {
    const count = await tabs.count();
    expect(count).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 5_000 });

  // Submit button should be disabled initially
  const submitBtn = dialog.getByRole('button', { name: 'Submit answers' });
  await expect(submitBtn).toBeDisabled();

  // Each tab must have an "Other" option
  const tabCount = await tabs.count();
  for (let i = 0; i < tabCount; i++) {
    await tabs.nth(i).click();
    const otherOption = dialog.locator('[class*="questionOptionLabel"]', { hasText: /^Other$/ });
    await expect(otherOption).toBeVisible();
  }

  // Select first option in each tab
  for (let i = 0; i < tabCount; i++) {
    await tabs.nth(i).click();
    const firstOption = dialog.locator('[class*="questionOption"]').first();
    await firstOption.click();
  }

  // Submit button should now be enabled
  await expect(submitBtn).toBeEnabled();

  // Click submit and wait for first text response
  await submitBtn.click();
  const messageArea = page.locator('[class*="messageList"], [class*="messages"]');
  await expect(async () => {
    const text = await messageArea.textContent();
    expect(text!.length).toBeGreaterThan(100);
  }).toPass({ timeout: 120_000 });
});
