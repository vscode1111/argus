import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

// Verifies the assistant response arrives as multiple incremental chunks (streaming),
// not as a single block. Relies on the --include-partial-messages flag being passed
// to the Claude CLI (see src/backend/session.ts).
//
// We measure streaming at the WebSocket layer (counting `text_chunk` frames from
// the server) rather than the DOM, because React 18 batches re-renders so multiple
// rapid chunks can collapse into a single MutationObserver event.

test('long response streams as many text_chunk frames, not one block', async ({ page }) => {

  // Collect every text_chunk frame received over the WS connection to the backend.
  const textChunks: string[] = [];
  page.on('websocket', ws => {
    ws.on('framereceived', frame => {
      try {
        const payload = JSON.parse(frame.payload as string);
        if (payload?.type === 'text_chunk' && typeof payload.text === 'string') {
          textChunks.push(payload.text);
        }
      } catch {
        // non-JSON frames (ping/pong) - ignore
      }
    });
  });

  await waitForApp(page);

  const textarea = page.getByPlaceholder('Ask Argus');
  await textarea.fill(
    'Write the numbers from 1 to 200, one per line, nothing else. No code block, no commentary.'
  );
  await page.getByRole('button', { name: 'Send' }).click();

  // Wait for streaming to start, then for it to complete (Stop button disappears).
  const stopBtn = page.getByRole('button', { name: 'Stop' });
  await expect(stopBtn).toBeVisible({ timeout: 10_000 });
  await expect(stopBtn).toHaveCount(0, { timeout: 20_000 });

  // Brief settle so any trailing frames are captured.
  await page.waitForTimeout(300);

  const totalLength = textChunks.reduce((sum, c) => sum + c.length, 0);
  const maxChunkSize = textChunks.reduce((m, c) => Math.max(m, c.length), 0);

  // The response must come as multiple partial chunks, not a single block.
  // 2 is the real boundary, not an arbitrary "looks streamy" number: without the
  // flag `handleAssistant` sends exactly one text_chunk carrying the whole text
  // (the `!s.receivedDeltas` branch in cliHandler.ts), so any second frame proves
  // the deltas path ran. How many frames beyond that is the CLI's business - it
  // flushes deltas on a timer (~0.8s observed), so the count tracks generation
  // speed, which is model-owned and must not be asserted on.
  expect(textChunks.length).toBeGreaterThanOrEqual(2);

  // Sanity: the response actually has substantive content (200 numbers, ~690 chars).
  expect(totalLength).toBeGreaterThan(100);

  // Guards the degenerate case that would slip past the count check: one frame with
  // the entire response plus a tiny trailing one. Deliberately loose - how evenly
  // the CLI splits the text is not something the app controls.
  expect(maxChunkSize).toBeLessThan(totalLength * 0.9);
});
