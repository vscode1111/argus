const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require(path.resolve(__dirname, '../../../../node_modules/ws'));
const { chromium } = require(path.resolve(__dirname, '../../../../node_modules/playwright'));
const root = path.resolve(__dirname, '../../../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-idle-smoke-'));
const config = path.join(dir, 'settings.json');
fs.writeFileSync(config, JSON.stringify({ defaultProvider: 'codex',
  providerDefaults: { codex: { providerId: 'codex', model: 'gpt-6-sol', effort: '', thinking: true } },
  cliIdleTimeoutSec: 12, connectionIdleTimeoutSec: 0 }));
process.env.ARGUS_CONFIG = config;
process.env.ARGUS_USAGE_POLL = '0';
process.env.ARGUS_REAP_SWEEP_MS = '250';
const { startServer } = require(path.join(root, 'out/backend/index.js'));
const { destroyChannel } = require(path.join(root, 'out/backend/channel.js'));

(async () => {
  const server = await startServer({ port: 0 });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/agent?nonce=${server.nonce}&dir=${encodeURIComponent(dir)}`);
  const waiters = [];
  let browser;
  let error = false;
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'error') error = true;
    const i = waiters.findIndex(w => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
  });
  function next(type, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      const entry = { type, resolve: value => { clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(entry), 1); reject(new Error(`Timed out waiting for ${type}`)); }, timeoutMs);
      waiters.push(entry);
    });
  }
  function ask(type, reply) { const result = next(reply); ws.send(JSON.stringify({ type })); return result; }
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const done = next('done');
    ws.send(JSON.stringify({ type: 'send', text: 'Reply with scub-ready only.' }));
    await done;
    const info = await ask('getServerInfo', 'serverInfo');
    const first = await ask('listCliProcesses', 'cliProcessList');
    const owned = first.processes.filter(p => p.ours && p.sessionId?.startsWith('codex:'));
    const activityVisible = owned.some(p => typeof p.lastActivityAt === 'number');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/?dir=${encodeURIComponent(dir)}`);
    await page.getByPlaceholder('Ask Argus').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Info' }).click();
    const uiLaunchCount = Number(await settings.getByTestId('cli-launches').textContent());
    await settings.getByTestId('cli-launches').click();
    const processDialog = page.getByRole('dialog', { name: 'CLI processes' });
    const row = processDialog.locator(`[data-testid="cli-process-row"][data-pid="${owned[0]?.pid}"]`);
    await row.waitFor({ timeout: 10000 });
    const uiActivityVisible = (await row.locator('td').nth(4).textContent())?.trim() !== '-';
    await browser.close(); browser = undefined;
    let reaped = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const result = await ask('listCliProcesses', 'cliProcessList');
      if (!result.processes.some(p => owned.some(before => before.pid === p.pid))) { reaped = true; break; }
    }
    console.log(JSON.stringify({ error, launchCount: info.cliLaunchCount, uiLaunchCount, ownedAfterTurn: owned.length,
      activityVisible, uiActivityVisible, reaped, idleTimeoutSec: 12 }, null, 2));
    if (error || info.cliLaunchCount < 1 || uiLaunchCount < 1 || !owned.length || !activityVisible || !uiActivityVisible || !reaped) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    ws.close();
    destroyChannel(dir);
    server.close();
    const target = path.resolve(dir);
    const base = path.resolve(os.tmpdir()) + path.sep;
    if (!target.startsWith(base) || !path.basename(target).startsWith('scub-idle-smoke-')) throw new Error('Refusing to remove unexpected smoke directory');
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
