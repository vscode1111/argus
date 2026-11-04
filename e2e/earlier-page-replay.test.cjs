const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel');
const { attachClientHandlers } = require('../out/backend/session');
const { providerForSession } = require('../out/backend/providers/registry');
const { sendInitialPage } = require('../out/backend/sessionPages');

test('earlier pages reuse the client replay, including after refresh and live attach', async () => {
  const dir = `D:/sessions/${randomUUID()}`;
  const id = randomUUID();
  const messages = Array.from({ length: 100 }, (_, index) => ({ id: `message-${index}`, role: 'user', content: `Entry ${index}` }));
  const channel = getOrCreateChannel(dir);
  const socket = new EventEmitter();
  const otherSocket = new EventEmitter();
  socket.readyState = 1;
  const frames = [];
  socket.send = data => frames.push(JSON.parse(data));
  const provider = providerForSession(id);
  const original = provider.load;
  let reads = 0;
  provider.load = async () => { reads++; return []; };
  async function earlier(before, revision) {
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'loadEarlier', id, before, revision })));
    await new Promise(resolve => setImmediate(resolve));
    return frames.at(-1);
  }
  try {
    attachClientHandlers(socket, channel, 'default');
    channel.getClientState(socket).sessionId = id;
    sendInitialPage(socket, id, messages);
    const initial = frames.at(-1);
    const page = await earlier(initial.before, 1);
    assert.equal(reads, 0, 'paging must not reload the provider transcript');
    assert.deepEqual(page.messages.map(m => m.id), messages.slice(page.before, initial.before).map(m => m.id));
    assert(page.messages.length > 0);
    const refreshed = messages.map(message => ({ ...message, content: 'Updated entry' }));
    sendInitialPage(socket, id, refreshed);
    assert((await earlier(frames.at(-1).before, 2)).messages.every(m => m.content === 'Updated entry'));
    channel.replayHistory(socket, messages);
    assert((await earlier(frames.at(-1).before, 3)).messages.every(m => m.content.startsWith('Entry ')));
    assert.equal(reads, 0);
    const count = frames.length;
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'loadEarlier', id: randomUUID(), before: 30, revision: 3 })));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.length, count, 'another session cannot read this replay');
    const otherFrames = [];
    otherSocket.readyState = 1;
    otherSocket.send = data => otherFrames.push(JSON.parse(data));
    attachClientHandlers(otherSocket, channel, 'default', { fresh: true });
    channel.getClientState(otherSocket).sessionId = id;
    otherSocket.emit('message', Buffer.from(JSON.stringify({ type: 'loadEarlier', id, before: initial.before, revision: 1 })));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1, 'a client without a replay loads its own transcript');
    assert.deepEqual(otherFrames.at(-1).messages, []);
  } finally {
    provider.load = original;
    socket.emit('close'); otherSocket.emit('close'); destroyChannel(dir);
  }
});
