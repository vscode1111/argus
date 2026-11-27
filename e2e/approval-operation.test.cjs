// Source-level contract tests: no daemon build or provider process is required.
require('tsx/cjs');
const { test, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-operation-'));
process.env.ARGUS_CONFIG = path.join(root, 'settings.json');
const { CodexSession } = require('../src/backend/providers/codex.ts');
const { createSessionState } = require('../src/backend/sessionState.ts');
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('approval operation is structured from original params, independently of display detail', async () => {
  const cases = [
    ['item/commandExecution/requestApproval', { reason: 'Need access\ngit log\nD:/Projects' }, { kind: 'command' }],
    ['item/commandExecution/requestApproval', { reason: 'Need access\ngit log', cwd: 'D:/Projects' }, { kind: 'command', cwd: 'D:/Projects' }],
    ['item/commandExecution/requestApproval', { reason: 'Need access\ngit log', command: '/usr/bin/touch /tmp/outside' }, { kind: 'command', command: '/usr/bin/touch /tmp/outside' }],
    ['item/commandExecution/requestApproval', { reason: 'Network read', command: 'git log -5', cwd: root }, { kind: 'command', command: 'git log -5', cwd: root }],
    ['item/commandExecution/requestApproval', { command: ['git', 'log'], cwd: 42 }, { kind: 'command' }],
    ['item/fileChange/requestApproval', { reason: 'Need access\ngit log', command: 'git log', cwd: root }, { kind: 'fileChange' }],
    ['item/tool/requestUserInput', { questions: [] }, undefined],
  ];
  for (const [method, params, expected] of cases) {
    const state = createSessionState(root), events = [];
    state.selection = { providerId: 'codex', model: 'source-model', effort: 'low' };
    state.broadcast = text => events.push(JSON.parse(text));
    const rpc = { async start() {}, async request(method) {
      if (method === 'thread/start') return { thread: { id: 'operation-thread' } };
      if (method === 'turn/start') return { turn: { id: 'operation-turn' } };
      return {};
    }, respond() {}, reject() {}, dispose() {} };
    const runtime = new CodexSession(state, rpc, async () => {}); state.runtime = runtime;
    try {
      await runtime.send({ text: 'Inspect inventory', mode: 'edit' });
      rpc.onMessage(method, { threadId: 'operation-thread', turnId: runtime.activeTurnId, ...params }, 100);
      const request = events.filter(event => event.type === 'interaction' && event.request).at(-1)?.request;
      assert.ok(request, method); assert.deepEqual(request.operation, expected, method);
      assert.equal(request.kind, method === 'item/tool/requestUserInput' ? 'question' : 'approval');
      const text = value => typeof value === 'string' ? value : '';
      assert.equal(request.detail, [text(params.reason), text(params.command), text(params.cwd)].filter(Boolean).join('\n'));
    } finally { runtime.dispose(); }
  }
});
