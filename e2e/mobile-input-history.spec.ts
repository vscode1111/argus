import { test, expect } from '@playwright/test';

test('mobile input buttons browse sent messages and restore the draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.routeWebSocket('**/*', socket => socket.close());
  await page.goto('/?mock=1');

  const input = page.getByPlaceholder('Ask Argus');
  const previous = page.getByRole('button', { name: 'Previous input' });
  const next = page.getByRole('button', { name: 'Next input' });
  await expect(input).toBeVisible();
  await expect(previous).toBeDisabled();
  await expect(next).toBeDisabled();

  await input.fill('First question');
  await page.getByRole('button', { name: 'Send' }).click();
  await input.fill('Second question');
  await page.getByRole('button', { name: 'Send' }).click();
  await input.fill('Current draft');

  await previous.click();
  await expect(input).toHaveValue('Second question');
  await previous.click();
  await expect(input).toHaveValue('First question');
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(input).toHaveValue('Second question');
  await next.click();
  await expect(input).toHaveValue('Current draft');
  await expect(next).toBeDisabled();
  await input.focus();
  await input.press('ArrowUp');
  await expect(input).toHaveValue('Second question');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('Current draft');

  const inputBox = await input.boundingBox();
  const historyBox = await previous.boundingBox();
  const nextBox = await next.boundingBox();
  const sendBox = await page.getByRole('button', { name: 'Send' }).boundingBox();
  expect(inputBox && historyBox && nextBox && sendBox).toBeTruthy();
  expect(historyBox!.width).toBe(18);
  expect(historyBox!.x - (inputBox!.x + inputBox!.width)).toBe(5);
  expect(sendBox!.x - (historyBox!.x + historyBox!.width)).toBe(4);
  expect(nextBox!.y - (historyBox!.y + historyBox!.height)).toBe(2);
});

test('input history buttons are hidden on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await page.routeWebSocket('**/*', socket => socket.close());
  await page.goto('/?mock=1');
  await expect(page.getByPlaceholder('Ask Argus')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous input' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next input' })).toHaveCount(0);
});
