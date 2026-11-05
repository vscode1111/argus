const { test } = require('node:test');
const assert = require('node:assert/strict');
const { latestPage, sendEarlierPage, sendInitialPage, sendProviderEarlierPage } = require('../out/backend/sessionPages');

test('initial browser reply contains five batches while older replies keep one', () => {
  const messages = Array.from({ length: 200 }, (_, index) => ({ id: `parcel-${index}`, role: 'user', content: `Parcel ${index}` }));
  const page = latestPage(messages);
  assert.equal(page.messages.length, 150);
  assert.equal(page.before, 50);
  const frames = [];
  sendEarlierPage({ send: raw => frames.push(JSON.parse(raw)) }, 'parcel-history', messages, page.before);
  assert.equal(frames[0].messages.length, 30);
  assert.equal(frames[0].before, 20);
});

test('initial response keeps five normal byte budgets of recent content', () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({ id: `parcel-${index}`, role: 'user', content: 'x'.repeat(120000) }));
  assert.equal(latestPage(messages).messages.length, 5);
});

test('initial page includes recent context around a large attachment', () => {
  const messages = [
    { id: 'earlier', role: 'user', content: 'Earlier detail' },
    { id: 'context', role: 'assistant', content: 'Context detail' },
    { id: 'attachment', role: 'user', content: 'Attachment', images: [{ mediaType: 'image/png', data: 'a'.repeat(480_000) }] },
    { id: 'summary', role: 'assistant', content: 'Recent summary' },
  ];
  const first = latestPage(messages);
  assert.deepEqual(first.messages.map(message => message.id), ['earlier', 'context', 'attachment', 'summary']);
  assert.equal(first.before, 0);
  const replies = [];
  sendEarlierPage({ send: data => replies.push(JSON.parse(data)) }, 'history-session', messages, 1);
  assert.deepEqual(replies[0].messages.map(message => message.id), ['earlier']);
  sendEarlierPage({ send: data => replies.push(JSON.parse(data)) }, 'history-session', messages, 1, 7, true);
  assert.equal(replies[1].prefetch, true);
  assert.equal(replies[1].revision, 7);
  assert.deepEqual(replies[1].messages.map(message => message.id), ['earlier']);
});

test('initial page keeps the transfer bounded when an attachment exceeds the ceiling', () => {
  const messages = [
    { id: 'earlier', role: 'user', content: 'Earlier detail' },
    { id: 'attachment', role: 'user', content: 'Attachment', images: [{ mediaType: 'image/png', data: 'a'.repeat(3_000_000) }] },
    { id: 'summary', role: 'assistant', content: 'Recent summary' },
  ];
  assert.deepEqual(latestPage(messages).messages.map(message => message.id), ['summary']);
});

test('provider pages prepend in order and reuse a cursor for concurrent requests', async () => {
  const frames = [];
  const socket = { send: raw => frames.push(JSON.parse(raw)) };
  let loads = 0;
  let finish;
  const source = { cursor: 'older', load: async cursor => {
    assert.equal(cursor, 'older'); loads++;
    await new Promise(resolve => { finish = resolve; });
    return { messages: [{ id: 'earlier', role: 'user', content: 'Earlier request' }] };
  } };
  sendInitialPage(socket, 'history-session', [{ id: 'recent', role: 'assistant', content: 'Latest reply' }], source);
  const before = frames[0].before;
  assert.equal(frames[0].hasMore, true);
  const first = sendProviderEarlierPage(socket, 'history-session', before, 2, true);
  const second = sendProviderEarlierPage(socket, 'history-session', before, 2);
  finish();
  await Promise.all([first, second]);
  assert.equal(loads, 1);
  for (const frame of frames.slice(1)) {
    assert.deepEqual(frame.messages.map(message => message.id), ['earlier']);
    assert.equal(frame.before, 0);
    assert.equal(frame.revision, 2);
  }
});

test('refresh discards an older page that finishes after the replay was replaced', async () => {
  const frames = [];
  const socket = { send: raw => frames.push(JSON.parse(raw)) };
  let finish;
  sendInitialPage(socket, 'history-session', [], { cursor: 'older', load: () => new Promise(resolve => { finish = resolve; }) });
  const pending = sendProviderEarlierPage(socket, 'history-session', frames[0].before, 1);
  sendInitialPage(socket, 'history-session', [{ id: 'fresh', role: 'user', content: 'Fresh request' }]);
  finish({ messages: [{ id: 'stale', role: 'assistant', content: 'Old reply' }] });
  await pending;
  assert.equal(frames.length, 2);
  assert.equal(frames[1].messages[0].id, 'fresh');
});
