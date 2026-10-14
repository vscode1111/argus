import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('command rows show the shell icon and the inner command', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const commands = [
      { id: 'scub-ps', command: '"C:\\scub\\powershell.exe" -Command "Get-Content scub-file.txt"' },
      { id: 'scub-bash', command: '/bin/bash -lc "printf scub-bash"' },
      { id: 'scub-cmd', command: '"C:\\scub\\cmd.exe" /C "echo scub-cmd"' },
      { id: 'scub-plain', command: 'git status --short' },
    ];
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'thinking_start' } }));
    for (const item of commands) {
      const call = { id: item.id, name: 'commandExecution', kind: 'command', input: { command: item.command }, result: 'scub-done' };
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_start', call } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_end', call } }));
    }
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'done' } }));
  });

  await expect(page.getByRole('img', { name: 'PowerShell' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Command Prompt' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Bash' })).toHaveCount(2);
  await expect(page.getByText('Get-Content scub-file.txt')).toBeVisible();
  await expect(page.getByText('printf scub-bash')).toBeVisible();
  await expect(page.getByText('echo scub-cmd')).toBeVisible();
  await expect(page.getByText('git status --short')).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('C:\\scub\\powershell.exe');
  await expect(page.getByRole('img', { name: 'PowerShell' })).toHaveAttribute('title', '"C:\\scub\\powershell.exe" -Command "Get-Content scub-file.txt"');
});

test('orchestration rows replace the repeated controller command with an icon and worker action', async ({ page }) => {
  await waitForApp(page);
  const command = 'node C:/scub/orchestrate/scripts/control.js respond --company scub-company --key scub-task --id scub-request';
  await page.evaluate(command => {
    const commands = [
      { id: 'scub-controller', command },
      { id: 'scub-wrapped', command: `"C:\\scub\\bash.exe" -c "node C:/scub/orchestrate/scripts/control.js send --company scub-company --key scub-task"` },
      { id: 'scub-other', command: 'node C:/scub/other/scripts/control.js respond --key scub-other' },
    ];
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'thinking_start' } }));
    for (const item of commands) {
      const call = { id: item.id, name: 'commandExecution', kind: 'command', input: { command: item.command }, result: 'scub-done' };
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_start', call } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_end', call } }));
    }
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'done' } }));
  }, command);

  await expect(page.getByRole('img', { name: 'Orchestration' })).toHaveCount(2);
  await expect(page.getByText('respond scub-task', { exact: true })).toBeVisible();
  await expect(page.getByText('send scub-task', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Orchestration' }).first()).toHaveAttribute('title', command);
  await expect(page.getByText('node C:/scub/other/scripts/control.js respond --key scub-other', { exact: true })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('C:/scub/orchestrate/scripts/control.js');
});
