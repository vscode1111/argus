const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { sessionFilePath } = require('../out/backend/sessions');

test('session info resolves the native transcript for a provider-prefixed session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-transcript-path-'));
  const previous = process.env.CODEX_HOME;
  const id = '01a0ec9c-8750-77d3-a880-a9314f3523cc';
  const file = path.join(root, 'sessions', '2026', '09', '29', `rollout-2026-09-29T12-00-00-${id}.jsonl`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
    process.env.CODEX_HOME = root;
    assert.equal(sessionFilePath(`codex:${id}`, root), file);
    assert.equal(sessionFilePath('codex:../outside', root), null);
    assert.equal(sessionFilePath('codex:01a0ec9c-8750-77d3-a880-a9314f3523cd', root), null);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server info returns the transcript path for the current provider session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-server-info-'));
  const previousHome = process.env.CODEX_HOME;
  const previousConfig = process.env.ARGUS_CONFIG;
  const previousPoll = process.env.ARGUS_USAGE_POLL;
  const id = '01a0ec9c-8750-77d3-a880-a9314f3523cc';
  const sessionId = `codex:${id}`;
  const file = path.join(root, 'sessions', '2026', '09', '29', `rollout-2026-09-29T12-00-00-${id}.jsonl`);
  let server;
  let socket;
  let browser;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
    process.env.CODEX_HOME = root;
    process.env.ARGUS_CONFIG = path.join(root, 'scub-settings.json');
    process.env.ARGUS_USAGE_POLL = '0';
    const { saveSession } = require('../out/backend/providers/store');
    const { startServer } = require('../out/backend/index');
    saveSession({ id: sessionId, cwd: root, title: 'scub-session', updatedAt: Date.now(),
      selection: { providerId: 'codex', model: 'scub-model', effort: '', thinking: true } });
    server = await startServer({ port: 0 });
    const url = new URL(`ws://127.0.0.1:${server.port}/agent`);
    url.searchParams.set('nonce', server.nonce);
    url.searchParams.set('dir', root);
    url.searchParams.set('session', sessionId);
    socket = new WebSocket(url);
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('scub-server-info timed out')), 3000);
      socket.on('open', () => socket.send(JSON.stringify({ type: 'getServerInfo' })));
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'serverInfo') { clearTimeout(timer); resolve(message); }
      });
      socket.on('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(info.sessionId, sessionId);
    assert.equal(info.sessionPath, file);
    if (process.env.ARGUS_BROWSER_CHECK === '1') {
      const { chromium } = require('@playwright/test');
      browser = await chromium.launch({ channel: 'chrome' });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/?session=${encodeURIComponent(sessionId)}`);
      await page.getByRole('button', { name: 'Settings' }).click();
      const dialog = page.getByRole('dialog', { name: 'Settings' });
      await dialog.getByRole('button', { name: 'Info' }).click();
      await dialog.getByTestId('session-path').getByText(file, { exact: true }).waitFor({ timeout: 5000 });
    }
  } finally {
    await browser?.close();
    socket?.terminate();
    server?.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.ARGUS_CONFIG; else process.env.ARGUS_CONFIG = previousConfig;
    if (previousPoll === undefined) delete process.env.ARGUS_USAGE_POLL; else process.env.ARGUS_USAGE_POLL = previousPoll;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
