import { test, expect } from '@playwright/test';
import { node, snapshot, setup, sync, emit, requests } from './fixtures/agent-graph-ui';
test('linked sessions follow the viewed identity and preserve multiple parents and navigation', async ({ page }) => {
  const graph = snapshot();
  Object.assign(graph.nodes[2], { selected: { model: 'inventory-model' } });
  await setup(page); await sync(page, graph); await emit(page, { type: 'sessionLoaded', id: 'parent', messages: [] });
  const agents = page.getByRole('region', { name: 'Linked sessions' });
  await expect(agents.getByRole('button', { name: /Stock worker/ })).toHaveCount(1);
  await expect(agents.getByRole('button', { name: /Stock worker/ }).getByTitle('inventory-model')).toBeVisible();
  const toggle = page.locator('.headerLeft').getByRole('button', { name: 'Agents, 0 of 1 running' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.press('Enter');
  await expect(agents.getByRole('button', { name: /Stock worker/ })).toBeHidden();
  await toggle.press('Enter');
  await expect(agents.getByRole('button', { name: /Stock worker/ })).toBeVisible();
  await page.getByRole('button', { name: 'Hide session bar' }).click();
  await expect(agents).toBeHidden();
  await expect(page.getByRole('button', { name: 'Agent dashboard' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Agents, 0 of 1 running' })).toBeHidden();
  await page.getByRole('button', { name: 'Show session bar' }).click();
  await expect(page.getByRole('button', { name: 'Agent dashboard' })).toBeVisible();
  await expect(toggle).toBeVisible();
  await expect(agents.getByRole('button', { name: /Stock worker/ })).toBeVisible();
  await expect(agents.getByRole('img', { name: 'Needs input' })).toBeVisible(); await expect(agents).toContainText('Choose section'); await expect(agents).toContainText('Turn finished');
  await emit(page, { type: 'sessionLoaded', id: 'child', messages: [] });
  await expect(agents.getByRole('button', { name: /Inventory coordinator/ })).toBeVisible();
  await expect(agents.getByRole('button', { name: /Quality coordinator/ })).toBeVisible();
  if (process.env.ARGUS_STAGE6_ARTIFACTS) await page.screenshot({ path: process.env.ARGUS_STAGE6_ARTIFACTS + '/parents.png' });
  await agents.getByRole('button', { name: /Inventory coordinator/ }).focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await requests(page)).filter(m => m.type === 'resumeSession').at(-1)?.id).toBe('parent');
  await expect(agents).toBeHidden();
});
test('Escape opens the first parent after any open modal has closed', async ({ page }) => {
  await setup(page);
  await sync(page);
  await emit(page, { type: 'sessionLoaded', id: 'child', messages: [] });
  await expect(page.getByRole('button', { name: /Inventory coordinator/ })).toBeVisible();
  await page.getByRole('button', { name: 'Company goals' }).click();
  const dialog = page.getByRole('dialog', { name: 'Company goals' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect((await requests(page)).filter(message => message.type === 'resumeSession')).toHaveLength(0);

  await page.getByRole('button', { name: 'Hide session bar' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await requests(page)).filter(message => message.type === 'resumeSession').map(message => message.id))
    .toEqual(['parent']);
});
test('long question captions show two lines with an ellipsis', async ({ page }) => {
  const question = 'Which inventory changes should be included in the next warehouse report? '.repeat(6).trim();
  const value = snapshot();
  Object.assign(value.nodes[0], { pendingInteraction: { title: 'Inventory review', questions: [{ question }] } });
  Object.assign(value.nodes[2], { pendingInteraction: { title: 'Inventory review', questions: [{ question }] } });
  await setup(page);
  await sync(page, value);
  const panel = page.getByRole('region', { name: 'Linked sessions' });
  for (const id of ['parent', 'child']) {
    await emit(page, { type: 'sessionLoaded', id, messages: [] });
    const caption = panel.getByText(question, { exact: true });
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      const layout = await caption.evaluate(element => {
        const sample = element.cloneNode() as HTMLElement;
        sample.textContent = 'A';
        element.after(sample);
        const line = sample.getBoundingClientRect().height;
        sample.remove();
        return {
          lines: element.getBoundingClientRect().height / line,
          clamp: getComputedStyle(element).webkitLineClamp,
          clipped: element.scrollHeight > element.clientHeight,
        };
      });
      expect(layout).toEqual({ lines: 2, clamp: '2', clipped: true });
      await expect(panel.getByText('Last: Turn finished').first()).toBeVisible();
    }
  }
});
test('company goals use graph pushes with coordinator heading and no five-second polling', async ({ page }) => {
  await setup(page); await sync(page); await page.getByRole('button', { name: 'Company goals' }).click();
  const dialog = page.getByRole('dialog', { name: 'Company goals' });
  await expect(dialog).toContainText('Inventory delivery'); await expect(dialog).toContainText('important'); await expect(dialog).toContainText('Inventory coordinator');
  await emit(page, { type: 'agentGraph', baseRevision: { epoch: 'inventory', seq: 1 }, revision: { epoch: 'inventory', seq: 2 },
    upsert: { nodes: [{ ...node('child', 'Stock worker'), status: 'running' }], edges: [], scopes: [] }, remove: { nodes: [], edges: [], scopes: [] } });
  await expect(dialog).toContainText('Running');
  await page.waitForTimeout(5200);
  expect((await requests(page)).filter(m => m.type === 'getOrchestratorGoals')).toHaveLength(0);
  expect((await requests(page)).filter(m => m.type === 'getAgentGraph')).toHaveLength(1);
});
test('revision gaps and reconnect require a fresh correlated snapshot and ignore late replies', async ({ page }) => {
  await setup(page); await sync(page); await emit(page, { type: 'sessionLoaded', id: 'parent', messages: [] });
  const old = (await requests(page)).find(m => m.type === 'getAgentGraph');
  await emit(page, { type: 'agentGraph', baseRevision: { epoch: 'inventory', seq: 9 }, revision: { epoch: 'inventory', seq: 10 }, upsert: {}, remove: {} });
  await expect.poll(async () => (await requests(page)).filter(m => m.type === 'getAgentGraph').length).toBe(2);
  await emit(page, { type: 'agentGraph', requestId: old.requestId, ok: true, snapshot: snapshot() });
  await expect(page.getByRole('button', { name: /Stock worker/ })).toHaveCount(0);
  await sync(page); await expect(page.getByRole('button', { name: /Stock worker/ })).toBeVisible();
  await emit(page, { type: 'ws_status', connected: false }); await emit(page, { type: 'ws_status', connected: true });
  await expect.poll(async () => (await requests(page)).filter(m => m.type === 'getAgentGraph').length).toBe(3);
  const q = (await requests(page)).filter(m => m.type === 'getAgentGraph').at(-1);
  await emit(page, { type: 'agentGraph', requestId: q.requestId, ok: false });
  await expect(page.getByRole('region', { name: 'Linked sessions' })).toContainText('unavailable');
  await page.getByRole('button', { name: 'Retry linked sessions' }).click(); await sync(page);
  await expect(page.getByRole('button', { name: /Stock worker/ })).toBeVisible();
});
test('removed nodes, duplicate revisions and unknown runtime do not invent progress or goal completion', async ({ page }) => {
  await setup(page); await emit(page, { type: 'sessionLoaded', id: 'parent', messages: [] });
  await expect(page.getByRole('region', { name: 'Linked sessions' })).toContainText('Loading');
  const value = snapshot(); Object.assign(value.nodes[2], { live: false, status: null, pendingInteraction: null }); await sync(page, value);
  await expect(page.getByRole('region', { name: 'Linked sessions' }).getByRole('img', { name: 'Unknown' })).toBeVisible();
  await emit(page, { type: 'agentGraph', baseRevision: value.revision, revision: { epoch: 'inventory', seq: 2 },
    upsert: { nodes: [], edges: [], scopes: [] }, remove: { nodes: ['child'], edges: ['a', 'b', 'c'], scopes: [] } });
  await expect(page.getByRole('region', { name: 'Linked sessions' })).toContainText('No children assigned');
  await emit(page, { type: 'agentGraph', baseRevision: value.revision, revision: { epoch: 'inventory', seq: 2 },
    upsert: { nodes: value.nodes, edges: value.edges, scopes: [] }, remove: { nodes: [], edges: [], scopes: [] } });
  await expect(page.getByRole('region', { name: 'Linked sessions' })).toContainText('No children assigned');
  await page.getByRole('button', { name: 'Company goals' }).click();
  const dialog = page.getByRole('dialog', { name: 'Company goals' }); await expect(dialog).toContainText('active'); await expect(dialog).toContainText('Unknown');
});
test('linked sessions remain readable and keyboard accessible at supported widths', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await setup(page); await sync(page); await emit(page, { type: 'sessionLoaded', id: 'parent', messages: [] });
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const panel = page.getByRole('region', { name: 'Linked sessions' });
    await panel.getByRole('button', { name: /Stock worker/ }).focus(); await expect(panel.getByRole('button')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const contrast = await panel.getByRole('button').evaluate(button => {
      const style = getComputedStyle(button), rgb = (value: string) => value.match(/\d+/g)!.slice(0, 3).map(Number);
      const luminance = (color: number[]) => color.map(c => { const n = c / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
      const fg = luminance(rgb(style.color)), bg = luminance(rgb(style.backgroundColor));
      return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: process.env.ARGUS_STAGE6_ARTIFACTS ? process.env.ARGUS_STAGE6_ARTIFACTS + '/agents-' + width + '.png' : test.info().outputPath('agents-' + width + '.png') });
  }
  await emit(page, { type: 'sessionLoaded', id: 'child', messages: [] });
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.getByRole('region', { name: 'Linked sessions' })).toContainText('Quality coordinator');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: process.env.ARGUS_STAGE6_ARTIFACTS ? process.env.ARGUS_STAGE6_ARTIFACTS + '/parents-' + width + '.png' : test.info().outputPath('parents-' + width + '.png') });
  }
  await emit(page, { type: 'sessionLoaded', id: 'parent', messages: [] });
  await page.getByRole('button', { name: 'Company goals' }).click();
  await expect(page.getByRole('dialog', { name: 'Company goals' })).toBeVisible();
  await page.screenshot({ path: process.env.ARGUS_STAGE6_ARTIFACTS ? process.env.ARGUS_STAGE6_ARTIFACTS + '/goals.png' : test.info().outputPath('goals.png') });
  expect(errors).toEqual([]);
});
test('a reconnect batched in one render still renews the socket subscription', async ({ page }) => {
  await setup(page); await sync(page);
  await page.evaluate(() => {
    for (const connected of [false, true]) window.dispatchEvent(new MessageEvent('message', { data: { type: 'ws_status', connected } }));
  });
  await expect.poll(async () => (await requests(page)).filter(m => m.type === 'getAgentGraph').length).toBe(2);
});

test('agent card backgrounds follow live status changes', async ({ page }) => {
  await setup(page);
  await sync(page);
  await emit(page, { type: 'sessionLoaded', id: 'parent', messages: [] });
  const card = page.getByRole('region', { name: 'Linked sessions' }).getByRole('button', { name: /Stock worker/ });
  await expect(card.getByRole('img', { name: 'Needs input' })).toBeVisible();
  const states = [
    [null, 'Unknown', ''],
    ['idle', 'Idle', '--fg'],
    ['running', 'Running', '--vscode-charts-green', 34],
    ['error', 'Error', '--error-fg'],
    ['needs-input', 'Needs input', '--vscode-charts-yellow'],
    ['stopped', 'Stopped', '--stopped-fg'],
  ] as const;
  const backgrounds: Record<string, { normal: string; expected: string; hovered: string; expectedHover: string }> = {};
  for (const [index, [status, label, accent, tint = 20]] of states.entries()) {
    await emit(page, { type: 'agentGraph', baseRevision: { epoch: 'inventory', seq: index + 1 },
      revision: { epoch: 'inventory', seq: index + 2 }, upsert: { nodes: [{ ...node('child', 'Stock worker'), status }], edges: [], scopes: [] }, remove: { nodes: [], edges: [], scopes: [] } });
    await expect(card.getByRole('img', { name: label })).toHaveAttribute('title', label);
    const running = status === 'running' ? 1 : 0;
    await expect(page.getByRole('button', { name: `Agents, ${running} of 1 running` })).toContainText(`${running}/1`);
    const sample = await card.evaluate((element, { color, tint }) => {
      const probe = document.createElement('span');
      element.append(probe);
      probe.style.backgroundColor = color ? `color-mix(in srgb, var(${color}) ${tint}%, var(--tool-bg))` : 'var(--tool-bg)';
      const expected = getComputedStyle(probe).backgroundColor;
      probe.style.backgroundColor = color ? `color-mix(in srgb, var(${color}) ${tint + 8}%, var(--tool-bg))` : 'var(--assistant-bg)';
      const expectedHover = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { normal: getComputedStyle(element).backgroundColor, expected, expectedHover };
    }, { color: accent, tint });
    await card.hover();
    backgrounds[label] = { ...sample, hovered: await card.evaluate(element => getComputedStyle(element).backgroundColor) };
    await page.mouse.move(0, 0);
  }
  for (const [label, { normal, expected, hovered, expectedHover }] of Object.entries(backgrounds)) {
    expect.soft(normal, label).toBe(expected);
    expect.soft(hovered, `${label} on hover`).toBe(expectedHover);
  }
});
