const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-history-'));
process.env.ARGUS_CONFIG = path.join(dir, 'settings.json');
const { AppServerRpc } = require('../out/backend/providers/rpc');
const { codexProvider } = require('../out/backend/providers/codex');
const { saveSession, defaultSelection } = require('../out/backend/providers/store');
const { loadSessionHistory } = require('../out/backend/sessionHistory');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('provider shares one connection for initial pages and cleans up on failure', async () => {
  const id = `${codexProvider.descriptor.id}:delivery-history`;
  saveSession({ id, cwd: dir, title: 'Delivery history', updatedAt: 1, selection: defaultSelection(codexProvider.descriptor.id) });
  const prototype = AppServerRpc.prototype;
  const original = { start: prototype.start, request: prototype.request, dispose: prototype.dispose };
  let starts = 0, reads = 0;
  const disposed = [];
  prototype.start = async function () { starts++; };
  prototype.dispose = function (nonBlocking) { disposed.push(nonBlocking); };
  prototype.request = async function (method) {
    if (method === 'thread/turns/list') return { data: [{ id: 'delivery-turn', status: 'completed' }], nextCursor: null };
    reads++;
    return { data: [{ item: { id: `delivery-${reads}`, type: 'agentMessage', text: `Delivery ${reads}` } }], nextCursor: `page-${reads}` };
  };
  try {
    const page = await loadSessionHistory(id, dir);
    assert.equal(starts, 1);
    assert.equal(reads, 5);
    assert.equal(page.messages.length, 5);
    assert.deepEqual(disposed, [true]);
    await page.source.load(page.source.cursor);
    assert.equal(starts, 2);
    assert.equal(reads, 6);
    assert.deepEqual(disposed, [true, true]);
    prototype.request = async () => { throw new Error('History unavailable'); };
    await assert.rejects(loadSessionHistory(id, dir), /History unavailable/);
    assert.deepEqual(disposed, [true, true, true]);
    await assert.rejects(loadSessionHistory(id, path.join(dir, 'other')), /does not belong/);
    assert.equal(starts, 3);
  } finally { Object.assign(prototype, original); }
});

test('history disposal schedules Windows tree cleanup once without waiting', { skip: process.platform !== 'win32' }, () => {
  const original = childProcess.execFile;
  const calls = [];
  childProcess.execFile = (...args) => { calls.push(args); };
  try {
    const rpc = new AppServerRpc(process.execPath);
    rpc.proc = { pid: 123456789 };
    rpc.dispose(true);
    rpc.dispose(true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'taskkill');
    assert.deepEqual(calls[0][1], ['/T', '/F', '/PID', '123456789']);
    assert.equal(calls[0][2].windowsHide, true);
    assert.equal(typeof calls[0][3], 'function');
  } finally { childProcess.execFile = original; }
});
