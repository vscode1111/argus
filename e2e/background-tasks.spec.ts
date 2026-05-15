import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './helpers';

function send(page: Page, data: object) {
  return page.evaluate((d) => {
    window.dispatchEvent(new MessageEvent('message', { data: d }));
  }, data);
}

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
    await waitForApp(page);
  });

  test('single background task shows waiting indicator without counter', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg task' } });
    await send(page, { type: 'thinking_start' });
    await send(page, { type: 'text_chunk', text: 'Running in background.' });
    await startBgTask(page, 't1', 'Sleep 5s', 'sleep 5 && echo done');
    await send(page, { type: 'done', pendingBackgroundTasks: 1, totalBackgroundTasks: 1 });

    const indicator = page.locator('[class*="working"]');
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText('Waiting background task');
    // No counter for single task
    await expect(indicator).not.toContainText('(');
  });

  test('single bg task: waiting indicator removed after completion', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg task' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Sleep 5s', 'sleep 5');
    await send(page, { type: 'done', pendingBackgroundTasks: 1, totalBackgroundTasks: 1 });

    const indicator = page.locator('[class*="working"]');
    await expect(indicator).toBeVisible();

    // Simulate task completion: autonomous turn
    await completeBgTask(page, 't1', 'Background command "Sleep 5s" completed (exit code 0)', 'done');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Task completed.' });
    await send(page, { type: 'done' });

    await expect(indicator).not.toBeVisible();
  });

  test('multiple bg tasks show plural label with counter', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run 3 tasks' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 10');
    await startBgTask(page, 't2', 'Task 2', 'sleep 20');
    await startBgTask(page, 't3', 'Task 3', 'sleep 30');
    await send(page, { type: 'done', pendingBackgroundTasks: 3, totalBackgroundTasks: 3 });

    const indicator = page.locator('[class*="working"]');
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText('Waiting background tasks (0/3)');
  });

  test('counter updates as tasks complete', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run 3 tasks' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 10');
    await startBgTask(page, 't2', 'Task 2', 'sleep 20');
    await startBgTask(page, 't3', 'Task 3', 'sleep 30');
    await send(page, { type: 'done', pendingBackgroundTasks: 3, totalBackgroundTasks: 3 });

    // Task 1 completes
    await completeBgTask(page, 't1', 'completed (exit code 0)');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Task 1 done.' });
    await send(page, { type: 'done', pendingBackgroundTasks: 2, totalBackgroundTasks: 3 });

    let indicator = page.locator('[class*="working"]');
    await expect(indicator).toContainText('Waiting background tasks (1/3)');

    // Task 2 completes
    await completeBgTask(page, 't2', 'completed (exit code 0)');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Task 2 done.' });
    await send(page, { type: 'done', pendingBackgroundTasks: 1, totalBackgroundTasks: 3 });

    indicator = page.locator('[class*="working"]');
    await expect(indicator).toContainText('Waiting background tasks (2/3)');

    // Task 3 completes (last one)
    await completeBgTask(page, 't3', 'completed (exit code 0)');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'All done.' });
    await send(page, { type: 'done' });

    await expect(indicator).not.toBeVisible();
  });

  test('only latest message shows waiting indicator', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run 2 tasks' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 10');
    await startBgTask(page, 't2', 'Task 2', 'sleep 20');
    await send(page, { type: 'done', pendingBackgroundTasks: 2, totalBackgroundTasks: 2 });

    // Task 1 completes
    await completeBgTask(page, 't1', 'completed');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Task 1 done.' });
    await send(page, { type: 'done', pendingBackgroundTasks: 1, totalBackgroundTasks: 2 });

    // Only one indicator should be visible (on the latest message)
    const indicators = page.locator('[class*="working"]');
    await expect(indicators).toHaveCount(1);
  });

  test('background_waiting shows live elapsed timer, not static response time', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 10');
    await send(page, { type: 'done', pendingBackgroundTasks: 1, totalBackgroundTasks: 1 });

    const timer = page.locator('[class*="responseTime"]');
    await expect(timer).toBeVisible();
    // No color-coded class (not success/error/stopped), just base responseTime
    await expect(timer).not.toHaveClass(/responseTimeSuccess/);
  });

  test('background_waiting indicator shows elapsed timer on separate line', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 10');
    await send(page, { type: 'done', pendingBackgroundTasks: 1, totalBackgroundTasks: 1 });

    const timer = page.locator('[class*="responseTime"]');
    await expect(timer).toBeVisible();
    await expect(timer).toContainText('s');
  });

  test('final message shows timer after all tasks complete', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 5');
    await send(page, { type: 'done', pendingBackgroundTasks: 1, totalBackgroundTasks: 1 });

    await completeBgTask(page, 't1', 'completed');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Done.' });
    await send(page, { type: 'done' });

    const timer = page.locator('[class*="responseTimeSuccess"]');
    await expect(timer).toBeVisible();
  });

  test('Out link pulses green while task is running', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Sleep 5s', 'sleep 5');
    await send(page, { type: 'done', pendingBackgroundTasks: 1, totalBackgroundTasks: 1 });

    const outLink = page.locator('a[class*="toolOutLink"]');
    await expect(outLink).toBeVisible();
    await expect(outLink).toHaveClass(/toolOutLinkRunning/);
  });

  test('Out link stops pulsing after task completes', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Sleep 5s', 'sleep 5');
    await send(page, { type: 'done', pendingBackgroundTasks: 1, totalBackgroundTasks: 1 });

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
    await send(page, { type: 'done', pendingBackgroundTasks: 1, totalBackgroundTasks: 1 });

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

  test('StreamingMessage hidden during backgroundWaiting', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run bg' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 5');
    await send(page, { type: 'done', pendingBackgroundTasks: 1, totalBackgroundTasks: 1 });

    // StreamingMessage should not be visible (it returns null for backgroundWaiting)
    const streaming = page.locator('[class*="streaming"]');
    await expect(streaming).toHaveCount(0);
  });

  test('counter resets between separate user requests', async ({ page }) => {
    // First request: 1 bg task
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'first' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task A', 'sleep 5');
    await send(page, { type: 'done', pendingBackgroundTasks: 1, totalBackgroundTasks: 1 });

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
    await send(page, { type: 'done', pendingBackgroundTasks: 3, totalBackgroundTasks: 3 });

    // Counter should show 0/3 (not 0/4 or 1/4)
    const indicator = page.locator('[class*="working"]');
    await expect(indicator).toContainText('(0/3)');

    // After one completes: 1/3
    await completeBgTask(page, 't2', 'completed');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Task B done.' });
    await send(page, { type: 'done', pendingBackgroundTasks: 2, totalBackgroundTasks: 3 });

    const latestIndicator = page.locator('[class*="working"]');
    await expect(latestIndicator).toContainText('(1/3)');
  });

  test('multiple Out links: completed ones stop pulsing, running ones keep pulsing', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run 2 tasks' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 10');
    await startBgTask(page, 't2', 'Task 2', 'sleep 20');
    await send(page, { type: 'done', pendingBackgroundTasks: 2, totalBackgroundTasks: 2 });

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

  test('background_done messages do not show waiting indicator or timer', async ({ page }) => {
    await send(page, { type: 'message', message: { id: '1', role: 'user', content: 'run 2 tasks' } });
    await send(page, { type: 'thinking_start' });
    await startBgTask(page, 't1', 'Task 1', 'sleep 10');
    await startBgTask(page, 't2', 'Task 2', 'sleep 20');
    await send(page, { type: 'done', pendingBackgroundTasks: 2, totalBackgroundTasks: 2 });

    // Task 1 completes
    await completeBgTask(page, 't1', 'completed');
    await send(page, { type: 'thinking_start', reused: true });
    await send(page, { type: 'text_chunk', text: 'Task 1 done.' });
    await send(page, { type: 'done', pendingBackgroundTasks: 1, totalBackgroundTasks: 2 });

    // The first message (now background_done) should have no indicator and no timer
    const assistantMessages = page.locator('[class*="assistant"]');
    const firstMessage = assistantMessages.first();
    await expect(firstMessage.locator('[class*="working"]')).toHaveCount(0);
    await expect(firstMessage.locator('[class*="responseTime"]')).toHaveCount(0);
  });
});
