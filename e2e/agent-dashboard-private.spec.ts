import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const { privateQuestionServer } = require('./fixtures/private-question-server.cjs');

test('built dashboard preserves view and exact cross-workspace session identity through reload and history', async ({ page }) => {
  const server = await privateQuestionServer({ providerPreload: path.join(__dirname, 'fixtures/delivery-spawn.cjs') });
  const sockets: string[] = [], loadedIds: string[] = []; page.on('websocket', socket => { sockets.push(socket.url()); socket.on('framereceived', frame => { try { const m = JSON.parse(String(frame.payload)); if (m.type === 'sessionLoaded') loadedIds.push(m.id); } catch {} }); });
  let receipt: any;
  try {
    const parent = await server.connect(), child = await server.connect(path.join(server.dir, 'dispatch'));
    parent.send({ type: 'send', text: 'Hold inventory' }); child.send({ type: 'send', text: 'Hold inventory' });
    const parentId = (await parent.wait((m: any) => m.type === 'sessionId')).id, childId = (await child.wait((m: any) => m.type === 'sessionId')).id;
    const node = (id: string, title: string, role: string, workspace: string) => ({ id, title, role, workspace, providerId: 'claude', company: 'inventory', goal: 'stock', createdAt: 1, updatedAt: 1 });
    parent.send({ type: 'linkAgents', requestId: 'dashboard-link', parent: parentId, child: childId, kind: 'delegates', nodes: [node(parentId, 'Inventory coordinator', 'coordinator', server.dir), node(childId, 'Dispatch worker', 'work', path.join(server.dir, 'dispatch'))] });
    expect((await parent.wait((m: any) => m.requestId === 'dashboard-link')).ok).toBe(true);
    const base = `http://127.0.0.1:${server.info.port}`;
    const bytes = Buffer.from(await (await fetch(base + '/webview.js')).arrayBuffer());
    const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    expect(hash(bytes)).toBe(hash(fs.readFileSync(path.join(__dirname, '../media/webview.js')))); server.verifySpawn();
    await page.goto(base + '/?' + new URLSearchParams({ view: 'agents', session: parentId, dir: path.join(server.dir, 'wrong'), panel: 'unrelated-panel' }));
    const dashboard = page.getByRole('main', { name: 'Agent dashboard' });
    await expect(dashboard).toBeVisible(); await expect(dashboard).toContainText('2 matches');
    await expect.poll(() => loadedIds.includes(parentId)).toBe(true);
    await dashboard.getByRole('button', { name: 'Diagram', exact: true }).click();
    await expect(page.locator('[data-node-id]')).toHaveCount(2); await expect(page.locator('[data-edge-length]')).toHaveCount(1);
    const diagramCheck = await page.locator('[data-edge-length]').evaluate(e => ({ positive: Number(e.getAttribute('data-edge-length')) > 24, stroke: getComputedStyle(e).stroke, foreground: getComputedStyle(e.closest('main')!).color, background: getComputedStyle(e.closest('svg')!).backgroundColor }));
    expect(diagramCheck.positive).toBe(true); expect(diagramCheck.stroke).toBe(diagramCheck.foreground);
    await page.screenshot({ path: test.info().outputPath('built-dashboard-diagram.png') });
    await dashboard.getByRole('button', { name: 'Table', exact: true }).click();
    await page.reload(); await expect(dashboard).toContainText('2 matches'); expect(new URL(page.url()).searchParams.get('view')).toBe('agents');
    await page.evaluate(() => (window as any).argusReconnect?.()); await expect(dashboard).toContainText('2 matches');
    // Native fixture metadata owns both titles; distinguish the actual child by its parent relation.
    await dashboard.getByRole('row').filter({ hasText: 'Parents: Synthetic inventory' }).getByRole('button', { name: 'Open Synthetic inventory', exact: true }).click();
    await expect(page).toHaveURL(new RegExp('session=' + childId));
    expect(new URL(page.url()).searchParams.has('view')).toBe(false);
    await expect(page.getByRole('region', { name: 'Linked sessions' })).toContainText('Synthetic inventory');
    await expect.poll(() => loadedIds.includes(childId)).toBe(true);
    await page.goBack(); await expect(dashboard).toContainText('2 matches');
    expect(new URL(page.url()).searchParams.get('session')).toBe(childId);
    expect(new URL(page.url()).searchParams.get('dir')?.toLowerCase()).toBe(path.join(server.dir, 'dispatch').toLowerCase());
    await page.reload(); await expect(dashboard).toContainText('2 matches');
    await dashboard.getByRole('button', { name: 'Back to conversation' }).click();
    await expect(page.getByRole('region', { name: 'Linked sessions' })).toContainText('Synthetic inventory');
    expect(sockets.every(url => new URL(url).port === String(server.info.port))).toBe(true);
    receipt = { pid: server.info.pid, port: server.info.port, bundleSha256: hash(bytes), checkoutModule: server.spawns.find((m: any) => m.hasIdentity)?.serverModule, checkoutModuleSha256: server.spawns.find((m: any) => m.hasIdentity)?.serverHash, diagramCheck, allSocketsPrivate: true, explicitSessionOverridesStaleDirAndPanel: true, crossWorkspaceHistoryRetainsTarget: true, realProviderCalls: 0 };
    await page.screenshot({ path: test.info().outputPath('built-dashboard-conversation.png') });
  } finally {
    await page.close(); await server.close();
    if (receipt) fs.writeFileSync(test.info().outputPath('private-built-origin.json'), JSON.stringify({ ...receipt, ownedCleanup: true }, null, 2));
  }
});
