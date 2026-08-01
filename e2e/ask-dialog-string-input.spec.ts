import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

// Some transcripts record the AskUserQuestion input with `questions` as a JSON
// string instead of an array. ToolCall must not assume it is already parsed -
// a throw there unmounts the whole React tree and the page goes blank.
const QUESTIONS = [
  {
    question: 'Which approach should we use?',
    header: 'Approach',
    multiSelect: false,
    options: [
      { label: 'Option A', description: 'First approach' },
      { label: 'Option B', description: 'Second approach' },
    ],
  },
];

const STRING_INPUT = { questions: JSON.stringify(QUESTIONS) };

test.describe('AskUserQuestion with stringified questions', () => {
  test('renders the dialog instead of crashing the app', async ({ page }) => {
    const crashes: string[] = [];
    page.on('pageerror', (err) => crashes.push(err.message));

    await waitForApp(page);

    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub string input test' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'tool_start', call: { id: 'tool-str-1', name: 'AskUserQuestion', input: STRING_INPUT } });

    const dialog = page.locator('[class*="askDialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[class*="questionOptionLabel"]').first()).toHaveText('Option A');

    // The app must still be mounted (a ToolCall throw blanks the whole tree).
    await expect(page.getByText('scub string input test')).toBeVisible();
    expect(crashes).toEqual([]);
  });
});
