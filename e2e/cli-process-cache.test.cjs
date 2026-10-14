const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

const originalExecFile = childProcess.execFile;
const pending = [];
childProcess.execFile = (_command, _args, _options, callback) => { pending.push(callback); };
const { listCliProcesses, invalidateProcessSamples, resetProcessSamples } = require('../out/backend/processes');
after(() => { childProcess.execFile = originalExecFile; });

const owned = { owned: new Map() };

test('a stop invalidates a completed process sample', async () => {
  resetProcessSamples();
  const first = listCliProcesses(owned);
  assert.equal(pending.length, 1);
  pending.shift()(null, '[]');
  await first;
  await listCliProcesses(owned);
  assert.equal(pending.length, 0, 'ordinary callers share the cached sample');

  await invalidateProcessSamples();
  const refreshed = listCliProcesses(owned);
  assert.equal(pending.length, 1, 'the next list must read the OS again');
  pending.shift()(null, '[]');
  await refreshed;
});

test('a stop waits for an older in-flight sample before invalidating it', async () => {
  resetProcessSamples();
  const oldList = listCliProcesses(owned);
  assert.equal(pending.length, 1);
  const invalidated = invalidateProcessSamples();
  pending.shift()(null, '[]');
  await oldList;
  await invalidated;

  const freshList = listCliProcesses(owned);
  assert.equal(pending.length, 1, 'the old reply must not become the post-stop cache');
  pending.shift()(null, '[]');
  await freshList;
});
