const { test } = require('node:test');
const assert = require('node:assert/strict');
const { providerForSession } = require('../out/backend/providers/registry');
const { loadSessionHistory } = require('../out/backend/sessionHistory');

test('initial batches share a scoped reader and release it before continuation', async () => {
  const provider = providerForSession('delivery-history');
  const original = provider.loadPage;
  const originalScope = provider.withHistoryReader;
  let opened = 0, closed = 0, reads = 0, continuations = 0;
  provider.loadPage = async () => { continuations++; return { messages: [] }; };
  provider.withHistoryReader = async (_id, _cwd, action) => {
    opened++;
    try { return await action(async (cursor = 0) => {
      reads++;
      return { messages: [{ id: `delivery-${cursor}`, role: 'user', content: 'Delivery detail' }], cursor: cursor + 1 };
    }); } finally { closed++; }
  };
  try {
    const page = await loadSessionHistory('delivery-history', 'D:/deliveries');
    assert.equal(opened, 1);
    assert.equal(closed, 1);
    assert.equal(reads, 5);
    assert.equal(continuations, 0);
    await page.source.load(page.source.cursor);
    assert.equal(continuations, 1);
    provider.withHistoryReader = async (_id, _cwd, action) => {
      try { return await action(async () => { throw new Error('History unavailable'); }); }
      finally { closed++; }
    };
    await assert.rejects(loadSessionHistory('delivery-history', 'D:/deliveries'), /History unavailable/);
    assert.equal(closed, 2);
  } finally { provider.loadPage = original; provider.withHistoryReader = originalScope; }
});

test('initial history reads five recent batches; subsequent requests read one', async () => {
  const id = 'delivery-history';
  const provider = providerForSession(id);
  const original = provider.loadPage;
  const calls = [];
  provider.loadPage = async (_id, _cwd, cursor = 0) => {
    calls.push(cursor);
    return { messages: [{ id: `delivery-${cursor}`, role: 'user', content: `Delivery ${cursor}` }],
      cursor: cursor + 1, turnId: `turn-${cursor}`, previousTurnCursor: cursor + 1 };
  };
  try {
    const page = await loadSessionHistory(id, 'D:/deliveries');
    assert.equal(calls.length, 5);
    assert.deepEqual(page.messages.map(message => message.id), ['delivery-4', 'delivery-3', 'delivery-2', 'delivery-1', 'delivery-0']);
    assert.equal(page.source.cursor, 5);
    assert.equal(page.source.turnId, 'turn-0');
    await page.source.load(page.source.cursor);
    assert.deepEqual(calls, [0, 1, 2, 3, 4, 5]);
  } finally { provider.loadPage = original; }
});

test('initial batches stop at the beginning of history', async () => {
  const provider = providerForSession('delivery-history');
  const original = provider.loadPage;
  let calls = 0;
  provider.loadPage = async (_id, _cwd, cursor = 0) => {
    calls++;
    return { messages: [{ id: `delivery-${cursor}`, role: 'user', content: 'Delivery detail' }], cursor: cursor < 1 ? cursor + 1 : undefined };
  };
  try {
    const page = await loadSessionHistory('delivery-history', 'D:/deliveries');
    assert.equal(calls, 2);
    assert.equal(page.messages.length, 2);
    assert.equal(page.source.cursor, undefined);
  } finally { provider.loadPage = original; }
});
