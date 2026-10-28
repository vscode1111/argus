const { test } = require('node:test');
const assert = require('node:assert/strict');
const { latestPage, sendEarlierPage } = require('../out/backend/sessionPages');

test('initial page includes recent context around a large attachment', () => {
  const messages = [
    { id: 'earlier', role: 'user', content: 'Earlier detail' },
    { id: 'context', role: 'assistant', content: 'Context detail' },
    { id: 'attachment', role: 'user', content: 'Attachment', images: [{ mediaType: 'image/png', data: 'a'.repeat(480_000) }] },
    { id: 'summary', role: 'assistant', content: 'Recent summary' },
  ];
  const first = latestPage(messages);
  assert.deepEqual(first.messages.map(message => message.id), ['context', 'attachment', 'summary']);
  assert.equal(first.before, 1);
  const replies = [];
  sendEarlierPage({ send: data => replies.push(JSON.parse(data)) }, 'history-session', messages, first.before);
  assert.deepEqual(replies[0].messages.map(message => message.id), ['earlier']);
  sendEarlierPage({ send: data => replies.push(JSON.parse(data)) }, 'history-session', messages, first.before, 7, true);
  assert.equal(replies[1].prefetch, true);
  assert.equal(replies[1].revision, 7);
  assert.deepEqual(replies[1].messages.map(message => message.id), ['earlier']);
});

test('initial page keeps the transfer bounded when an attachment exceeds the ceiling', () => {
  const messages = [
    { id: 'earlier', role: 'user', content: 'Earlier detail' },
    { id: 'attachment', role: 'user', content: 'Attachment', images: [{ mediaType: 'image/png', data: 'a'.repeat(600_000) }] },
    { id: 'summary', role: 'assistant', content: 'Recent summary' },
  ];
  assert.deepEqual(latestPage(messages).messages.map(message => message.id), ['summary']);
});
