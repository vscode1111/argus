import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

const ASK_TOOL_INPUT = {
  questions: [
    {
      question: 'Which approach should we use?',
      header: 'Approach',
      multiSelect: false,
      options: [
        { label: 'Option A', description: 'First approach' },
        { label: 'Option B', description: 'Second approach' },
      ],
    },
  ],
};

const ASK_TOOL_ID = 'tool-ask-1';

test.describe('AskUserQuestion resume', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('answer commits original turn and follow-up creates second message', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub question' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'Let me ask you something.' });
    await send(page, { type: 'tool_start', call: { id: ASK_TOOL_ID, name: 'AskUserQuestion', input: ASK_TOOL_INPUT } });

    const dialog = page.locator('[class*="askDialog"]');
    await expect(dialog).toBeVisible();

    // Simulate answer arriving via tool_end
    const answerResult = JSON.stringify({ answers: { 'Which approach should we use?': 'Option A' } });
    await send(page, {
      type: 'tool_end',
      call: { id: ASK_TOOL_ID, name: 'AskUserQuestion', input: ASK_TOOL_INPUT, result: answerResult },
    });

    // done commits the original turn as a completed message
    await send(page, { type: 'done' });

    // Original turn should be committed with the answer
    const resultSummary = page.locator('[class*="askResultSummary"]');
    await expect(resultSummary).toBeVisible();
    await expect(page.getByText('Let me ask you something.')).toBeVisible();

    // First message should have a success timer
    const timers = page.locator('[class*="responseTimeSuccess"]');
    await expect(timers.first()).toBeVisible();

    // Follow-up starts
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'Great, using Option A.' });
    await send(page, { type: 'done' });

    // Both responses visible
    await expect(page.getByText('Let me ask you something.')).toBeVisible();
    await expect(page.getByText('Great, using Option A.')).toBeVisible();

    // Two success timers (one per assistant message)
    await expect(timers).toHaveCount(2);
  });

  test('cancelled dialog sends done without follow-up', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub question' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'tool_start', call: { id: ASK_TOOL_ID, name: 'AskUserQuestion', input: ASK_TOOL_INPUT } });

    const dialog = page.locator('[class*="askDialog"]');
    await expect(dialog).toBeVisible();

    // Cancel: empty answers
    const cancelResult = JSON.stringify({ answers: {} });
    await send(page, {
      type: 'tool_end',
      call: { id: ASK_TOOL_ID, name: 'AskUserQuestion', input: ASK_TOOL_INPUT, result: cancelResult },
    });
    await send(page, { type: 'done' });

    // One completed message, no follow-up
    const timers = page.locator('[class*="responseTime"]');
    await expect(timers).toHaveCount(1);

    // No streaming indicator
    const streamingMsg = page.locator('[class*="streamingMessage"]');
    await expect(streamingMsg).not.toBeVisible();
  });

  test('original turn preserves thinking, text, and tool blocks after answer', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub question' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'thinking_chunk', text: 'Planning my response...' });
    await send(page, { type: 'text_chunk', text: 'Before asking.' });
    await send(page, { type: 'tool_start', call: { id: ASK_TOOL_ID, name: 'AskUserQuestion', input: ASK_TOOL_INPUT } });

    const answerResult = JSON.stringify({ answers: { 'Which approach should we use?': 'Option B' } });
    await send(page, {
      type: 'tool_end',
      call: { id: ASK_TOOL_ID, name: 'AskUserQuestion', input: ASK_TOOL_INPUT, result: answerResult },
    });
    await send(page, { type: 'done' });

    // Text from original turn preserved
    await expect(page.getByText('Before asking.')).toBeVisible();

    // AskUserQuestion shows the selected answer
    const dialog = page.locator('[class*="askDialog"]');
    await expect(dialog).toBeVisible();
    const selectedOption = dialog.locator('[class*="questionOptionSelected"]');
    await expect(selectedOption).toBeVisible();
    await expect(selectedOption.locator('[class*="questionOptionLabel"]')).toHaveText('Option B');

    // Thinking block accessible (expandable)
    const thinkingBlock = page.locator('[class*="thinkingBlock"]');
    await expect(thinkingBlock).toBeVisible();
  });

  test('follow-up after answer does not lose previous messages', async ({ page }) => {
    // First exchange
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub first' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'First reply.' });
    await send(page, { type: 'done' });

    // Second exchange with AskUserQuestion
    await send(page, { type: 'message', message: { id: '2', role: 'user', content: 'scub second' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'Need clarification.' });
    await send(page, { type: 'tool_start', call: { id: ASK_TOOL_ID, name: 'AskUserQuestion', input: ASK_TOOL_INPUT } });

    const answerResult = JSON.stringify({ answers: { 'Which approach should we use?': 'Option A' } });
    await send(page, {
      type: 'tool_end',
      call: { id: ASK_TOOL_ID, name: 'AskUserQuestion', input: ASK_TOOL_INPUT, result: answerResult },
    });
    await send(page, { type: 'done' });

    // Follow-up
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'Proceeding with A.' });
    await send(page, { type: 'done' });

    // All messages from both exchanges are visible
    await expect(page.getByText('scub first')).toBeVisible();
    await expect(page.getByText('First reply.')).toBeVisible();
    await expect(page.getByText('scub second')).toBeVisible();
    await expect(page.getByText('Need clarification.')).toBeVisible();
    await expect(page.getByText('Proceeding with A.')).toBeVisible();

    // Three assistant timers (first reply + ask turn + follow-up)
    const timers = page.locator('[class*="responseTimeSuccess"]');
    await expect(timers).toHaveCount(3);
  });
});
