import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('session activity shows changed lines, subagent status, and a child transcript', async ({ page }) => {
  await waitForApp(page);
  const suppressed: string[] = [];
  page.on('console', message => {
    const text = message.text();
    if (text.includes('[mock] suppressed')) suppressed.push(text.replace('[mock] suppressed ', '').trim());
  });
  await page.evaluate(() => {
    const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    send({ type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true });
    send({ type: 'sessionLoaded', id: 'codex:scub-parent', messages: [
      { id: 'scub-reply', role: 'assistant', content: '', blocks: [
        { type: 'tool', call: { id: 'scub-change', name: 'fileChange', kind: 'fileChange', input: { changes: [
          { path: 'D:/scub/one.ts', diff: '@@ -1 +1,3 @@\n-scub-old\n+scub-new\n+scub-second\n+scub-third\n' },
        ] } } },
        { type: 'tool', call: { id: 'scub-agent-start', name: 'subAgentActivity', kind: 'subAgentActivity', input: { agentThreadId: 'scub-child-active', agentPath: '/root/scub_active', activity: 'started' }, result: 'started' } },
        { type: 'tool', call: { id: 'scub-agent-done-start', name: 'subAgentActivity', kind: 'subAgentActivity', input: { agentThreadId: 'scub-child-done', agentPath: '/root/scub_done', activity: 'started' }, result: 'started' } },
        { type: 'tool', call: { id: 'scub-agent-done', name: 'subAgentActivity', kind: 'subAgentActivity', input: { agentThreadId: 'scub-child-done', agentPath: '/root/scub_done', activity: 'completed' }, result: 'completed' } },
      ] },
    ] });
  });
  await page.getByRole('button', { name: 'Session activity' }).click();
  const dialog = page.getByRole('dialog', { name: 'Session activity' });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'workspaceChanges', added: 12, removed: 4, isIncomplete: false } })));
  await expect(dialog).toContainText('Workspace changes');
  await expect(dialog).toContainText('+12');
  await expect(dialog).toContainText('-4');
  await expect(dialog).toContainText('Subagents · 2');
  const rows = dialog.getByRole('button', { name: /Scub (active|done)/ });
  await expect(rows).toHaveText([/Scub active.*Active/, /Scub done.*Completed/]);
  await dialog.getByRole('button', { name: /Scub active/ }).click();
  await expect.poll(() => suppressed).toContain('getSubagentThread');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'subagentThread', parentId: 'codex:scub-parent', childId: 'scub-child-active',
    messages: [{ id: 'scub-child-reply', role: 'assistant', content: 'scub-child-result' }],
  } })));
  await expect(dialog).toContainText('scub-child-result');
  await expect(dialog.locator('[data-dialog-drag-handle]').getByRole('button', { name: 'All activity' })).toBeVisible();
  await dialog.getByRole('button', { name: 'All activity' }).click();
  await expect(dialog).toContainText('Subagents · 2');
});

test('activity list and transcript keep separate positions and sizes', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    send({ type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true });
    send({ type: 'sessionLoaded', id: 'codex:scub-parent', messages: [{ id: 'scub-reply', role: 'assistant', content: '', blocks: [
      { type: 'tool', call: { id: 'scub-agent-start', name: 'subAgentActivity', kind: 'subAgentActivity',
        input: { agentThreadId: 'scub-child', agentPath: '/root/scub_child', activity: 'started' }, result: 'started' } },
    ] }] });
  });
  await page.getByRole('button', { name: 'Session activity' }).click();
  const dialog = page.getByRole('dialog', { name: 'Session activity' });
  const changeGeometry = async (width: number, height: number, dx: number, dy: number) => {
    const handle = dialog.locator('[data-dialog-drag-handle]');
    const start = await handle.boundingBox();
    if (!start) throw new Error('Missing dialog header');
    const x = start.x + start.width / 2;
    const y = start.y + start.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 5 });
    await page.mouse.up();
    await dialog.evaluate((element, [w, h]) => {
      const box = element.getBoundingClientRect();
      element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: box.right - 4, clientY: box.bottom - 4 }));
      (element as HTMLElement).style.width = `${w}px`;
      (element as HTMLElement).style.height = `${h}px`;
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    }, [width, height] as [number, number]);
    const changed = await dialog.boundingBox();
    if (!changed) throw new Error('Missing resized dialog');
    return changed;
  };
  const expectGeometry = async (saved: { x: number; y: number; width: number; height: number }) => {
    const current = await dialog.boundingBox();
    if (!current) throw new Error('Missing reopened dialog');
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(current[key] - saved[key]), key).toBeLessThan(3);
    }
  };
  const listGeometry = await changeGeometry(540, 360, -70, 35);
  await dialog.getByRole('button', { name: /Scub child/ }).click();
  const transcriptGeometry = await changeGeometry(570, 460, 50, 20);
  await dialog.getByRole('button', { name: 'All activity' }).click();
  await expectGeometry(listGeometry);
  await dialog.getByRole('button', { name: /Scub child/ }).click();
  await expectGeometry(transcriptGeometry);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Session activity' }).click();
  await expectGeometry(listGeometry);
  await dialog.getByRole('button', { name: /Scub child/ }).click();
  await expectGeometry(transcriptGeometry);
  await waitForApp(page);
  await page.evaluate(() => {
    const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    send({ type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true });
    send({ type: 'sessionLoaded', id: 'codex:scub-parent', messages: [{ id: 'scub-reply', role: 'assistant', content: '', blocks: [
      { type: 'tool', call: { id: 'scub-agent-start', name: 'subAgentActivity', kind: 'subAgentActivity',
        input: { agentThreadId: 'scub-child', agentPath: '/root/scub_child', activity: 'started' }, result: 'started' } },
    ] }] });
  });
  await page.getByRole('button', { name: 'Session activity' }).click();
  await expectGeometry(listGeometry);
  await dialog.getByRole('button', { name: /Scub child/ }).click();
  await expectGeometry(transcriptGeometry);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Reset dialog layout' }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('button', { name: 'Session activity' }).click();
  const defaultList = await dialog.boundingBox();
  if (!defaultList) throw new Error('Missing reset activity list');
  expect(defaultList.width).toBe(620);
  expect(Math.abs(defaultList.x - (page.viewportSize()!.width - defaultList.width) / 2)).toBeLessThan(3);
  await dialog.getByRole('button', { name: /Scub child/ }).click();
  const defaultTranscript = await dialog.boundingBox();
  if (!defaultTranscript) throw new Error('Missing reset transcript');
  expect(defaultTranscript.width).toBe(620);
  expect(Math.abs(defaultTranscript.height - (page.viewportSize()!.height - 64))).toBeLessThan(3);
  await page.setViewportSize({ width: 300, height: 250 });
  await expect.poll(async () => {
    const box = await dialog.boundingBox();
    return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 301 && box.y + box.height <= 251;
  }).toBe(true);
  await dialog.getByRole('button', { name: 'All activity' }).click();
  await dialog.getByRole('button', { name: /Scub child/ }).click();
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
});

test('an empty session explains that there are no subagents', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true } })));
  await page.getByRole('button', { name: 'Session activity' }).click();
  const dialog = page.getByRole('dialog', { name: 'Session activity' });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'workspaceChanges', added: 0, removed: 0, isIncomplete: false } })));
  await expect(dialog).toContainText('+0');
  await expect(dialog).toContainText('-0');
  await expect(dialog).toContainText('No subagents');
});

test('session activity shows pending workspace and subagent requests', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    send({ type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true });
    send({ type: 'sessionLoaded', id: 'codex:scub-parent', messages: [] });
  });
  await page.getByRole('button', { name: 'Session activity' }).click();
  const dialog = page.getByRole('dialog', { name: 'Session activity' });
  await expect(dialog.getByRole('status', { name: 'Loading workspace changes' })).toBeVisible();
  await expect(dialog.getByRole('status', { name: 'Loading subagents' })).toBeVisible();
  await expect(dialog).not.toContainText('No subagents');
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'workspaceChanges', added: 7, removed: 2, isIncomplete: false } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'sessionActivity', parentId: 'codex:scub-parent', agents: [] } }));
  });
  await expect(dialog.getByRole('status', { name: 'Loading workspace changes' })).toHaveCount(0);
  await expect(dialog.getByRole('status', { name: 'Loading subagents' })).toHaveCount(0);
  await expect(dialog).toContainText('+7');
  await expect(dialog).toContainText('No subagents');
});

test('a newly started conversation can open its child transcript before the turn ends', async ({ page }) => {
  await waitForApp(page);
  const sent: string[] = [];
  page.on('console', message => {
    if (message.text().includes('[mock] suppressed')) sent.push(message.text());
  });
  await page.evaluate(() => {
    const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    send({ type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true });
    send({ type: 'thinking_start' });
    send({ type: 'sessionId', id: 'codex:scub-live-parent' });
    send({ type: 'tool_start', call: { id: 'scub-agent-start', name: 'subAgentActivity', kind: 'subAgentActivity',
      input: { agentThreadId: 'scub-live-child', agentPath: '/root/scub_child', activity: 'started' }, result: 'started' } });
  });
  await page.getByRole('button', { name: 'Session activity' }).click();
  await page.getByRole('dialog', { name: 'Session activity' }).getByRole('button', { name: /Scub child/ }).click();
  await expect.poll(() => sent.some(value => value.includes('getSubagentThread'))).toBe(true);
});

test('a refreshed session moves a completed child out of Active', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    send({ type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true });
    send({ type: 'sessionLoaded', id: 'codex:scub-parent', messages: [{ id: 'scub-reply', role: 'assistant', content: '', blocks: [
      { type: 'tool', call: { id: 'scub-agent-start', name: 'subAgentActivity', kind: 'subAgentActivity',
        input: { agentThreadId: 'scub-child', agentPath: '/root/scub_child', activity: 'started' }, result: 'started' } },
    ] }] });
  });
  await page.getByRole('button', { name: 'Session activity' }).click();
  const dialog = page.getByRole('dialog', { name: 'Session activity' });
  await expect(dialog.getByRole('button', { name: /Scub child/ })).toContainText('Active');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'sessionActivity', parentId: 'codex:scub-parent', agents: [{ id: 'scub-child', path: '/root/scub_child', active: false }],
  } })));
  await expect(dialog.getByRole('button', { name: /Scub child/ })).toContainText('Completed');
  await expect(dialog).toContainText('Subagents · 1');
});

test('an unanswered activity request explains that the server is outdated', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    send({ type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true });
    send({ type: 'sessionLoaded', id: 'codex:scub-parent', messages: [] });
  });
  await page.getByRole('button', { name: 'Session activity' }).click();
  await expect(page.getByRole('dialog', { name: 'Session activity' })).toContainText('Activity unavailable', { timeout: 7000 });
});

test('an unanswered child request stops showing the loading spinner', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    send({ type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true });
    send({ type: 'sessionLoaded', id: 'codex:scub-parent', messages: [{ id: 'scub-reply', role: 'assistant', content: '', blocks: [
      { type: 'tool', call: { id: 'scub-agent-start', name: 'subAgentActivity', kind: 'subAgentActivity',
        input: { agentThreadId: 'scub-child', agentPath: '/root/scub_child', activity: 'started' }, result: 'started' } },
    ] }] });
  });
  await page.getByRole('button', { name: 'Session activity' }).click();
  const dialog = page.getByRole('dialog', { name: 'Session activity' });
  await dialog.getByRole('button', { name: /Scub child/ }).click();
  await expect(dialog).toContainText('Transcript unavailable', { timeout: 7000 });
  await expect(dialog).not.toContainText('Loading transcript…');
});

test('Escape closes child output preview without closing the subagent transcript', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { data }));
    send({ type: 'providerSelection', providerId: 'codex', model: 'scub-model', effort: '', thinking: true });
    send({ type: 'sessionLoaded', id: 'codex:scub-parent', messages: [{ id: 'scub-parent-reply', role: 'assistant', content: '', blocks: [
      { type: 'tool', call: { id: 'scub-agent-start', name: 'subAgentActivity', kind: 'subAgentActivity',
        input: { agentThreadId: 'scub-child', agentPath: '/root/scub_child', activity: 'started' }, result: 'started' } },
    ] }] });
  });
  await page.getByRole('button', { name: 'Session activity' }).click();
  const activity = page.getByRole('dialog', { name: 'Session activity' });
  await activity.getByRole('button', { name: /Scub child/ }).click();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'subagentThread', parentId: 'codex:scub-parent', childId: 'scub-child', messages: [
      { id: 'scub-child-reply', role: 'assistant', content: '', blocks: [
        { type: 'tool', call: { id: 'scub-command', name: 'commandExecution', kind: 'command',
          input: { command: 'echo scub-output' }, result: 'scub-output\n' } },
      ] },
    ],
  } })));
  await activity.getByRole('link', { name: 'Out' }).click();
  const output = page.getByRole('dialog', { name: /File viewer:/ });
  await expect(output).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(output).toHaveCount(0);
  await expect(activity).toBeVisible();
  await expect(activity).toContainText('/root/scub_child');
  await page.keyboard.press('Escape');
  await expect(activity).toBeVisible();
  await expect(activity).toContainText('Subagents · 1');
  await expect(activity.getByRole('button', { name: /Scub child/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(activity).toHaveCount(0);
});
