import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

// Integration tests for realtime token spending (Steps 2-4 of the plan):
// - Backend emits `token_update` WS frames from stream_event message_start/message_delta
// - Input count sums all token variants (raw + cache_read + cache_creation), not just raw
// - Final token counts persist in the completed message's response timer

const PROMPT = 'Reply with the single word "ok" and nothing else.';

test('token_update WS frames arrive during a real turn', async ({ page }) => {
  const tokenUpdates: { inputTokens?: number; outputTokens?: number }[] = [];

  page.on('websocket', ws => {
    ws.on('framereceived', frame => {
      try {
        const payload = JSON.parse(frame.payload as string);
        if (payload?.type === 'token_update') {
          tokenUpdates.push({ inputTokens: payload.inputTokens, outputTokens: payload.outputTokens });
        }
      } catch { /* non-JSON ping/pong */ }
    });
  });

  await waitForApp(page);
  await page.getByPlaceholder('Ask Argus').fill(PROMPT);
  await page.getByRole('button', { name: 'Send' }).click();

  const stopBtn = page.getByRole('button', { name: 'Stop' });
  await expect(stopBtn).toBeVisible({ timeout: 10_000 });
  await expect(stopBtn).toHaveCount(0, { timeout: 90_000 });
  await page.waitForTimeout(300);

  // message_start fires at turn start and sends inputTokens
  const inputUpdates = tokenUpdates.filter(u => u.inputTokens != null);
  expect(inputUpdates.length).toBeGreaterThanOrEqual(1);

  // Input count must be >1: raw input_tokens is often just 1 when most context is
  // cached; the correct value sums raw + cache_read + cache_creation.
  const maxInput = Math.max(...inputUpdates.map(u => u.inputTokens!));
  expect(maxInput).toBeGreaterThan(1);

  // message_delta fires periodically with cumulative output token count
  const outputUpdates = tokenUpdates.filter(u => u.outputTokens != null);
  expect(outputUpdates.length).toBeGreaterThanOrEqual(1);
  const maxOutput = Math.max(...outputUpdates.map(u => u.outputTokens!));
  expect(maxOutput).toBeGreaterThan(0);
});

test('completed message timer shows final token counts', async ({ page }) => {
  await waitForApp(page);
  await page.getByPlaceholder('Ask Argus').fill(PROMPT);
  await page.getByRole('button', { name: 'Send' }).click();

  const stopBtn = page.getByRole('button', { name: 'Stop' });
  await expect(stopBtn).toBeVisible({ timeout: 10_000 });
  await expect(stopBtn).toHaveCount(0, { timeout: 90_000 });

  // The success timer on the completed message should include "out /" and "in"
  const timer = page.locator('[class*="responseTimeSuccess"]');
  await expect(timer).toBeVisible({ timeout: 5_000 });
  await expect(timer).toContainText('out /');
  await expect(timer).toContainText('in');

  // Sanity: values should be parseable positive numbers
  const text = await timer.textContent() ?? '';
  const match = text.match(/(\d[\d\s,]*)\s+out\s*\/\s*(\d[\d\s,]*)\s+in/);
  expect(match).not.toBeNull();
  const outVal = parseInt((match![1] ?? '').replace(/[\s,]/g, ''), 10);
  const inVal  = parseInt((match![2] ?? '').replace(/[\s,]/g, ''), 10);
  expect(outVal).toBeGreaterThan(0);
  expect(inVal).toBeGreaterThan(1); // same cache-sum check
});
