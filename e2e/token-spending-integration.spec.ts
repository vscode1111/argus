import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

// Integration tests for realtime token spending:
// - Backend emits `token_update` WS frames from stream_event message_start/message_delta
// - Input count sums all token variants (raw + cache_read + cache_creation), not just raw
// - Final token counts persist in the completed message's response timer
// - Output token count never resets between API calls in a multi-step turn
// - ThinkingBlock tok estimate is not inflated (no doubled content from handleAssistant)

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

  // The success timer on the completed message should include "in /" and "out"
  const timer = page.locator('[class*="responseTimeSuccess"]');
  await expect(timer).toBeVisible({ timeout: 5_000 });
  await expect(timer).toContainText('in /');
  await expect(timer).toContainText('out');

  // Sanity: values should be parseable positive numbers
  const text = await timer.textContent() ?? '';
  const match = text.match(/(\d[\d\s,]*)\s+in\s*\/\s*(\d[\d\s,]*)\s+out/);
  expect(match).not.toBeNull();
  const inVal  = parseInt((match![1] ?? '').replace(/[\s,]/g, ''), 10);
  const outVal = parseInt((match![2] ?? '').replace(/[\s,]/g, ''), 10);
  expect(outVal).toBeGreaterThan(0);
  expect(inVal).toBeGreaterThan(1); // same cache-sum check
});

test('output token count never decreases between token_update frames', async ({ page }) => {
  // Regression for: each message_delta emitted only that call's per-message count.
  // In a multi-step turn the second call's count was smaller than the accumulated
  // estimate from the first, causing the StreamingTimer to jump backwards.
  // Fix: completedOutputTokens accumulates across all API calls so the running
  // total can only grow.
  const outputValues: number[] = [];

  page.on('websocket', ws => {
    ws.on('framereceived', frame => {
      try {
        const p = JSON.parse(frame.payload as string);
        if (p?.type === 'token_update' && p.outputTokens != null) {
          outputValues.push(p.outputTokens as number);
        }
      } catch { /* ping/pong */ }
    });
  });

  await waitForApp(page);
  await page.getByPlaceholder('Ask Argus').fill(PROMPT);
  await page.getByRole('button', { name: 'Send' }).click();

  const stopBtn = page.getByRole('button', { name: 'Stop' });
  await expect(stopBtn).toBeVisible({ timeout: 10_000 });
  await expect(stopBtn).toHaveCount(0, { timeout: 90_000 });
  await page.waitForTimeout(300);

  expect(outputValues.length).toBeGreaterThan(0);
  for (let i = 1; i < outputValues.length; i++) {
    expect(outputValues[i]).toBeGreaterThanOrEqual(outputValues[i - 1]);
  }
});

test('ThinkingBlock tok estimate is not doubled in completed message', async ({ page }) => {
  // Regression for: handleAssistant re-broadcast the full thinking text via a
  // thinking_chunk event even when handleDelta had already streamed it
  // incrementally.  applyMsg accumulated both, so the snapshot and the committed
  // UIMessage both stored thinking_text twice, doubling the char/4 tok estimate.
  // Fix: receivedThinkingDeltas flag suppresses the handleAssistant re-broadcast
  // when delta events already covered the content.
  //
  // Assertion: ThinkingBlock tok estimate <= completed output tokens * 1.5.
  // Thinking tokens are a strict subset of output tokens; the 1.5x margin
  // covers the chars/4 approximation error (~10-20%).  With the bug the estimate
  // doubled so for a thinking-heavy prompt it would easily exceed 1.5x output.
  await waitForApp(page);
  // Short reply maximises the thinking-to-output ratio, making doubling obvious.
  await page.getByPlaceholder('Ask Argus').fill('Reply with just the single word "yes".');
  await page.getByRole('button', { name: 'Send' }).click();

  const stopBtn = page.getByRole('button', { name: 'Stop' });
  await expect(stopBtn).toBeVisible({ timeout: 15_000 });
  await expect(stopBtn).toHaveCount(0, { timeout: 90_000 });

  const timer = page.locator('[class*="responseTimeSuccess"]');
  await expect(timer).toBeVisible({ timeout: 5_000 });
  const timerText = await timer.textContent() ?? '';
  const timerMatch = timerText.match(/(\d[\d\s,]*)\s+in\s*\/\s*(\d[\d\s,]*)\s+out/);

  const thinkingBlock = page.locator('[class*="thinkingBlock"]');
  if (await thinkingBlock.count() === 0) {
    // Model chose not to emit thinking - skip the ratio check.
    return;
  }

  const headerText = await thinkingBlock.first().locator('[class*="header"]').textContent() ?? '';
  const tokMatch = headerText.match(/(\d[\d.,\s]*)\s+tok/);
  if (!tokMatch || !timerMatch) return;

  const thinkTok = parseInt(tokMatch[1].replace(/[\s,.]/g, ''), 10);
  const outVal   = parseInt((timerMatch[2] ?? '').replace(/[\s,]/g, ''), 10);

  if (outVal > 0) {
    expect(thinkTok).toBeLessThanOrEqual(outVal * 1.5);
  }
});
