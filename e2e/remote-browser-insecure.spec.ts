import { test, expect, chromium } from '@playwright/test';
import * as fs from 'node:fs';
const { privateQuestionServer } = require('./fixtures/private-question-server.cjs');

test('browser chat and graph survive reload and reconnect on an insecure HTTP origin', async () => {
  const server = await privateQuestionServer();
  const config = JSON.parse(fs.readFileSync(server.config, 'utf8'));
  config.allowNetworkAccess = true; config.allowedOrigins = 'inventory.test';
  fs.writeFileSync(server.config, JSON.stringify(config));
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP inventory.test 127.0.0.1', '--no-proxy-server'] });
  const page = await browser.newPage();
  const errors: string[] = [], requests: string[] = [];
  const snapshots: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    socket.on('framesent', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === 'getAgentGraph') requests.push(message.requestId);
    });
    socket.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === 'agentGraph' && message.ok && message.snapshot) snapshots.push(message.requestId);
    });
  });
  try {
    for (let load = 0; load < 3; load++) {
      const before = requests.length;
      if (load) await page.reload(); else await page.goto(`http://inventory.test:${server.info.port}/`);
      expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID }))).toEqual({ secure: false, uuid: 'undefined' });
      await expect(page.getByPlaceholder('Ask Argus')).toBeVisible();
      await expect(page.getByTitle('Connected', { exact: true })).toBeVisible();
      await expect.poll(() => requests.length).toBeGreaterThan(before);
      await expect.poll(() => snapshots.includes(requests[before])).toBe(true);
      expect(errors).toEqual([]);
    }
    const previous = requests.at(-1), before = requests.length;
    await page.evaluate(() => (window as any).argusReconnect());
    await expect.poll(() => requests.length).toBeGreaterThan(before);
    expect(requests.at(-1)).not.toBe(previous);
    await expect.poll(() => snapshots.includes(requests[before])).toBe(true);
    await expect(page.getByPlaceholder('Ask Argus')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.close(); }
});
