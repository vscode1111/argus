const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-stats-'));
process.env.ARGUS_CONFIG = path.join(root, 'config.json');
const legacyFile = path.join(root, 'session-stats.jsonl');
fs.writeFileSync(legacyFile, JSON.stringify({
  id: 'legacy-request', sessionId: 'legacy-session', workspacePath: root,
  providerId: 'provider-one', model: 'sample-model', startedAt: 1000, endedAt: 1200,
  durationMs: 200, inputTokens: 7, outputTokens: 3, outcome: 'success',
}) + '\n');
const { createSessionState } = require('../out/backend/sessionState');
const { beginRequest, noteRequestEvent, noteClaudeUsage, noteCodexUsage, readRequestStats, setSessionTaskKey, readSessionTaskKey, readSessionTaskKeys, deleteSessionStats, closeStatsDatabase } = require('../out/backend/sessionStats');
after(() => { closeStatsDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

test('legacy records migrate once and remain available after reopening', () => {
  assert.equal(readRequestStats('legacy-session')[0].inputTokens, 7);
  closeStatsDatabase();
  assert.equal(readRequestStats('legacy-session').length, 1);
  deleteSessionStats('legacy-session');
  closeStatsDatabase();
  assert.equal(readRequestStats('legacy-session').length, 0);
});

test('task key is optional, normalized, searchable, and can be cleared', () => {
  assert.equal(readSessionTaskKey('session-one'), null);
  assert.equal(setSessionTaskKey('session-without-requests', 'scsol-29'), 'SCSOL-29');
  assert.equal(readRequestStats('session-without-requests').length, 0);
  assert.equal(setSessionTaskKey('session-one', ' scsol-29 '), 'SCSOL-29');
  closeStatsDatabase();
  assert.equal(readSessionTaskKey('session-one'), 'SCSOL-29');
  assert.equal(readSessionTaskKeys()['session-one'], 'SCSOL-29');
  assert.throws(() => setSessionTaskKey('session-one', 'invalid key'), /issue key/);
  assert.equal(setSessionTaskKey('session-one', ''), null);
  assert.equal(readSessionTaskKey('session-one'), null);
});

function state(sessionId, providerId = 'provider-one') {
  const value = createSessionState(root);
  value.sessionId = sessionId;
  value.selection = { providerId, model: 'sample-model', effort: '', thinking: true };
  return value;
}

test('completed requests persist per turn with exact deduplicated usage and workspace', () => {
  const current = state('session-one');
  noteRequestEvent(current, { type: 'message', message: { role: 'user' } });
  noteClaudeUsage(current, 'response-one', 12, 4);
  noteClaudeUsage(current, 'response-one', 12, 4);
  noteClaudeUsage(current, 'response-two', 8, 3);
  noteRequestEvent(current, { type: 'done' });
  noteRequestEvent(current, { type: 'done' });
  const records = readRequestStats('session-one');
  assert.equal(records.length, 1);
  assert.equal(records[0].workspacePath, root);
  assert.equal(records[0].providerId, 'provider-one');
  assert.equal(records[0].model, 'sample-model');
  assert.equal(records[0].inputTokens, 20);
  assert.equal(records[0].outputTokens, 7);
  assert.equal(records[0].outcome, 'success');
  assert.ok(records[0].durationMs >= 0);
});

test('second request and interrupted request remain distinct', () => {
  const current = state('session-one', 'provider-two');
  noteRequestEvent(current, { type: 'message', message: { role: 'user' } });
  noteCodexUsage(current, 14, 5);
  noteCodexUsage(current, 14, 5);
  noteCodexUsage(current, 25, 9);
  noteRequestEvent(current, { type: 'done' });
  noteRequestEvent(current, { type: 'message', message: { role: 'user' } });
  noteRequestEvent(current, { type: 'done', interrupted: true });
  const records = readRequestStats('session-one');
  assert.equal(records.length, 3);
  assert.deepEqual(records[1].inputTokens, 25);
  assert.deepEqual(records[1].outputTokens, 9);
  assert.equal(records[2].outcome, 'stopped');
  assert.equal(records[2].inputTokens, null);
  assert.equal(readRequestStats('other-session').length, 0);
});

test('background turns without a user request create no record', () => {
  const current = state('background-session');
  noteClaudeUsage(current, 'response-three', 2, 1);
  noteRequestEvent(current, { type: 'done', autonomous: true });
  assert.equal(readRequestStats('background-session').length, 0);
});

test('a manual retry is a separate request without another user bubble', () => {
  const current = state('retry-session');
  beginRequest(current);
  noteRequestEvent(current, { type: 'done' });
  assert.equal(readRequestStats('retry-session').length, 1);
});

test('native provider totals count two model requests and ignore a repeated update', async () => {
  const { CodexSession } = require('../out/backend/providers/codex');
  const { AppServerRpc } = require('../out/backend/providers/rpc');
  const current = state(undefined, 'provider-two');
  current.broadcast = message => noteRequestEvent(current, JSON.parse(message));
  const rpc = new AppServerRpc(process.execPath, [path.join(__dirname, 'fixtures/scub-provider-server.cjs')]);
  const runtime = new CodexSession(current, rpc, async () => {});
  try {
    await runtime.send({ text: 'multi-usage' });
    const deadline = Date.now() + 3000;
    while (runtime.active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runtime.active, false);
    const records = readRequestStats(current.sessionId);
    assert.equal(records.length, 1);
    assert.equal(records[0].inputTokens, 230);
    assert.equal(records[0].outputTokens, 13);
  } finally {
    runtime.dispose();
  }
});

test('the browser retrieves a persisted record through the server', async () => {
  const { chromium } = require('@playwright/test');
  const { startServer } = require('../out/backend/index');
  const sessionId = '11111111-1111-1111-1111-111111111111';
  const current = state(sessionId);
  noteRequestEvent(current, { type: 'message', message: { role: 'user' } });
  noteClaudeUsage(current, 'response-browser', 42, 9);
  noteRequestEvent(current, { type: 'done' });
  process.env.ARGUS_USAGE_POLL = '0';
  const server = await startServer({ port: 0 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.getByRole('button', { name: 'Session history' }).click();
    await page.evaluate(id => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'sessionList', sessions: [{ id, title: 'Planning session', lastPrompt: 'Plan the route', updatedAt: Date.now(), lines: 2 }],
    } })), sessionId);
    await page.getByRole('dialog', { name: 'Session History' }).getByRole('button', { name: 'Session statistics' }).click();
    const dialog = page.getByRole('dialog', { name: 'Session statistics' });
    await dialog.getByRole('row', { name: /42 9 success/ }).waitFor();
    assert.match(await dialog.textContent(), /Completed requests/);
    await dialog.getByRole('textbox', { name: 'Issue key' }).fill('scsol-29');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog', { name: 'Session History' }).getByText('SCSOL-29').waitFor();
    assert.equal(readSessionTaskKey(sessionId), 'SCSOL-29');
    await dialog.getByRole('textbox', { name: 'Issue key' }).fill('');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog', { name: 'Session History' }).getByText('SCSOL-29').waitFor({ state: 'detached' });
    assert.equal(readSessionTaskKey(sessionId), null);
  } finally {
    await browser.close();
    server.close();
  }
});
