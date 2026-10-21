import { test, expect } from './provider-fixtures';
import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('a rename from another client updates the open session header', { tag: ['@shared'] }, async ({ page }) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-session-name-'));
  const id = randomUUID();
  const projectDir = path.join(os.homedir(), '.claude', 'projects', path.resolve(workspace).replace(/[^a-zA-Z0-9]/g, '-'));
  const transcript = path.join(projectDir, `${id}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'system', subtype: 'init', cwd: workspace, session_id: id }),
    JSON.stringify({ type: 'custom-title', customTitle: 'Initial conversation' }),
    JSON.stringify({ type: 'user', cwd: workspace, message: { role: 'user', content: 'Plan the release.' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Ready.' }] } }),
  ].join('\n') + '\n');

  let ws: WebSocket | undefined;
  try {
    await page.goto('/?dir=' + encodeURIComponent(workspace));
    await expect(page.getByPlaceholder('Ask Argus')).toBeVisible();
    await page.getByRole('button', { name: 'Session history' }).click();
    const dialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(dialog.locator(`[data-session-id="${id}"]`)).toBeVisible();
    await dialog.locator(`[data-session-id="${id}"]`).click();
    await expect(page.locator('button.sessionNameBtn')).toHaveText('Initial conversation');
    await page.getByRole('button', { name: 'Session history' }).click();
    const openDialog = page.getByRole('dialog', { name: 'Session History' });
    await expect(openDialog.locator(`[data-session-id="${id}"]`)).toContainText('Initial conversation');

    const port = process.env.ARGUS_E2E_PORT ?? '3001';
    const nonce = (await (await fetch(`http://localhost:${port}/nonce`)).text()).trim();
    ws = new WebSocket(`ws://localhost:${port}/agent?nonce=${encodeURIComponent(nonce)}&dir=${encodeURIComponent(workspace)}`, {
      origin: 'http://localhost:5173',
    });
    await new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', reject); });
    const requestId = randomUUID();
    const renamed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Rename response timed out')), 10_000);
      ws!.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.requestId !== requestId) return;
        clearTimeout(timer);
        if (message.type === 'sessionList') {
          const stored = message.sessions.find((session: { id: string }) => session.id === id);
          if (stored?.title === 'Updated conversation') resolve();
          else reject(new Error(`Stored title: ${stored?.title}`));
        }
        else reject(new Error(JSON.stringify(message)));
      });
    });
    ws.send(JSON.stringify({ type: 'renameSession', id, title: 'Updated conversation', requestId }));
    await renamed;
    await expect(page.locator('button.sessionNameBtn')).toHaveText('Updated conversation', { timeout: 3_000 });
    await expect(openDialog.locator(`[data-session-id="${id}"]`)).toContainText('Updated conversation');
  } finally {
    ws?.close();
    fs.rmSync(transcript, { force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
