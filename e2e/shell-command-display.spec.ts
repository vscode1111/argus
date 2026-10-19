import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test('JavaScript tool badge matches the Bash background width', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const calls = [
      { id: 'sample-script', name: 'js', input: { code: 'await widget.refresh();' } },
      { id: 'sample-bash', name: 'Bash', input: { command: 'printf sample' } },
    ];
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'thinking_start' } }));
    for (const call of calls) {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_start', call } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_end', call } }));
    }
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'done' } }));
  });

  const jsWidth = await page.getByText('js', { exact: true }).first()
    .evaluate(element => element.getBoundingClientRect().width);
  const bashWidth = await page.getByRole('img', { name: 'Bash' }).locator('svg rect')
    .evaluate(element => element.getBoundingClientRect().width);
  expect(Math.abs(jsWidth - bashWidth)).toBeLessThan(1);
});

test('command rows show the executable icon and the remaining command', async ({ page }) => {
  await waitForApp(page);
  await page.evaluate(() => {
    const commands = [
      { id: 'scub-ps', command: '"C:\\scub\\powershell.exe" -Command "Get-Content scub-file.txt"' },
      { id: 'scub-bash', command: '/bin/bash -lc "printf scub-bash"' },
      { id: 'scub-cmd', command: '"C:\\scub\\cmd.exe" /C "echo scub-cmd"' },
      { id: 'scub-plain', command: 'git status --short' },
      { id: 'sample-node', command: 'node -e "process.stdout.write(\'sample\')"' },
      { id: 'sample-wrapped-grep', command: '/bin/bash -lc "grep -n sample sample.txt"' },
      { id: 'sample-sed', command: 'sed -n 1,10p sample.txt' },
      { id: 'sample-cat', command: "cat '/workspace/sample notes.txt'" },
      { id: 'sample-cat-double', command: 'cat "/workspace/draft.txt"' },
      { id: 'sample-cat-multiple', command: "cat '/workspace/first note.txt' '/workspace/second note.txt'" },
      { id: 'sample-rg', command: 'rg sample sample.txt' },
      { id: 'sample-npm', command: 'npm run build' },
      { id: 'sample-yarn', command: 'yarn test' },
      { id: 'sample-unknown', command: 'custom-tool sample.txt' },
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
  await expect(page.getByRole('img', { name: 'Git' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Node.js' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Grep', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'sed' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'cat' })).toHaveCount(3);
  await expect(page.getByRole('img', { name: 'ripgrep' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'npm' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Yarn' })).toBeVisible();
  const commandIcons = ['Node.js', 'Git', 'Grep', 'ripgrep', 'sed', 'cat', 'npm', 'Yarn'];
  const marks = await Promise.all(commandIcons.map(name =>
    page.getByRole('img', { name, exact: true }).first().locator('svg').evaluate(svg => svg.innerHTML)));
  expect(new Set(marks).size).toBe(commandIcons.length);
  const colors = await Promise.all(commandIcons.map(name =>
    page.getByRole('img', { name, exact: true }).first().evaluate(icon => getComputedStyle(icon).color)));
  expect(new Set(colors).size).toBe(commandIcons.length);
  await expect(page.getByText('Get-Content scub-file.txt')).toBeVisible();
  await expect(page.getByText('printf scub-bash')).toBeVisible();
  await expect(page.getByText('echo scub-cmd')).toBeVisible();
  await expect(page.getByText('status --short', { exact: true })).toBeVisible();
  await expect(page.getByText('/workspace/sample notes.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('/workspace/draft.txt', { exact: true })).toBeVisible();
  await expect(page.getByText("'/workspace/first note.txt' '/workspace/second note.txt'", { exact: true })).toBeVisible();
  await expect(page.getByText("process.stdout.write('sample')", { exact: true })).toBeVisible();
  await expect(page.getByText('grep -n sample sample.txt', { exact: true })).toHaveCount(0);
  await expect(page.getByText('-n sample sample.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('run build', { exact: true })).toBeVisible();
  await expect(page.getByText('test', { exact: true })).toBeVisible();
  await expect(page.getByText('custom-tool sample.txt', { exact: true })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('C:\\scub\\powershell.exe');
  await expect(page.getByRole('img', { name: 'PowerShell' })).toHaveAttribute('title', '"C:\\scub\\powershell.exe" -Command "Get-Content scub-file.txt"');
  await expect(page.getByRole('img', { name: 'Node.js' })).toHaveAttribute('title', 'node -e "process.stdout.write(\'sample\')"');
  await expect(page.getByRole('img', { name: 'cat' }).first()).toHaveAttribute('title', "cat '/workspace/sample notes.txt'");
});

test('quoted node -e prefix uses the Node.js icon', async ({ page }) => {
  await waitForApp(page);
  const command = '"node -e" const fs=require("fs");fs.readFileSync("sample.txt","utf8")';
  await page.evaluate(command => {
    const call = { id: 'quoted-node-eval', name: 'commandExecution', kind: 'command', input: { command }, result: 'sample output' };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'thinking_start' } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_start', call } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_end', call } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'done' } }));
  }, command);

  await expect(page.getByRole('img', { name: 'Node.js' })).toHaveAttribute('title', command);
  await expect(page.getByText('const fs=require("fs");fs.readFileSync("sample.txt","utf8")', { exact: true })).toBeVisible();
});

test('Node.js icon survives nested quotes in a shell wrapper', async ({ page }) => {
  await waitForApp(page);
  const command = '"C:\\Program Files\\Git\\bin\\bash.exe" -c "node -e \'console.log("sample")\'"';
  await page.evaluate(command => {
    const call = { id: 'nested-node-eval', name: 'commandExecution', kind: 'command', input: { command }, result: 'sample' };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'thinking_start' } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_start', call } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_end', call } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'done' } }));
  }, command);

  await expect(page.getByRole('img', { name: 'Node.js' })).toHaveAttribute('title', command);
  await expect(page.getByText('console.log("sample")', { exact: true })).toBeVisible();
});

test('shell-wrapped Node.js code omits enclosing quote fragments', async ({ page }) => {
  await waitForApp(page);
  const command = String.raw`"C:\\Program Files\\Git\\bin\\bash.exe" -c "node -e 'console.log(\"sample\")'"'"`;
  await page.evaluate(command => {
    const call = { id: 'wrapped-node-code', name: 'commandExecution', kind: 'command', input: { command }, result: 'sample' };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'thinking_start' } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_start', call } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_end', call } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'done' } }));
  }, command);

  const icon = page.getByRole('img', { name: 'Node.js' });
  await expect(icon).toHaveAttribute('title', command);
  const visibleCode = await icon.evaluate(element => element.nextElementSibling?.textContent);
  expect(visibleCode?.startsWith('console.log(')).toBe(true);
  expect(visibleCode?.endsWith(')')).toBe(true);
});

test('Node.js code with inner quotes omits its outer pair', async ({ page }) => {
  await waitForApp(page);
  const command = 'bash -c "node -e \'console.log(\'sample\')\'"';
  await page.evaluate(command => {
    const call = { id: 'node-code-quotes', name: 'commandExecution', kind: 'command', input: { command }, result: 'sample' };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'thinking_start' } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_start', call } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_end', call } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'done' } }));
  }, command);

  const icon = page.getByRole('img', { name: 'Node.js' });
  await expect(icon).toHaveAttribute('title', command);
  await expect(page.getByText("console.log('sample')", { exact: true })).toBeVisible();
});

test('Node.js code keeps quotes around separate arguments', async ({ page }) => {
  await waitForApp(page);
  const command = "node -e 'console.log(1)' 'sample'";
  await page.evaluate(command => {
    const call = { id: 'node-code-arguments', name: 'commandExecution', kind: 'command', input: { command }, result: '1' };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'thinking_start' } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_start', call } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'tool_end', call } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'done' } }));
  }, command);

  await expect(page.getByRole('img', { name: 'Node.js' })).toHaveAttribute('title', command);
  await expect(page.getByText("'console.log(1)' 'sample'", { exact: true })).toBeVisible();
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
  await expect(page.getByRole('img', { name: 'Node.js' })).toBeVisible();
  await expect(page.getByText('C:/scub/other/scripts/control.js respond --key scub-other', { exact: true })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('C:/scub/orchestrate/scripts/control.js');
});
