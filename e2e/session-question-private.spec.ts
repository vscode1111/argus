import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
const { privateQuestionServer } = require('./fixtures/private-question-server.cjs');

test('I5 private provider teardown leaves no actionable Ask surface live or on rejoin', async ({ page }) => {
  const server = await privateQuestionServer();
  try {
    const url = `http://127.0.0.1:${server.info.port}`;
    const served = await (await fetch(`${url}/webview.js`)).arrayBuffer();
    expect(createHash('sha256').update(Buffer.from(served)).digest('hex')).toBe(createHash('sha256').update(readFileSync(resolve(__dirname, '../media/webview.js'))).digest('hex'));
    await page.goto(`${url}/?dir=${encodeURIComponent(server.dir)}`);
    await page.getByPlaceholder('Ask Argus').fill('Check inventory.'); await page.getByPlaceholder('Ask Argus').press('Enter');
    await expect(page.getByRole('button', { name: 'Submit answers' })).toHaveCount(1);
    const id = new URL(page.url()).searchParams.get('session');
    const client = await server.connect(server.dir, id); client.send({ type: 'webviewReady' });
    await client.wait((f: any) => f.type === 'interaction' && f.request);
    client.send({ type: 'forceError' });
    await client.wait((f: any) => f.type === 'interaction_resolved' && f.reason === 'provider-resolved');
    await expect(page.getByRole('button', { name: 'Submit answers' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    const replayed = new Promise<void>(resolveReplay => page.on('websocket', socket => socket.on('framereceived', frame => {
      if (typeof frame.payload === 'string' && JSON.parse(frame.payload).type === 'sessionLoaded') resolveReplay();
    })));
    await page.reload(); await replayed;
    await expect(page.getByRole('button', { name: 'Submit answers' })).toHaveCount(0);
    server.verifySpawn();
  } finally { await page.goto('about:blank'); await server.close(); }
});

test('private served UI starts an observable turn, replays one question and answers in process', async ({ page }) => {
  const server = await privateQuestionServer();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const sockets: string[] = []; page.on('websocket', socket => sockets.push(new URL(socket.url()).origin));
  try {
    const url = `http://127.0.0.1:${server.info.port}`;
    const served = await (await fetch(`${url}/webview.js`)).arrayBuffer();
    expect(createHash('sha256').update(Buffer.from(served)).digest('hex')).toBe(createHash('sha256').update(readFileSync(resolve(__dirname, '../media/webview.js'))).digest('hex'));
    await page.goto(`${url}/?dir=${encodeURIComponent(server.dir)}&panel=inventory-browser`);
    await expect(page.getByPlaceholder('Ask Argus')).toBeVisible();
    await page.getByPlaceholder('Ask Argus').fill('Check inventory.'); await page.getByPlaceholder('Ask Argus').press('Enter');
    await expect(page.getByRole('button', { name: 'Submit answers' })).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Provider request' })).toHaveCount(0);
    const selectedId = new URL(page.url()).searchParams.get('session'); expect(selectedId).toBeTruthy();
    const producer = await server.connect(server.dir, selectedId); producer.send({ type: 'webviewReady' });
    const request = (await producer.wait((f: any) => f.type === 'interaction' && f.request)).request;
    const sessionId = selectedId;
    const observer = await server.connect(resolve(server.dir, 'observer'));
    observer.send({ type: 'watchSession', requestId: 'ui-observation', sessionId });
    const journal = await observer.wait((f: any) => f.type === 'sessionEvents' && f.requestId === 'ui-observation');
    expect(journal.ok).toBe(true); expect(journal.events.some((e: any) => e.kind === 'interaction' && e.data.id === request.id)).toBe(true);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Submit answers' })).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Provider request' })).toHaveCount(0);
    await page.getByText('Search', { exact: true }).click(); await page.getByRole('button', { name: 'Submit answers' }).click();
    await expect(page.getByText('Inventory checked.', { exact: true })).toBeVisible();
    server.verifySpawn(); expect(errors).toEqual([]);
    expect(sockets.length).toBeGreaterThan(1); expect(sockets.every(origin => origin === url.replace('http:', 'ws:'))).toBe(true);
  } finally { await page.goto('about:blank'); await server.close(); }
});
