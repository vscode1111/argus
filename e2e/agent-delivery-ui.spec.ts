import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
const { privateQuestionServer } = require('./fixtures/private-question-server.cjs');
test('private checkout bundle renders delivered live and Session History inputs violet', async ({ page }) => {
  const server = await privateQuestionServer({ providerPreload: path.join(__dirname, 'fixtures/delivery-spawn.cjs') });
  const loadedIds: string[] = [];
  page.on('websocket', socket => socket.on('framereceived', frame => {
    try { const message = JSON.parse(String(frame.payload)); if (message.type === 'sessionLoaded') loadedIds.push(message.id); } catch {}
  }));
  try {
    const url = `http://127.0.0.1:${server.info.port}`;
    const served = Buffer.from(await (await fetch(url + '/webview.js')).arrayBuffer());
    expect(createHash('sha256').update(served).digest('hex')).toBe(createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../media/webview.js'))).digest('hex'));
    const parent = await server.connect(), child = await server.connect();
    parent.send({ type: 'send', text: 'Prepare inventory' }); const id = (await parent.wait((f: any) => f.type === 'sessionId')).id; await parent.wait((f: any) => f.type === 'done');
    child.send({ type: 'send', text: 'Prepare inventory' }); const childId = (await child.wait((f: any) => f.type === 'sessionId')).id; await child.wait((f: any) => f.type === 'done');
    const node = (id: string) => ({ id, providerId: 'claude', role: 'work', workspace: server.dir, company: 'inventory', goal: 'stock', title: 'Inventory', createdAt: 1, updatedAt: 1 });
    parent.send({ type: 'linkAgents', requestId: 'link', parent: id, child: childId, kind: 'delegates', nodes: [node(id), node(childId)] }); await parent.wait((f: any) => f.requestId === 'link');
    await page.goto(url + '/?dir=' + encodeURIComponent(server.dir) + '&session=' + encodeURIComponent(id));
    await expect(page.getByPlaceholder('Ask Argus')).toBeVisible();
    await expect.poll(() => loadedIds.includes(id)).toBe(true);
    child.send({ type: 'send', text: 'Finish inventory' }); await parent.wait((f: any) => f.type === 'message' && f.message.content.startsWith('🤖'), 6000);
    const automatic = page.locator('div[class*="userMsg"]').filter({ hasText: '🤖' }).first(); await expect(automatic).toBeVisible();
    const violet = await automatic.evaluate(el => getComputedStyle(el).backgroundColor);
    const manual = page.locator('div[class*="userMsg"]').filter({ hasText: 'Prepare inventory' }).first(); await expect(manual).toBeVisible();
    expect(await manual.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(violet);
    await page.getByRole('button', { name: 'Session history', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Session History' }); await expect(dialog).toBeVisible();
    const loadedBefore = loadedIds.filter(loaded => loaded === id).length;
    await dialog.locator(`[data-session-id="${id}"]`).click(); await expect(dialog).toHaveCount(0);
    await expect.poll(() => loadedIds.filter(loaded => loaded === id).length).toBeGreaterThan(loadedBefore);
    await expect(automatic).toBeVisible(); await expect(automatic).toHaveCSS('background-color', violet);
    server.verifySpawn();
  } finally { await server.close(); }
});
