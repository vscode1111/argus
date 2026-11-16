const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel');
const { attachClientHandlers } = require('../out/backend/session');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function bridgeHarness() {
  const connections = [];
  const frames = [], sent = [], timers = new Map();
  let clock = 0, timerId = 0;
  let nextUrl = 'ws://localhost:3017/agent?panel=inventory-panel&dir=D%3A%2Finventory';
  const window = { dispatchEvent(event) { frames.push(event.data); } };
  const document = { hidden: false, addEventListener() {} };
  class Socket {
    constructor(url) { this.url = url; connections.push(this); }
    close() {}
    send(data) { sent.push(JSON.parse(data)); }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../webview/public/ws-bridge.js'), 'utf8'), {
    window, document, WebSocket: Socket, URL,
    MessageEvent: class { constructor(type, options) { this.data = options.data; } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, console: { warn() {}, error() {} },
  });
  const bridge = window.createArgusBridge({ nextUrl: () => nextUrl });
  return { bridge, connections, frames, sent, window,
    setHidden(hidden) { document.hidden = hidden; },
    advance(duration) {
      const end = clock + duration;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]); clock = next[1].at; next[1].fn();
      }
      clock = end;
    },
    receive(data) { connections.at(-1).onmessage({ data: JSON.stringify(data) }); },
    setUrl(url) { nextUrl = url; } };
}

test('an open transport with no server replies stops reporting connected', () => {
  const h = bridgeHarness();
  h.connections[0].onopen();
  assert.equal(h.frames.at(-1).connected, true);
  h.advance(20000);
  assert.equal(h.frames.at(-1).connected, false, 'silent transport must not stay green');
  assert.equal(h.bridge.isReady(), false);
});

test('connection state is available before React subscribes to status events', () => {
  const h = bridgeHarness();
  assert.equal(h.window.argusConnectionState?.().connected, false);
  h.connections[0].onopen();
  assert.equal(h.window.argusConnectionState().connected, true);
});

test('server replies and streaming frames keep a quiet connection healthy', () => {
  const h = bridgeHarness();
  h.connections[0].onopen();
  for (let i = 0; i < 3; i++) {
    h.advance(10000);
    assert.equal(h.sent.at(-1).type, 'getBgTasks');
    h.receive({ type: 'bgTasks', count: 0 });
    assert.equal(h.bridge.isReady(), true);
  }
  for (let i = 0; i < 5; i++) { h.advance(9000); h.receive({ type: 'text_chunk', text: 'Inventory checked.' }); }
  assert.equal(h.sent.length, 3, 'active traffic needs no extra probe');
  assert.equal(h.window.argusConnectionState().connected, true);
});

test('health timeout reconnects with the conversation and retires old socket callbacks', () => {
  const h = bridgeHarness();
  const id = randomUUID();
  h.connections[0].onopen();
  h.receive({ type: 'sessionId', id });
  h.advance(21000);
  assert.equal(h.connections.length, 2);
  assert.equal(h.connections[0].onmessage, null);
  assert.equal(new URL(h.connections[1].url).searchParams.get('session'), id);
  h.connections[1].onopen();
  assert.equal(h.window.argusConnectionState().connected, true);
});

test('reconnect requests missed conversation output before flushing queued input', () => {
  const h = bridgeHarness();
  h.connections[0].onopen();
  h.receive({ type: 'sessionId', id: randomUUID() });
  h.connections[0].onclose({ code: 1006 });
  h.bridge.post({ type: 'send', text: 'Check the inventory totals.' });
  h.advance(1000);
  h.connections[1].onopen();
  assert.deepEqual(h.sent.map(frame => frame.type), ['webviewReady', 'send']);
});

for (const code of [4001, 4002]) {
  test(`health timers cannot revive an intentionally closed socket (${code})`, () => {
    const h = bridgeHarness();
    h.connections[0].onopen();
    // Hide an idle client so its normal visibility-driven recovery also stays down.
    h.setHidden(true);
    h.connections[0].onclose({ code });
    h.advance(60000);
    assert.equal(h.sent.length, 0);
    assert.equal(h.connections.length, 1);
    assert.equal(h.window.argusConnectionState().connected, false);
  });
}

test('panel reconnect restores its displayed conversation after the server loses its registry', () => {
  const { bridge, connections, receive } = bridgeHarness();
  const id = randomUUID();
  const dir = `D:/sessions/${randomUUID()}`;
  const channel = getOrCreateChannel(dir);
  const original = new EventEmitter(); original.readyState = 1; original.send = () => {};
  attachClientHandlers(original, channel, 'default', { panelId: 'inventory-panel' });
  channel.getClientState(original).sessionId = id;
  receive({ type: 'sessionId', id });
  original.emit('close'); destroyChannel(dir);
  bridge.reconnectNow();
  const query = new URL(connections.at(-1).url).searchParams;
  const replacement = getOrCreateChannel(dir);
  const socket = new EventEmitter(); socket.readyState = 1; socket.send = () => {};
  try {
    attachClientHandlers(socket, replacement, 'default', { panelId: query.get('panel'), sessionId: query.get('session') || undefined });
    assert.equal(replacement.getClientState(socket).sessionId, id, 'follow-up must resume the displayed conversation');
  } finally { socket.emit('close'); destroyChannel(dir); }
});

test('reconnect follows the displayed history selection and keeps refreshed connection parameters', () => {
  const h = bridgeHarness();
  const original = randomUUID(), selected = randomUUID();
  h.receive({ type: 'sessionId', id: original });
  h.receive({ type: 'sessionLoaded', id: selected, messages: [] });
  h.setUrl('ws://localhost:3018/agent?panel=inventory-panel&dir=D%3A%2Finventory&nonce=renewed');
  h.bridge.reconnectNow();
  const target = new URL(h.connections.at(-1).url);
  assert.equal(target.searchParams.get('session'), selected);
  assert.equal(target.port, '3018');
  assert.equal(target.searchParams.get('nonce'), 'renewed');
});

test('new conversation clears a stale host deep link on reconnect', () => {
  const h = bridgeHarness();
  const id = randomUUID();
  h.setUrl(`ws://localhost:3017/agent?panel=inventory-panel&dir=D%3A%2Finventory&session=${id}`);
  h.receive({ type: 'sessionId', id });
  h.receive({ type: 'clear' });
  h.bridge.reconnectNow();
  assert.equal(new URL(h.connections.at(-1).url).searchParams.has('session'), false);
});

for (const request of [{ type: 'newSession' }, { type: 'send', text: '/clear' }]) {
  test(`explicit ${request.type} clears identity even if disconnected before acknowledgement`, () => {
    const h = bridgeHarness();
    h.receive({ type: 'sessionId', id: randomUUID() });
    h.bridge.post(request);
    h.bridge.reconnectNow();
    assert.equal(new URL(h.connections.at(-1).url).searchParams.has('session'), false);
  });
}

test('workspace switch does not carry the previous conversation into another workspace', () => {
  const h = bridgeHarness();
  h.receive({ type: 'sessionId', id: randomUUID() });
  h.setUrl('ws://localhost:3017/agent?panel=inventory-panel&dir=D%3A%2Fshipping');
  h.bridge.reconnectNow();
  assert.equal(new URL(h.connections.at(-1).url).searchParams.has('session'), false);
});

test('an initial explicit deep link survives before the first server frame', () => {
  const h = bridgeHarness();
  const id = randomUUID();
  h.setUrl(`ws://localhost:3017/agent?session=${id}`);
  h.bridge.reconnectNow();
  assert.equal(new URL(h.connections.at(-1).url).searchParams.get('session'), id);
});

test('refresh cannot select a different conversation', async () => {
  const dir = `D:/sessions/${randomUUID()}`;
  const currentId = randomUUID();
  const otherId = randomUUID();
  const frames = [];
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = data => frames.push(JSON.parse(data));
  const channel = getOrCreateChannel(dir);
  try {
    attachClientHandlers(socket, channel, 'default', { panelId: 'current-panel' });
    channel.getClientState(socket).sessionId = currentId;
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'refreshSession', id: otherId })));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(channel.getClientState(socket).sessionId, currentId);
    assert.deepEqual(frames.find(frame => frame.type === 'sessionRefreshRejected'), {
      type: 'sessionRefreshRejected', requestedId: otherId, currentId,
    });
    assert.equal(frames.some(frame => frame.type === 'sessionLoaded' && frame.id === otherId), false);
  } finally {
    socket.emit('close');
    destroyChannel(dir);
  }
});
