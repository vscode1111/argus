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

  test('answer continues streaming in the same message (no done between answer and follow-up)', async ({ page }) => {
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

    // Answer result shown with formatted text, streaming still active (no done yet)
    const resultSummary = page.locator('[class*="askResultSummary"]');
    await expect(resultSummary).toBeVisible();
    await expect(resultSummary).toContainText('User has answered your questions');
    await expect(resultSummary).toContainText('"Which approach should we use?"="Option A"');
    await expect(page.getByText('Let me ask you something.')).toBeVisible();

    // Follow-up text arrives in the same streaming message (no thinking_start)
    await send(page, { type: 'text_chunk', text: 'Great, using Option A.' });
    await send(page, { type: 'done' });

    // Both texts in the same assistant message
    await expect(page.getByText('Let me ask you something.')).toBeVisible();
    await expect(page.getByText('Great, using Option A.')).toBeVisible();

    // Single success timer (one message, not two)
    const timers = page.locator('[class*="responseTimeSuccess"]');
    await expect(timers).toHaveCount(1);
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

    // Follow-up text and done
    await send(page, { type: 'text_chunk', text: 'Using Option B.' });
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

    // Follow-up continues in the same streaming message
    await send(page, { type: 'text_chunk', text: 'Proceeding with A.' });
    await send(page, { type: 'done' });

    // All messages from both exchanges are visible
    await expect(page.getByText('scub first')).toBeVisible();
    await expect(page.getByText('First reply.')).toBeVisible();
    await expect(page.getByText('scub second')).toBeVisible();
    await expect(page.getByText('Need clarification.')).toBeVisible();
    await expect(page.getByText('Proceeding with A.')).toBeVisible();

    // Two assistant timers (first reply + combined ask+follow-up)
    const timers = page.locator('[class*="responseTimeSuccess"]');
    await expect(timers).toHaveCount(2);
  });

  test('multi-question result summary shows all Q/A pairs', async ({ page }) => {
    const multiInput = {
      questions: [
        { question: 'Preferred color?', header: 'Color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] },
        { question: 'Preferred size?', header: 'Size', multiSelect: false, options: [{ label: 'Small' }, { label: 'Large' }] },
      ],
    };
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub multi-q' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'tool_start', call: { id: 'ask-multi', name: 'AskUserQuestion', input: multiInput } });

    const answerResult = JSON.stringify({ answers: { 'Preferred color?': 'Blue', 'Preferred size?': 'Small' } });
    await send(page, {
      type: 'tool_end',
      call: { id: 'ask-multi', name: 'AskUserQuestion', input: multiInput, result: answerResult },
    });
    await send(page, { type: 'done' });

    const summary = page.locator('[class*="askResultSummary"]');
    await expect(summary).toContainText('"Preferred color?"="Blue"');
    await expect(summary).toContainText('"Preferred size?"="Small"');
  });

  test('result summary not shown for cancelled dialog', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub cancel-test' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'tool_start', call: { id: ASK_TOOL_ID, name: 'AskUserQuestion', input: ASK_TOOL_INPUT } });

    await send(page, {
      type: 'tool_end',
      call: { id: ASK_TOOL_ID, name: 'AskUserQuestion', input: ASK_TOOL_INPUT, result: JSON.stringify({ cancelled: true }) },
    });
    await send(page, { type: 'done' });

    await expect(page.locator('[class*="askCancelled"]')).toBeVisible();
    await expect(page.locator('[class*="askResultSummary"]')).not.toBeVisible();
  });

  test('thinking continues after answer without losing dialog', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub think-after' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'thinking_chunk', text: 'Planning...' });
    await send(page, { type: 'tool_start', call: { id: ASK_TOOL_ID, name: 'AskUserQuestion', input: ASK_TOOL_INPUT } });

    const answerResult = JSON.stringify({ answers: { 'Which approach should we use?': 'Option A' } });
    await send(page, {
      type: 'tool_end',
      call: { id: ASK_TOOL_ID, name: 'AskUserQuestion', input: ASK_TOOL_INPUT, result: answerResult },
    });

    // New thinking arrives after answer (simulates CLI continuing)
    await send(page, { type: 'thinking_chunk', text: ' Proceeding with the answer.' });
    await send(page, { type: 'text_chunk', text: 'Here is my response after your answer.' });
    await send(page, { type: 'done' });

    // Dialog with result summary preserved
    const summary = page.locator('[class*="askResultSummary"]');
    await expect(summary).toBeVisible();

    // Follow-up text visible
    await expect(page.getByText('Here is my response after your answer.')).toBeVisible();

    // Single message (not split by thinking)
    const timers = page.locator('[class*="responseTimeSuccess"]');
    await expect(timers).toHaveCount(1);
  });
});
