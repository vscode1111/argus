const readline = require('readline');
let turn = 0;
const capacityAttempts = new Map();
let timer;
let pendingStartInterrupt = false;
let threadParams;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const threadId = 'scub-session';
const notify = (method, params) => emit({ method, params: { threadId, ...params } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  if (method === 'initialize') emit({ id, result: { userAgent: 'scub-runtime' } });
  else if (method === 'skills/list') emit({ id, result: { data: [{ skills: [{ name: 'scub-skill', path: '/scub/skills/scub-skill/SKILL.md', enabled: true }] }] } });
  else if (method === 'thread/start' || method === 'thread/resume') {
    threadParams = params;
    emit({ id, result: { thread: { id: threadId } } });
  }
  else if (method === 'turn/start') {
    const permissionMode = /^scub-permission-(edit|plan|full-access)$/.exec(params.input?.[0]?.text || '')?.[1];
    if (permissionMode) {
      const full = permissionMode === 'full-access';
      const plan = permissionMode === 'plan';
      const expectedApproval = full ? 'never' : 'on-request';
      const expectedSandbox = full ? 'danger-full-access' : plan ? 'read-only' : 'workspace-write';
      const expectedPolicy = full ? 'dangerFullAccess' : plan ? 'readOnly' : 'workspaceWrite';
      if (threadParams?.approvalPolicy !== expectedApproval || threadParams?.sandbox !== expectedSandbox ||
          params.approvalPolicy !== expectedApproval || params.sandboxPolicy?.type !== expectedPolicy) process.exit(5);
    }
    const turnId = `scub-turn-${++turn}`;
    emit({ id, result: { turn: { id: turnId } } });
    notify('turn/started', { turn: { id: turnId } });
    const text = params.input?.[0]?.text;
    if (String(text).startsWith('scub-capacity-')) {
      const attempt = (capacityAttempts.get(text) || 0) + 1;
      capacityAttempts.set(text, attempt);
      if (text === 'scub-capacity-always' || attempt <= 2) {
        if (text === 'scub-capacity-twice' && attempt === 1) {
          const item = { id: 'scub-tool', type: 'commandExecution', command: 'echo scub', status: 'completed' };
          notify('item/started', { turnId, item });
          notify('item/completed', { turnId, item });
        }
        notify('turn/completed', { turn: { id: turnId, status: 'failed', error: { message: 'Selected model is at capacity. Please try a different model.' } } });
        return;
      }
    }
    if (text === 'scub-other-error') {
      notify('turn/completed', { turn: { id: turnId, status: 'failed', error: { message: 'scub-unrelated failure' } } });
      return;
    }
    if (text === 'scub-interrupt-race') pendingStartInterrupt = true;
    if (String(text).includes('scub-skill') && (text !== '$scub-skill scub-input' || !params.input.some(i => i.type === 'skill' && i.path === '/scub/skills/scub-skill/SKILL.md'))) process.exit(4);
    if (text === 'scub-question') {
      emit({ id: 100, method: 'item/tool/requestUserInput', params: { threadId, turnId, questions: [{ id: 'scub-choice', question: 'Choose a color', options: [{ label: 'scub-blue' }] }] } });
    } else if (text === 'scub-async-question') {
      notify('item/completed', { turnId, item: { id: 'scub-ask', type: 'agentMessage', text: 'scub-choice', delivery: 'async',
        questions: [{ title: 'scub-choice', options: ['scub-blue', 'scub-green'] }] } });
      notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
    } else if (text === 'scub-async-question-live') {
      notify('item/completed', { turnId, item: { id: 'scub-ask-live', type: 'agentMessage', text: 'scub-choice', delivery: 'async',
        questions: [{ title: 'scub-choice', options: ['scub-blue', 'scub-green'] }] } });
    } else if (text === 'scub-unknown-request') {
      emit({ id: 101, method: 'item/permissions/requestApproval', params: { threadId, turnId } });
    } else if (text !== 'scub-wait' && text !== 'scub-interrupt-race') {
      timer = setTimeout(() => {
        notify('item/agentMessage/delta', { turnId, itemId: 'scub-answer', delta: 'scub-ok' });
        notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 120, outputTokens: 8 }, modelContextWindow: 1000 } });
        notify('item/completed', { turnId, item: { id: 'scub-answer', type: 'agentMessage', text: 'scub-ok' } });
        notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
      }, 60);
    }
  } else if (method === 'turn/interrupt') {
    if (pendingStartInterrupt) {
      pendingStartInterrupt = false;
      emit({ id, error: { code: -32000, message: 'no active turn to interrupt' } });
      return;
    }
    clearTimeout(timer);
    emit({ id, result: {} });
    setTimeout(() => notify('turn/completed', { turn: { id: params.turnId, status: 'interrupted' } }), 40);
    setTimeout(() => notify('item/agentMessage/delta', { turnId: params.turnId, itemId: 'scub-late', delta: 'scub-stale' }), 100);
  } else if (method === 'turn/steer') {
    emit({ id, result: { turnId: params.expectedTurnId } });
    if (params.input?.[0]?.text === 'scub-green') notify('turn/completed', { turn: { id: params.expectedTurnId, status: 'completed' } });
  }
  else if (id === 100 && !method) {
    if (message.result?.answers?.['scub-choice']?.answers?.[0] !== 'scub-blue') process.exit(2);
    notify('serverRequest/resolved', { requestId: 100 });
    notify('turn/completed', { turn: { id: `scub-turn-${turn}`, status: 'completed' } });
  } else if (id === 101 && !method) {
    if (!message.error) process.exit(3);
    notify('turn/completed', { turn: { id: `scub-turn-${turn}`, status: 'completed' } });
  } else if (method === 'scub-failure') process.exit(1);
});
