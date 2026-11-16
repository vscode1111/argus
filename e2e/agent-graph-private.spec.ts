import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { privateQuestionServer } from './fixtures/private-question-server.cjs';

test('private graph pushes project real registry questions and navigate linked live sessions', async ({ page }) => {
  const server = await privateQuestionServer({ providerPreload: path.join(__dirname, 'fixtures/delivery-spawn.cjs') });
  let receipt: object | undefined;
  try {
    const parent = await server.connect(), child = await server.connect();
    parent.send({ type: 'send', text: 'Hold inventory' }); child.send({ type: 'send', text: 'Hold inventory' });
    const parentId = (await parent.wait(f => f.type === 'sessionId')).id, childId = (await child.wait(f => f.type === 'sessionId')).id;
    expect(parentId).not.toBe(childId);
    const node = (id: string, role: string) => ({ id, providerId: 'claude', role, title: 'Inventory', company: 'inventory', goal: 'stock', workspace: server.dir, createdAt: 1, updatedAt: 1 });
    parent.send({ type: 'linkAgents', requestId: 'link', parent: parentId, child: childId, kind: 'delegates', nodes: [node(parentId, 'coordinator'), node(childId, 'work')] });
    expect((await parent.wait(f => f.requestId === 'link')).ok).toBe(true);
    parent.send({ type: 'updateAgentScope', requestId: 'scope', company: 'inventory', goal: 'stock', expectedRevision: 0, data: {
      version: 1, goal: { title: 'Inventory delivery', status: 'active', profile: 'normal', profileRevision: 1, createdAt: 1, updatedAt: 1 }, reviewCycles: [],
      workers: { work: { role: 'work', providerId: 'claude', title: 'Inventory', workspace: server.dir, sessionId: childId, model: '', effort: '', profile: 'normal' } } } });
    expect((await parent.wait(f => f.requestId === 'scope')).ok).toBe(true);
    const base = 'http://127.0.0.1:' + server.info.port;
    const health = await (await fetch(base + '/health')).json(); expect(health.pid).toBe(server.info.pid); expect(health.configPath.toLowerCase()).toBe(server.config.toLowerCase());
    const served = Buffer.from(await (await fetch(base + '/webview.js')).arrayBuffer());
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    expect(hash(served)).toBe(hash(fs.readFileSync(path.join(__dirname, '../media/webview.js')))); server.verifySpawn();
    const targets: string[] = []; let subscriptions = 0;
    page.on('websocket', socket => {
      targets.push(socket.url()); socket.on('framesent', frame => {
        try { const message = JSON.parse(String(frame.payload)); if (message.type === 'getAgentGraph' && message.subscribe) subscriptions++; } catch {}
      });
    });
    await page.goto(base + '/?' + new URLSearchParams({ dir: server.dir, session: parentId }));
    const panel = page.getByRole('region', { name: 'Linked sessions' }); await expect(panel).toContainText('Running');
    child.send({ type: 'steer', text: 'Choose inventory' });
    await child.wait(f => f.type === 'interaction' && f.request);
    await expect(panel).toContainText('Needs input');
    await panel.getByRole('button').click(); await expect(page).toHaveURL(new RegExp('session=' + childId));
    await expect(panel).toContainText('Parents');
    await panel.getByRole('button').click(); await expect(page).toHaveURL(new RegExp('session=' + parentId));
    await expect(panel).toContainText('Needs input');
    await page.getByRole('button', { name: 'Company goals' }).click();
    const goals = page.getByRole('dialog', { name: 'Company goals' }); await expect(goals).toContainText('Coordinator'); await expect(goals).toContainText('Inventory delivery');
    parent.send({ type: 'getAgentScope', requestId: 'read-scope', company: 'inventory', goal: 'stock' });
    const scope = (await parent.wait(f => f.requestId === 'read-scope')).scope; scope.data.goal.title = 'Inventory revision';
    parent.send({ type: 'updateAgentScope', requestId: 'update-scope', company: 'inventory', goal: 'stock', expectedRevision: scope.revision, data: scope.data });
    expect((await parent.wait(f => f.requestId === 'update-scope')).ok).toBe(true);
    await expect(goals).toContainText('Inventory revision'); await goals.getByRole('button', { name: 'Close', exact: true }).click();
    const beforeReconnect = subscriptions; await page.evaluate(() => window.argusReconnect?.());
    await expect.poll(() => subscriptions).toBeGreaterThan(beforeReconnect); await expect(panel).toContainText('Needs input');
    parent.send({ type: 'unlinkAgents', requestId: 'unlink', parent: parentId, child: childId, kind: 'delegates' });
    expect((await parent.wait(f => f.requestId === 'unlink')).ok).toBe(true); await expect(panel).toContainText('No children assigned');
    expect(targets.every(target => new URL(target).port === String(server.info.port))).toBe(true);
    receipt = { ownedPid: server.info.pid, actualPort: server.info.port, privateConfigMatched: true, servedBundleSha256: hash(served),
      checkoutModuleSha256: server.spawns.find(s => s.hasIdentity)?.serverHash, loadedCheckoutExecutionModule: true, allBrowserSocketsPrivate: true,
      liveQuestionPush: true, scopePush: true, reconnectSubscription: true, unlinkPush: true, liveNavigationBothDirections: true, realProviderTurns: 0 };
  } finally {
    await page.goto('about:blank'); await server.close();
    if (receipt) fs.writeFileSync(process.env.ARGUS_STAGE6_ARTIFACTS ? path.join(process.env.ARGUS_STAGE6_ARTIFACTS, 'private-origin.json') : test.info().outputPath('private-origin.json'),
      JSON.stringify({ ...receipt, ownedServerCleanupVerified: true }, null, 2));
  }
});
