import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

declare global {
  interface Window { __soundPlays?: number }
}

function send(page: Page, data: object) {
  // Dispatch a synthetic extension message, then flush two RAFs so React commits the
  // update (and any completion effect) before resolving.
  return page.evaluate(
    (d) =>
      new Promise<void>((resolve) => {
        window.dispatchEvent(new MessageEvent('message', { data: d }));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
    data
  );
}

const soundPlays = (page: Page) => page.evaluate(() => window.__soundPlays ?? 0);

const note = (page: Page) => page.getByTestId('background-tasks-note');

async function startBgTask(page: Page, toolId: string, description: string, command: string) {
  await send(page, { type: 'tool_start', call: { id: toolId, name: 'Bash', input: { description, command } } });
  await send(page, { type: 'tool_end', call: { id: toolId, name: 'Bash', input: { description, command }, result: `Command running in background with ID: bg-${toolId}. Output is being written to: /tmp/tasks/bg-${toolId}.output` } });
}

async function completeBgTask(page: Page, toolId: string, summary: string, output?: string) {
  const result = output ? `${summary}\n\nOutput:\n${output}` : summary;
  await send(page, { type: 'tool_end', call: { id: toolId, name: 'Bash', input: {}, result } });
}

test.describe('background tasks', () => {
  test.beforeEach(async ({ page }) => {
    // playCompletionSound() constructs one AudioContext per beep, so counting
    // constructions tells us whether the sound fired.
    await page.addInitScript(() => {
      window.__soundPlays = 0;
      const Orig = window.AudioContext
        || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Orig) return;
      function Spy(this: unknown) {
        window.__soundPlays = (window.__soundPlays ?? 0) + 1;
        return new Orig();
      }
      Spy.prototype = Orig.prototype;
      window.AudioContext = Spy as unknown as typeof AudioContext;
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext =
        Spy as unknown as typeof AudioContext;
    });
    await waitForApp(page);
  });

  // The regression: a turn that spawns a background task used to keep a synthetic
  // streaming state alive, so the app claimed to be working until some *later* turn
  // ended. A task that never ends (a browser started for CDP, a watcher) therefore
  // left the spinner running forever with nothing able to clear it.
  test('a turn with a pending task finishes instead of staying live', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg task' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'Running in background.' });
    await startBgTask(page, 't1', 'Sleep 5s', 'sleep 5 && echo done');
    await send(page, { type: 'done', pendingBackgroundTasks: 1 });

    // Idle: the Stop button only exists while the app believes a turn is in flight.
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    // No spinner anywhere: no streaming message, no "working" indicator.
    await expect(page.locator('[class*="streaming"]')).toHaveCount(0);
    await expect(page.locator('[class*="working"]')).toHaveCount(0);
    // The turn is reported as finished, with its own duration.
    await expect(page.locator('[class*="responseTimeSuccess"]')).toBeVisible();
  });

  // The turn ending is what fires the completion sound and the OS notification, so
  // this is the user-visible half of the same bug: both were silently suppressed for
  // every turn that left a background task behind.
  test('completion sound fires even though a task is still running', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'scub-bg-sound' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Sleep 5s', 'sleep 5');
    await send(page, { type: 'done', pendingBackgroundTasks: 1 });

    await expect.poll(() => soundPlays(page)).toBeGreaterThan(0);
  });

  test('single pending task: note without a counter', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg task' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Sleep 5s', 'sleep 5 && echo done');
    await send(page, { type: 'done', pendingBackgroundTasks: 1 });

    await expect(note(page)).toBeVisible();
    await expect(note(page)).toContainText('1 background task still running');
    // No counter for a single task
    await expect(note(page)).not.toContainText(' of ');
  });

  test('note is removed once the task reports back', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg task' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Sleep 5s', 'sleep 5');
    await send(page, { type: 'done', pendingBackgroundTasks: 1 });

    await expect(note(page)).toBeVisible();

    // Simulate task completion: the CLI's own task-notification turn
    await completeBgTask(page, 't1', 'Background command "Sleep 5s" completed (exit code 0)', 'done');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Task completed.' });
    await send(page, { type: 'done' });

    await expect(note(page)).toHaveCount(0);
  });

  test('multiple tasks: note says how many are still running', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run 3 tasks' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 10');
    await startBgTask(page, 't2', 'Task 2', 'sleep 20');
    await startBgTask(page, 't3', 'Task 3', 'sleep 30');
    await send(page, { type: 'done', pendingBackgroundTasks: 3 });

    // Pending only, never "3 of N". The denominator used to count every task_started
    // since the last per-send counter reset, so it reported totals from turns the
    // message had nothing to do with ("2 of 9" on a turn that launched two).
    await expect(note(page)).toContainText('3 background tasks still running');
    await expect(note(page)).not.toContainText(' of ');
  });

  test('the running count drops as tasks complete', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run 3 tasks' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 10');
    await startBgTask(page, 't2', 'Task 2', 'sleep 20');
    await startBgTask(page, 't3', 'Task 3', 'sleep 30');
    await send(page, { type: 'done', pendingBackgroundTasks: 3 });

    // Task 1 completes
    await completeBgTask(page, 't1', 'completed (exit code 0)');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Task 1 done.' });
    await send(page, { type: 'done', pendingBackgroundTasks: 2 });

    await expect(note(page)).toContainText('2 background tasks still running');

    // Task 2 completes
    await completeBgTask(page, 't2', 'completed (exit code 0)');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Task 2 done.' });
    await send(page, { type: 'done', pendingBackgroundTasks: 1 });

    await expect(note(page)).toContainText('1 background task still running');

    // Task 3 completes (last one)
    await completeBgTask(page, 't3', 'completed (exit code 0)');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'All done.' });
    await send(page, { type: 'done' });

    await expect(note(page)).toHaveCount(0);
  });

  test('only the latest message carries the note', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run 2 tasks' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 10');
    await startBgTask(page, 't2', 'Task 2', 'sleep 20');
    await send(page, { type: 'done', pendingBackgroundTasks: 2 });

    // Task 1 completes
    await completeBgTask(page, 't1', 'completed');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Task 1 done.' });
    await send(page, { type: 'done', pendingBackgroundTasks: 1 });

    await expect(note(page)).toHaveCount(1);
  });

  test('a turn that leaves tasks behind still shows its own success timer', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 10');
    await send(page, { type: 'done', pendingBackgroundTasks: 1 });

    const timer = page.locator('[class*="responseTimeSuccess"]');
    await expect(timer).toBeVisible();
    await expect(timer).toContainText('s');
  });

  test('final message shows timer after all tasks complete', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 5');
    await send(page, { type: 'done', pendingBackgroundTasks: 1 });

    await completeBgTask(page, 't1', 'completed');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Done.' });
    await send(page, { type: 'done' });

    const timer = page.locator('[class*="responseTimeSuccess"]');
    await expect(timer).toHaveCount(2);
  });

  test('Out link pulses green while task is running', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Sleep 5s', 'sleep 5');
    await send(page, { type: 'done', pendingBackgroundTasks: 1 });

    const outLink = page.locator('a[class*="toolOutLink"]');
    await expect(outLink).toBeVisible();
    await expect(outLink).toHaveClass(/toolOutLinkRunning/);
  });

  test('Out link stops pulsing after task completes', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Sleep 5s', 'sleep 5');
    await send(page, { type: 'done', pendingBackgroundTasks: 1 });

    const outLink = page.locator('a[class*="toolOutLink"]');
    await expect(outLink).toHaveClass(/toolOutLinkRunning/);

    // Task completes - tool_end updates result
    await completeBgTask(page, 't1', 'Background command completed (exit code 0)', 'scub-output');
    await expect(outLink).not.toHaveClass(/toolOutLinkRunning/);
  });

  test('tool result updated with output on task completion', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Sleep 5s', 'sleep 5');
    await send(page, { type: 'done', pendingBackgroundTasks: 1 });

    // Complete with output
    await completeBgTask(page, 't1', 'Background command completed (exit code 0)', 'scub-test-result');

    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Done.' });
    await send(page, { type: 'done' });

    // Click Out link to verify the content
    const outLink = page.locator('a[class*="toolOutLink"]');
    await outLink.click();

    // FileViewerModal should show both summary and output
    const modal = page.locator('[class*="modal"]');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Background command completed (exit code 0)');
    await expect(modal).toContainText('Output:');
    await expect(modal).toContainText('scub-test-result');
  });

  test('counter resets between separate user requests', async ({ page }) => {
    // First request: 1 bg task
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'first' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task A', 'sleep 5');
    await send(page, { type: 'done', pendingBackgroundTasks: 1 });

    await completeBgTask(page, 't1', 'completed');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'First done.' });
    await send(page, { type: 'done' });

    // Second request: 3 bg tasks
    await send(page, { type: 'message', message: { id: '2', role: 'user', content: 'second' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't2', 'Task B', 'sleep 10');
    await startBgTask(page, 't3', 'Task C', 'sleep 20');
    await startBgTask(page, 't4', 'Task D', 'sleep 30');
    await send(page, { type: 'done', pendingBackgroundTasks: 3 });

    // The note reports what is pending, not a running total across requests: 3, not 4.
    await expect(note(page)).toContainText('3 background tasks still running');

    // After one completes
    await completeBgTask(page, 't2', 'completed');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Task B done.' });
    await send(page, { type: 'done', pendingBackgroundTasks: 2 });

    await expect(note(page)).toContainText('2 background tasks still running');
  });

  test('multiple Out links: completed ones stop pulsing, running ones keep pulsing', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run 2 tasks' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 10');
    await startBgTask(page, 't2', 'Task 2', 'sleep 20');
    await send(page, { type: 'done', pendingBackgroundTasks: 2 });

    // Both Out links should pulse
    const outLinks = page.locator('a[class*="toolOutLink"]');
    await expect(outLinks).toHaveCount(2);
    await expect(outLinks.nth(0)).toHaveClass(/toolOutLinkRunning/);
    await expect(outLinks.nth(1)).toHaveClass(/toolOutLinkRunning/);

    // Task 1 completes
    await completeBgTask(page, 't1', 'completed');

    // First stops pulsing, second keeps pulsing
    await expect(outLinks.nth(0)).not.toHaveClass(/toolOutLinkRunning/);
    await expect(outLinks.nth(1)).toHaveClass(/toolOutLinkRunning/);
  });

  test('a superseded message keeps its timer and drops the note', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run 2 tasks' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 10');
    await startBgTask(page, 't2', 'Task 2', 'sleep 20');
    await send(page, { type: 'done', pendingBackgroundTasks: 2 });

    // Task 1 completes: the first message becomes background_done, the new one carries the note
    await completeBgTask(page, 't1', 'completed');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Task 1 done.' });
    await send(page, { type: 'done', pendingBackgroundTasks: 1 });

    const firstMessage = page.locator('[class*="assistant"]').first();
    await expect(firstMessage.getByTestId('background-tasks-note')).toHaveCount(0);
    // It is an ordinary finished turn now, so it keeps its duration like any other.
    await expect(firstMessage.locator('[class*="responseTime"]')).toHaveCount(1);
  });
});
