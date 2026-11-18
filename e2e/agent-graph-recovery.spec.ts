import { test, expect } from '@playwright/test';
import { setup, sync, emit, requests, snapshot } from './fixtures/agent-graph-ui';
import { waitForApp } from './helpers';

const failure = { type: 'agentGraph', ok: false, error: { code: 'graph_refresh_failed' } };
const graphQueries = async (page: Parameters<typeof requests>[0]) => (await requests(page)).filter(m => m.type === 'getAgentGraph');
const socketTargets = new WeakMap<Parameters<typeof requests>[0], string[]>();
test.beforeEach(async ({ page }) => {
  const targets: string[] = []; socketTargets.set(page, targets);
  page.on('websocket', socket => targets.push(socket.url()));
});
test.afterEach(async ({ page, baseURL }, info) => {
  if (!process.env.ARGUS_STAGE2_PRIVATE_PORT) return;
  const targets = socketTargets.get(page) ?? [], backend = process.env.ARGUS_STAGE2_PRIVATE_PORT;
  expect(targets.some(target => new URL(target).port === backend)).toBe(true);
  expect(targets.every(target => { const url = new URL(target); return url.hostname === '127.0.0.1' && [backend, new URL(baseURL!).port].includes(url.port); })).toBe(true);
  await info.attach('private-sockets', { body: JSON.stringify({ count: targets.length, allPrivate: true, backendPort: backend }), contentType: 'application/json' });
});

test('refresh failure coalesces into one correlated snapshot shared by relationships and goals', async ({ page }) => {
  await setup(page); await sync(page); await emit(page, { type: 'sessionLoaded', id: 'parent', messages: [] });
  const old = (await graphQueries(page))[0];
  await page.evaluate(value => { for (let i = 0; i < 3; i++) window.dispatchEvent(new MessageEvent('message', { data: value })); }, failure);
  await expect.poll(async () => (await graphQueries(page)).length).toBe(2);
  const recovery = (await graphQueries(page))[1]; expect(recovery.requestId).not.toBe(old.requestId);
  expect(recovery.subscribe).toBe(true); expect(recovery.company).toBeUndefined(); expect(recovery.goal).toBeUndefined();
  await emit(page, { type: 'agentGraph', requestId: old.requestId, ok: true, snapshot: snapshot() });
  await expect(page.getByRole('button', { name: /Stock worker/ })).toHaveCount(0);
  const value = snapshot(); value.nodes[2].title = 'Updated stock worker'; value.scopes[0].data.goal.title = 'Updated inventory delivery';
  await sync(page, value);
  await expect(page.getByRole('button', { name: /Updated stock worker/ })).toBeVisible();
  await page.getByRole('button', { name: 'Company goals' }).click();
  await expect(page.getByRole('dialog', { name: 'Company goals' })).toContainText('Updated inventory delivery');
  expect(await graphQueries(page)).toHaveLength(2);
});

for (const outcome of ['failed', 'timeout'] as const) test(`a ${outcome} recovery exposes Retry without automatic request loops`, async ({ page }) => {
  await setup(page); await sync(page); await emit(page, { type: 'sessionLoaded', id: 'parent', messages: [] });
  await page.clock.install(); await emit(page, failure);
  await expect.poll(async () => (await graphQueries(page)).length).toBe(2);
  const recovery = (await graphQueries(page))[1];
  if (outcome === 'failed') await emit(page, { ...failure, requestId: recovery.requestId });
  else await page.clock.fastForward(5100);
  const panel = page.getByRole('region', { name: 'Linked sessions' });
  await expect(panel.getByRole('alert')).toContainText('unavailable');
  for (let i = 0; i < 3; i++) await emit(page, failure);
  await page.clock.fastForward(10000); expect(await graphQueries(page)).toHaveLength(2);
  await emit(page, { type: 'agentGraph', requestId: recovery.requestId, ok: true, snapshot: snapshot() });
  await expect(panel.getByRole('button', { name: /Stock worker/ })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Retry linked sessions' }).click();
  expect(await graphQueries(page)).toHaveLength(3); await sync(page);
  await expect(panel.getByRole('button', { name: /Stock worker/ })).toBeVisible();
});

test('disconnect cancels recovery and a batched reconnect ignores the replaced request', async ({ page }) => {
  await setup(page); await sync(page); await page.clock.install(); await emit(page, failure);
  await expect.poll(async () => (await graphQueries(page)).length).toBe(2);
  const recovery = (await graphQueries(page))[1];
  await page.evaluate(() => { for (const connected of [false, true]) window.dispatchEvent(new MessageEvent('message', { data: { type: 'ws_status', connected } })); });
  await expect.poll(async () => (await graphQueries(page)).length).toBe(3); await sync(page);
  await emit(page, { type: 'sessionLoaded', id: 'parent', messages: [] });
  await emit(page, { ...failure, requestId: recovery.requestId }); await page.clock.fastForward(10000);
  await expect(page.getByRole('button', { name: /Stock worker/ })).toBeVisible(); expect(await graphQueries(page)).toHaveLength(3);
});

test('the real mock host suppresses graph queries at its API boundary', async ({ page }) => {
  await page.addInitScript(() => {
    const state = (window as any).hostGraph = { attempted: [] as any[], forwarded: [] as any[], api: null as any };
    let acquire: () => any, factory: (options: any) => any;
    Object.defineProperty(window, 'createArgusBridge', { configurable: true, get: () => factory, set: value => {
      factory = options => { const bridge = value(options); return { ...bridge, post(message: any) {
        if (message.type === 'getAgentGraph') state.forwarded.push(message);
        bridge.post(message);
      } }; };
    } });
    Object.defineProperty(window, 'acquireVsCodeApi', { configurable: true, get: () => acquire, set: value => {
      acquire = () => { const api = value(); state.api = api; return { ...api, postMessage(message: any) {
        if (message.type === 'getAgentGraph') state.attempted.push(message);
        api.postMessage(message);
      } }; };
    } });
  });
  await waitForApp(page);
  await expect.poll(() => page.evaluate(() => (window as any).hostGraph.attempted.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).hostGraph.forwarded)).toEqual([]);
  await page.evaluate(() => (window as any).hostGraph.api.postMessage({ type: 'getAgentGraph', requestId: 'suppression-control', subscribe: true }));
  expect(await page.evaluate(() => (window as any).hostGraph.forwarded)).toEqual([]);
});
