const { test } = require('node:test');
const assert = require('node:assert/strict');
require('tsx/cjs');
const { reducer, initialState } = require('../webview/src/reducer.ts');

const ID = 'scub-session';
const msg = id => ({ id, role: 'assistant', content: `scub ${id}`, blocks: [{ type: 'text', text: `scub ${id}` }] });

// The list as a client holds it after an initial replay that still has earlier pages.
function loaded(before = 20) {
  return reducer(initialState, { type: 'sessionLoaded', id: ID, messages: [msg('head'), msg('tail')], before });
}
const revision = loaded().historyRevision;
const page = (messages, before) => ({ type: 'historyPage', id: ID, messages, before, revision });

test('an earlier page is applied once even when the same frame arrives twice', () => {
  const first = reducer(loaded(), page([msg('older')], 10));
  assert.deepEqual(first.messages.map(m => m.id), ['older', 'head', 'tail']);
  assert.equal(first.historyBefore, 10);
  // The decisive case: the identical page delivered a second time. Before the
  // guard this prepended the same turn again, which is what the report showed.
  const again = reducer(first, page([msg('older')], 10));
  assert.deepEqual(again.messages.map(m => m.id), ['older', 'head', 'tail']);
  assert.equal(again, first);
});

test('a page that overlaps the displayed head contributes only its new segments', () => {
  const state = reducer(loaded(), page([msg('older'), msg('head')], 10));
  assert.deepEqual(state.messages.map(m => m.id), ['older', 'head', 'tail']);
  assert.equal(state.historyBefore, 10);
});

test('a page that does not move the cursor back is ignored', () => {
  const state = loaded(10);
  assert.equal(reducer(state, page([msg('older')], 10)), state);
  assert.equal(reducer(state, page([msg('older')], 12)), state);
});

// Controls: without these a build that simply dropped every page would pass.
test('consecutive earlier pages still extend the conversation backwards', () => {
  let state = loaded();
  state = reducer(state, page([msg('second')], 10));
  state = reducer(state, page([msg('first')], 0));
  assert.deepEqual(state.messages.map(m => m.id), ['first', 'second', 'head', 'tail']);
  assert.equal(state.historyBefore, 0);
});

test('a page for another session or revision is still rejected', () => {
  const state = loaded();
  assert.equal(reducer(state, { ...page([msg('older')], 10), id: 'scub-other' }), state);
  assert.equal(reducer(state, { ...page([msg('older')], 10), revision: revision + 1 }), state);
  assert.equal(reducer(state, { ...page([msg('older')], 10), error: 'scub failure' }), state);
});
