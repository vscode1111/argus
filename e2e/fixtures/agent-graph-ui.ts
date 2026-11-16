import { expect, type Page } from '@playwright/test';
import { waitForApp } from '../helpers';
export const node = (id: string, title: string, role = 'work') => ({ id, title, role, providerId: 'claude', workspace: 'D:/inventory', company: 'inventory', goal: 'stock', createdAt: 1, updatedAt: 1,
  live: true, status: 'idle', pendingInteraction: null, selected: null, activeSelection: null, lastEventAt: 1, lastEventSummary: 'Turn finished' });
export const snapshot = () => ({ storeId: 'inventory', storeRevision: 1, revision: { epoch: 'inventory', seq: 1 },
  nodes: [node('parent', 'Inventory coordinator', 'coordinator'), node('second', 'Quality coordinator', 'coordinator'), { ...node('child', 'Stock worker'), status: 'needs-input', pendingInteraction: { title: 'Choose section' } }],
  edges: [{ id: 'a', from: 'parent', to: 'child', kind: 'delegates' }, { id: 'b', from: 'second', to: 'child', kind: 'reviews' }, { id: 'c', from: 'parent', to: 'child', kind: 'reviews' }],
  scopes: [{ company: 'inventory', goal: 'stock', owned: true, revision: 1, data: { version: 1, goal: { title: 'Inventory delivery', status: 'active', profile: 'important' }, workers: { work: { sessionId: 'child', title: 'Stock worker', workspace: 'D:/inventory', role: 'work' } } } }] });
export async function emit(page: Page, data: object) { await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data); }
export async function requests(page: Page) { return page.evaluate(() => (window as any).graphRequests as any[]); }
export async function setup(page: Page) {
  await page.addInitScript(() => {
    (window as any).graphRequests = [];
    let acquire: () => any;
    Object.defineProperty(window, 'acquireVsCodeApi', { configurable: true, get: () => acquire, set: factory => {
      acquire = () => { const api = factory(); return { ...api, postMessage(message: any) {
        if (['getAgentGraph', 'getOrchestratorGoals', 'resumeSession'].includes(message.type)) { (window as any).graphRequests.push(message); return; }
        api.postMessage(message);
      } }; };
    } });
  });
  await waitForApp(page);
  await expect.poll(async () => (await requests(page)).filter(m => m.type === 'getAgentGraph').length).toBeGreaterThan(0);
  await emit(page, { type: 'workspaceInfo', path: 'D:/inventory' });
}
export async function sync(page: Page, value = snapshot()) {
  const query = (await requests(page)).filter(m => m.type === 'getAgentGraph').at(-1);
  await emit(page, { type: 'agentGraph', requestId: query.requestId, ok: true, snapshot: value });
}
