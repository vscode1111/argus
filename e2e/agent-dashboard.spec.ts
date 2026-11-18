import { test, expect } from '@playwright/test';
import { setup, sync, emit, requests, snapshot, node } from './fixtures/agent-graph-ui';

test('dashboard filters locally, retains all parents and closes hidden selection', async ({ page }) => {
  await setup(page); const value = snapshot();
  value.nodes.push({ ...node('dispatch', 'Dispatch verification with a complete descriptive title'), company: 'dispatch', goal: 'routes', live: false, status: null } as any);
  await sync(page, value); await page.getByRole('button', { name: 'Agent dashboard', exact: true }).click();
  const dashboard = page.getByRole('main', { name: 'Agent dashboard' });
  await expect(dashboard).toContainText('4 matches'); await expect(dashboard).toContainText('Unknown');
  await dashboard.getByRole('combobox', { name: 'Company', exact: true }).selectOption('dispatch');
  await dashboard.getByRole('combobox', { name: 'Goal', exact: true }).selectOption('routes');
  await dashboard.getByLabel('Search title').fill('VERIFICATION');
  await expect(dashboard).toContainText('1 match'); await expect(dashboard).toContainText('Dispatch verification with a complete descriptive title');
  await dashboard.getByRole('combobox', { name: 'Company', exact: true }).selectOption('');
  await dashboard.getByRole('combobox', { name: 'Goal', exact: true }).selectOption('');
  await dashboard.getByLabel('Search title').fill('');
  await dashboard.getByRole('button', { name: 'Inspect Stock worker', exact: true }).click();
  await expect(dashboard.getByRole('region', { name: 'Session details' })).toContainText('Quality coordinator');
  await dashboard.getByRole('combobox', { name: 'Status', exact: true }).selectOption('needs-input');
  await expect(dashboard).toContainText('1 match'); await expect(dashboard).toContainText('2 context');
  await expect(dashboard.getByRole('table')).toContainText('Ancestor context');
  await dashboard.getByLabel('Search title').fill('No matching title');
  await expect(dashboard).toContainText('No matching agents');
  await expect(dashboard.getByRole('region', { name: 'Session details' })).toHaveCount(0);
  await dashboard.getByLabel('Search title').fill('');
  await dashboard.getByRole('button', { name: 'Inspect Stock worker', exact: true }).click();
  await emit(page, { type: 'agentGraph', baseRevision: value.revision, revision: { epoch: 'inventory', seq: 2 }, upsert: { nodes: [], edges: [], scopes: [] }, remove: { nodes: ['child'], edges: ['a', 'b', 'c'], scopes: [] } });
  await expect(dashboard.getByRole('region', { name: 'Session details' })).toHaveCount(0);
  expect((await requests(page)).filter(m => m.type === 'getAgentGraph')).toHaveLength(1);
  await dashboard.getByRole('button', { name: 'Back to conversation' }).click();
  await expect(dashboard).toHaveCount(0); await expect(page.getByPlaceholder('Ask Argus')).toBeVisible();
});

test('browser view entry, exit and history preserve session opening and shared goals', async ({ page }) => {
  await setup(page); await sync(page);
  await page.getByRole('button', { name: 'Agent dashboard', exact: true }).click();
  await expect(page).toHaveURL(/view=agents/);
  await page.getByRole('button', { name: 'Company goals', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Company goals' })).toContainText('Inventory delivery');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Open Stock worker', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Agent dashboard' })).toHaveCount(0);
  expect((await requests(page)).filter(m => m.type === 'resumeSession').at(-1)?.id).toBe('child');
  expect(new URL(page.url()).searchParams.has('view')).toBe(false);
  await page.goBack(); await expect(page.getByRole('main', { name: 'Agent dashboard' })).toBeVisible();
  expect((await requests(page)).filter(m => m.type === 'getAgentGraph')).toHaveLength(1);
});

test('direct entry has explicit loading, Retry and empty states', async ({ page }) => {
  await setup(page); await page.goto('/?mock=1&view=agents');
  const dashboard = page.getByRole('main', { name: 'Agent dashboard' });
  await expect(dashboard).toBeVisible(); await expect(dashboard).toContainText('Loading agents');
  const query = (await requests(page)).filter(m => m.type === 'getAgentGraph').at(-1);
  await emit(page, { type: 'agentGraph', requestId: query.requestId, ok: false });
  await expect(dashboard.getByRole('alert')).toContainText('unavailable');
  await dashboard.getByRole('button', { name: 'Retry agents' }).click();
  await sync(page, { ...snapshot(), nodes: [], edges: [], scopes: [] });
  await expect(dashboard).toContainText('No agents yet');
});

test('dashboard remains readable, keyboard reachable and bounded in dark and light at supported widths', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await setup(page); const value = snapshot(); value.nodes.push({ ...node('dispatch', 'Dispatch verification with a complete descriptive title'), company: 'dispatch', goal: 'routes', live: false, status: null } as any);
  await sync(page, value); await page.getByRole('button', { name: 'Agent dashboard', exact: true }).click();
  const dashboard = page.getByRole('main', { name: 'Agent dashboard' });
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await page.evaluate(() => {
      const style = document.documentElement.style;
      for (const [key, value] of Object.entries({ '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#24292d', '--vscode-sideBar-background': '#f1f3f5', '--vscode-input-background': '#e8ecef', '--vscode-input-foreground': '#24292d', '--vscode-descriptionForeground': '#48545d', '--vscode-panel-border': '#68737b', '--vscode-button-background': '#175c80', '--vscode-button-foreground': '#ffffff', '--vscode-focusBorder': '#005f91' })) style.setProperty(key, value);
    });
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const button = dashboard.getByRole('button', { name: 'Inspect Stock worker', exact: true });
      await button.focus(); await expect(button).toBeFocused(); await page.keyboard.press('Enter');
      await expect(dashboard.getByRole('region', { name: 'Session details' })).toContainText('Stock worker');
      const geometry = await dashboard.evaluate(element => ({ overflow: document.documentElement.scrollWidth > innerWidth, focus: getComputedStyle(document.activeElement!).outlineStyle, color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
      expect(geometry.overflow).toBe(false); expect(geometry.focus).not.toBe('none');
      const contrast = await dashboard.evaluate(element => {
        const rgb = (s: string) => s.match(/\d+/g)!.slice(0, 3).map(Number);
        const lum = (s: string) => rgb(s).map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((a, b, i) => a + b * [.2126, .7152, .0722][i], 0);
        const style = getComputedStyle(element), a = lum(style.color), b = lum(style.backgroundColor); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      });
      expect(contrast).toBeGreaterThanOrEqual(4.5);
      await dashboard.evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: test.info().outputPath(`dashboard-${theme}-${width}.png`) });
      await dashboard.getByRole('region', { name: 'Session details' }).screenshot({ path: test.info().outputPath(`dashboard-details-${theme}-${width}.png`) });
    }
  }
  expect(errors).toEqual([]);
});
