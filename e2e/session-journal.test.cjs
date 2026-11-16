const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = options => new (require('../out/backend/sessionJournal').SessionJournal)(options);
const emit = (journal, owner, id, event) => journal.observe(owner, id, event);
test('I1 live-owner eviction during one text event releases all dropped payload and timers', () => {
  let now = 0; const journal = store({ bytes: 4096, sessionBytes: 1000000, now: () => now }), a = {}, b = {};
  emit(journal, a, 'inventory', { type: 'thinking_start' }); now++;
  emit(journal, b, 'stock', { type: 'thinking_start' });
  emit(journal, a, 'inventory', { type: 'text_chunk', text: 'x'.repeat(100000) });
  const segment = journal.owners.get(a);
  assert.equal(journal.segments.has(segment.generation), false);
  assert.equal(segment.text.length, 0); assert.equal(segment.events.length, 0); assert.equal(segment.timer, undefined);
  assert.ok(journal.stats().bytes <= 4096); assert.equal(journal.read('inventory').reset, 'unavailable');
});
test('I2 ingestion does bounded linear work and preserves advancing UTF-8 chunks', () => {
  const journal = store(), owner = {}, input = 'x'.repeat(4000000) + '🙂é'.repeat(20000);
  const original = Buffer.byteLength; let scanned = 0;
  Buffer.byteLength = function(value, ...args) { if (typeof value === 'string') scanned += value.length; return original.call(this, value, ...args); };
  try { emit(journal, owner, 'inventory', { type: 'text_chunk', text: input }); emit(journal, owner, 'inventory', { type: 'done' }); }
  finally { Buffer.byteLength = original; }
  assert.ok(scanned < input.length * 32, `bounded byte-length work: ${scanned}`);
  let cursor, output = '';
  do { const page = journal.read('inventory', cursor); output += page.events.filter(e => e.kind === 'text').map(e => e.data.text).join(''); cursor = page.next; if (!page.hasMore) break; } while (true);
  assert.equal(output, input);
});
test('I3 fresh epochs and forgotten tombstones reset valid cursors while no-cursor unknown errors', () => {
  const first = store(); emit(first, {}, 'inventory', { type: 'done' }); const cursor = first.read('inventory').next;
  const fresh = store(); const reset = fresh.read('inventory', cursor);
  assert.equal(reset.reset, 'epoch'); assert.equal(reset.next.epoch, fresh.epoch); assert.equal(reset.next.seq, 0);
  assert.throws(() => fresh.read('inventory'), /unknown_session/);
  let now = 0; const journal = store({ now: () => now, ttl: 1, tombstones: 1 });
  emit(journal, {}, 'inventory', { type: 'done' }); const old = journal.read('inventory').next;
  now++; emit(journal, {}, 'stock', { type: 'done' }); now++; emit(journal, {}, 'totals', { type: 'done' });
  assert.equal(journal.read('inventory', old).reset, 'unavailable'); assert.throws(() => journal.read('inventory'), /unknown_session/);
});
test('sealed text is immutable; pages resume at last delivered seq and compact output is genuinely compact', () => {
  const journal = store({ pageEvents: 2 }), owner = {};
  emit(journal, owner, 'inventory', { type: 'thinking_start' });
  emit(journal, owner, 'inventory', { type: 'text_chunk', text: 'First ' });
  emit(journal, owner, 'inventory', { type: 'text_chunk', text: 'second.' });
  emit(journal, owner, 'inventory', { type: 'tool_end', call: { id: 'check', name: 'Shell', result: 'Inventory totals', exitCode: 3, outcome: 'failure' } });
  const first = journal.read('inventory');
  assert.deepEqual(first.events.map(e => e.kind), ['start', 'text']); assert.equal(first.hasMore, true);
  assert.equal(first.next.seq, first.events.at(-1).seq);
  const serialized = JSON.stringify(first);
  emit(journal, owner, 'inventory', { type: 'text_chunk', text: 'Third.' });
  emit(journal, owner, 'inventory', { type: 'done' });
  assert.equal(JSON.stringify(first), serialized, 'published records never mutate');
  const second = journal.read('inventory', first.next);
  assert.deepEqual(second.events.map(e => e.kind), ['tool-end', 'text']);
  assert.equal(second.events[0].output, undefined);
  const full = journal.read('inventory', first.next, true);
  assert.equal(full.events[0].output.text, 'Inventory totals'); assert.equal(full.events[0].data.exitCode, 3);
});
test('pre-ID binding, rebind, clear, cold recreation, unknown/empty/unavailable and producer-based TTL are distinct', () => {
  let now = 0; const journal = store({ now: () => now, ttl: 100 }), owner = {};
  assert.throws(() => journal.read('unknown'), /unknown_session/);
  emit(journal, owner, undefined, { type: 'thinking_start' });
  emit(journal, owner, 'inventory', { type: 'sessionId', id: 'inventory' });
  const first = journal.read('inventory'); assert.equal(first.events[0].kind, 'start');
  now = 50; journal.read('inventory'); now = 101;
  assert.equal(journal.read('inventory', first.next).reset, 'unavailable', 'reading cannot renew production TTL');
  emit(journal, owner, 'inventory', { type: 'thinking_start' });
  assert.equal(journal.read('inventory', first.next).reset, 'generation');
  const current = journal.read('inventory');
  emit(journal, owner, undefined, { type: 'clear' });
  emit(journal, owner, 'stock', { type: 'sessionId', id: 'stock' });
  assert.equal(journal.read('stock').events.length, 0);
  emit(journal, {}, 'inventory', { type: 'thinking_start' });
  assert.equal(journal.read('inventory', current.next).reset, 'generation');
  assert.throws(() => journal.read('stock', { epoch: 1, seq: -1 }), /invalid_cursor/);
});
test('overflow resets only readers missing a required range; future/restart cursors reset explicitly', () => {
  const journal = store({ events: 3 }), owner = {};
  emit(journal, owner, 'inventory', { type: 'thinking_start' });
  const old = journal.read('inventory').next;
  for (let i = 0; i < 4; i++) emit(journal, owner, 'inventory', { type: 'tool_start', call: { id: String(i), name: 'Read' } });
  assert.equal(journal.read('inventory', old).reset, 'overflow');
  const recent = journal.read('inventory').next;
  emit(journal, owner, 'inventory', { type: 'tool_start', call: { id: 'next', name: 'Read' } });
  assert.equal(journal.read('inventory', recent).reset, null);
  assert.equal(journal.read('inventory', { ...recent, seq: 100 }).reset, 'future');
  assert.equal(journal.read('inventory', { ...recent, epoch: 'previous' }).reset, 'epoch');
});
test('all retained fields and serialized pages are bounded, oversized events advance and secrets/reasoning/raw input are excluded', () => {
  const journal = store(), owner = {};
  const huge = 'x'.repeat(400000);
  emit(journal, owner, 'inventory', { type: 'thinking_chunk', text: 'private reasoning' });
  emit(journal, owner, 'inventory', { type: 'tool_end', call: { id: 'check', name: 'Shell', input: { env: { privateValue: huge } }, result: huge } });
  emit(journal, owner, 'inventory', { type: 'interaction', request: { id: 'question', kind: 'question', title: huge,
    questions: Array.from({ length: 500 }, () => ({ id: huge, question: huge, options: [huge] })) } });
  const page = journal.read('inventory', undefined, true);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
  assert.equal(page.events[0].output.truncated, true); assert.equal(page.events[0].output.originalBytes, huge.length);
  assert.ok(Buffer.byteLength(page.events[0].output.text) <= 65536);
  assert.ok(!JSON.stringify(page).includes('privateValue')); assert.ok(!JSON.stringify(page).includes('private reasoning'));
  assert.ok(page.next.seq > 0);
});
test('aggregate eviction and bounded tombstones do not keep unbounded empty sessions', () => {
  const journal = store({ bytes: 4096, sessionBytes: 2048, segments: 4, tombstones: 4 });
  for (let i = 0; i < 40; i++) emit(journal, {}, `stock-${i}`, { type: 'tool_end', call: { id: 'check', result: 'x'.repeat(1000) } });
  assert.ok(journal.stats().bytes <= 4096); assert.ok(journal.stats().segments <= 4); assert.ok(journal.stats().tombstones <= 4);
});
test('truncation in nested question fields is explicit and an unrelated session cannot wake a wait', async () => {
  const journal = store(), owner = {};
  emit(journal, owner, 'inventory', { type: 'interaction', request: { id: 'question', kind: 'question', title: 'Section',
    questions: [{ id: 'section', question: 'x'.repeat(2000), options: Array.from({ length: 33 }, () => 'Stock') }] } });
  assert.equal(journal.read('inventory').events[0].data.truncated, true);
  let settled = false;
  const waiting = journal.watch('inventory', journal.read('inventory').next, false, 0.04).then(page => { settled = true; return page; });
  emit(journal, {}, 'stock', { type: 'done' });
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(settled, false);
  await waiting; assert.equal(journal.stats().waiters, 0);
});
test('caught-up waits flush deadlines, wake on notable events and clean abort/caps without a registration race', async () => {
  const journal = store({ waiters: 1 }), owner = {};
  emit(journal, owner, 'inventory', { type: 'thinking_start' });
  const cursor = journal.read('inventory').next;
  const abort = new AbortController();
  const waiting = journal.watch('inventory', cursor, false, 0.1, abort.signal);
  await assert.rejects(journal.watch('inventory', cursor, false, 0.1), /busy/);
  emit(journal, owner, 'inventory', { type: 'tool_end', call: { id: 'check', error: true } });
  assert.equal((await waiting).events[0].kind, 'tool-end'); assert.equal(journal.stats().waiters, 0);
  const latest = journal.read('inventory').next;
  const deadline = journal.watch('inventory', latest, false, 0.01);
  emit(journal, owner, 'inventory', { type: 'text_chunk', text: 'Latest totals.' });
  assert.equal((await deadline).events[0].data.text, 'Latest totals.');
  const cancelled = journal.watch('inventory', journal.read('inventory').next, false, 1, abort.signal);
  abort.abort(); await assert.rejects(cancelled, /aborted/); assert.equal(journal.stats().waiters, 0);
});
test('visible retry/error/end facts preserve failure and never infer success from missing tool outcome', () => {
  const journal = store(), owner = {};
  emit(journal, owner, 'inventory', { type: 'thinking_start' });
  emit(journal, owner, 'inventory', { type: 'retry_status', errorRetry: true, attempt: 1 });
  emit(journal, owner, 'inventory', { type: 'thinking_start' });
  emit(journal, owner, 'inventory', { type: 'tool_end', call: { id: 'check', result: 'completed', error: false } });
  emit(journal, owner, 'inventory', { type: 'error', text: 'Inventory failed' });
  emit(journal, owner, 'inventory', { type: 'done' });
  const page = journal.read('inventory');
  assert.equal(page.events.find(e => e.kind === 'tool-end').data.outcome, 'unknown');
  assert.equal(page.events.at(-1).data.outcome, 'error');
  assert.equal(page.events.filter(e => e.kind === 'retry').length, 1);
});
test('the existing retry filter hides attempt errors, retains retries and does not reuse a stopped turn', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-retry-'));
  process.env.ARGUS_CONFIG = path.join(dir, 'settings.json');
  fs.writeFileSync(process.env.ARGUS_CONFIG, JSON.stringify({ watchdogEnabled: true, errorRetryMaxRetries: 1, errorRetryDelay: 1, errorRetryPatterns: 'capacity' }));
  const { createErrorRetry } = require('../out/backend/errorRetry');
  const journal = store(), owner = {};
  const retry = createErrorRetry({ broadcast: line => emit(journal, owner, 'inventory', JSON.parse(line)),
    getLastMessage: () => ({ text: 'Check inventory.' }), retry: () => assert.fail('cancelled retry must not execute'), log: () => {} });
  try {
    retry.broadcast(JSON.stringify({ type: 'thinking_start' }));
    retry.broadcast(JSON.stringify({ type: 'error', text: 'Capacity unavailable' }));
    retry.broadcast(JSON.stringify({ type: 'done' }));
    assert.deepEqual(journal.read('inventory').events.map(e => e.kind), ['start', 'retry']);
    retry.cancel(true); retry.beginTurn(); retry.broadcast(JSON.stringify({ type: 'thinking_start' }));
    const events = journal.read('inventory').events;
    assert.equal(events[2].data.outcome, 'stopped'); assert.notEqual(events[0].turnId, events.at(-1).turnId);
    retry.broadcast(JSON.stringify({ type: 'error', text: 'Invalid inventory' })); retry.broadcast(JSON.stringify({ type: 'done' }));
    assert.equal(journal.read('inventory').events.at(-1).data.outcome, 'error');
  } finally { retry.cancel(false); fs.rmSync(dir, { recursive: true, force: true }); }
});
