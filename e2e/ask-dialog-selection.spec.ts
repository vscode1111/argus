import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

const FOUR_OPTIONS_INPUT = {
  questions: [
    {
      question: 'Which approach should we use?',
      header: 'Approach',
      multiSelect: false,
      options: [
        { label: 'Option A', description: 'First approach' },
        { label: 'Option B', description: 'Second approach' },
        { label: 'Option C', description: 'Third approach' },
        { label: 'Option D', description: 'Fourth approach' },
      ],
    },
  ],
};

const MULTI_SELECT_INPUT = {
  questions: [
    {
      question: 'Which features to enable?',
      header: 'Features',
      multiSelect: true,
      options: [
        { label: 'Linting' },
        { label: 'Formatting' },
        { label: 'Type checking' },
        { label: 'Testing' },
      ],
    },
  ],
};

const MULTI_TAB_INPUT = {
  questions: [
    {
      question: 'Pick a color?',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red' },
        { label: 'Blue' },
        { label: 'Green' },
      ],
    },
    {
      question: 'Pick a size?',
      header: 'Size',
      multiSelect: false,
      options: [
        { label: 'Small' },
        { label: 'Medium' },
        { label: 'Large' },
      ],
    },
  ],
};

const TOOL_ID = 'tool-sel-1';

function captureToolAnswers(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => {
    const captured: Record<string, unknown>[] = [];
    (window as unknown as Record<string, unknown>).__capturedToolAnswers = captured;
    const orig = console.log;
    console.log = function (...args: unknown[]) {
      orig.apply(console, args);
      if (args[0] === '[-> agent]' && (args[1] as Record<string, unknown>)?.type === 'toolAnswer') {
        captured.push(JSON.parse(JSON.stringify(args[1])));
      }
    };
    return captured;
  });
}

function getCapturedAnswers(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__capturedToolAnswers as Record<string, unknown>[]
  );
}

async function setupDialog(page: Page, input: object, toolId = TOOL_ID) {
  await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub selection test' } });
  await send(page, { type: 'thinking_start' });
  await send(page, { type: 'tool_start', call: { id: toolId, name: 'AskUserQuestion', input } });
  const dialog = page.locator('[class*="askDialog"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('AskUserQuestion option selection', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
    await captureToolAnswers(page);
  });

  test('selecting third option sends correct label (not first)', async ({ page }) => {
    const dialog = await setupDialog(page, FOUR_OPTIONS_INPUT);

    const options = dialog.locator('[class*="questionOption"]:not([class*="questionOptionSelected"])');
    const allOptions = dialog.locator('[class*="questionOptionLabel"]');

    // Click the third option (index 2, "Option C")
    await allOptions.nth(2).click();

    const selected = dialog.locator('[class*="questionOptionSelected"]');
    await expect(selected).toHaveCount(1);
    await expect(selected.locator('[class*="questionOptionLabel"]')).toHaveText('Option C');

    await dialog.getByRole('button', { name: 'Submit answers' }).click();

    const answers = await getCapturedAnswers(page);
    expect(answers).toHaveLength(1);
    expect(answers[0].type).toBe('toolAnswer');
    expect(answers[0].id).toBe(TOOL_ID);
    const ansMap = answers[0].answers as Record<string, string>;
    expect(ansMap['Which approach should we use?']).toBe('Option C');
  });

  test('selecting last option sends correct label', async ({ page }) => {
    const dialog = await setupDialog(page, FOUR_OPTIONS_INPUT);

    const labels = dialog.locator('[class*="questionOptionLabel"]');
    // Click "Option D" (index 3, last non-Other option)
    await labels.nth(3).click();

    const selected = dialog.locator('[class*="questionOptionSelected"]');
    await expect(selected.locator('[class*="questionOptionLabel"]')).toHaveText('Option D');

    await dialog.getByRole('button', { name: 'Submit answers' }).click();

    const answers = await getCapturedAnswers(page);
    expect(answers).toHaveLength(1);
    const ansMap = answers[0].answers as Record<string, string>;
    expect(ansMap['Which approach should we use?']).toBe('Option D');
  });

  test('selecting first option sends first label (baseline)', async ({ page }) => {
    const dialog = await setupDialog(page, FOUR_OPTIONS_INPUT);

    const labels = dialog.locator('[class*="questionOptionLabel"]');
    await labels.nth(0).click();

    await dialog.getByRole('button', { name: 'Submit answers' }).click();

    const answers = await getCapturedAnswers(page);
    expect(answers).toHaveLength(1);
    const ansMap = answers[0].answers as Record<string, string>;
    expect(ansMap['Which approach should we use?']).toBe('Option A');
  });

  test('changing selection before submit sends final choice', async ({ page }) => {
    const dialog = await setupDialog(page, FOUR_OPTIONS_INPUT);

    const labels = dialog.locator('[class*="questionOptionLabel"]');
    // First click Option A, then change to Option C
    await labels.nth(0).click();
    await expect(dialog.locator('[class*="questionOptionSelected"] [class*="questionOptionLabel"]')).toHaveText('Option A');

    await labels.nth(2).click();
    await expect(dialog.locator('[class*="questionOptionSelected"] [class*="questionOptionLabel"]')).toHaveText('Option C');

    await dialog.getByRole('button', { name: 'Submit answers' }).click();

    const answers = await getCapturedAnswers(page);
    expect(answers).toHaveLength(1);
    const ansMap = answers[0].answers as Record<string, string>;
    expect(ansMap['Which approach should we use?']).toBe('Option C');
  });

  test('multi-select non-first options sends correct labels', async ({ page }) => {
    const dialog = await setupDialog(page, MULTI_SELECT_INPUT);

    const labels = dialog.locator('[class*="questionOptionLabel"]');
    // Select "Formatting" (index 1) and "Testing" (index 3)
    await labels.nth(1).click();
    await labels.nth(3).click();

    const selected = dialog.locator('[class*="questionOptionSelected"]');
    await expect(selected).toHaveCount(2);

    await dialog.getByRole('button', { name: 'Submit answers' }).click();

    const answers = await getCapturedAnswers(page);
    expect(answers).toHaveLength(1);
    const ansMap = answers[0].answers as Record<string, string>;
    expect(ansMap['Which features to enable?']).toBe('Formatting, Testing');
  });

  test('multi-tab: non-first selection in each tab sends correct labels', async ({ page }) => {
    const dialog = await setupDialog(page, MULTI_TAB_INPUT);

    const tabs = dialog.locator('[class*="askTabBar"] button:not([aria-label="Cancel"])');

    // Tab 1 (Color): select "Green" (index 2)
    await tabs.nth(0).click();
    const colorLabels = dialog.locator('[class*="questionOptionLabel"]');
    await colorLabels.nth(2).click();

    // Tab 2 (Size): select "Large" (index 2)
    await tabs.nth(1).click();
    const sizeLabels = dialog.locator('[class*="questionOptionLabel"]');
    await sizeLabels.nth(2).click();

    await dialog.getByRole('button', { name: 'Submit answers' }).click();

    const answers = await getCapturedAnswers(page);
    expect(answers).toHaveLength(1);
    const ansMap = answers[0].answers as Record<string, string>;
    expect(ansMap['Pick a color?']).toBe('Green');
    expect(ansMap['Pick a size?']).toBe('Large');
  });

  test('result summary matches submitted non-first option after tool_end', async ({ page }) => {
    const dialog = await setupDialog(page, FOUR_OPTIONS_INPUT);

    const labels = dialog.locator('[class*="questionOptionLabel"]');
    await labels.nth(2).click();

    await dialog.getByRole('button', { name: 'Submit answers' }).click();

    // Simulate tool_end with the answer (as the backend would send it)
    const answerResult = JSON.stringify({ answers: { 'Which approach should we use?': 'Option C' } });
    await send(page, {
      type: 'tool_end',
      call: { id: TOOL_ID, name: 'AskUserQuestion', input: FOUR_OPTIONS_INPUT, result: answerResult },
    });
    await send(page, { type: 'done' });

    const summary = page.locator('[class*="askResultSummary"]');
    await expect(summary).toContainText('"Which approach should we use?"="Option C"');

    // The selected option dot should be on Option C
    const selectedLabel = dialog.locator('[class*="questionOptionSelected"] [class*="questionOptionLabel"]');
    await expect(selectedLabel).toHaveText('Option C');
  });
});
