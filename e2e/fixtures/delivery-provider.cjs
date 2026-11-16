const { randomUUID } = require('node:crypto'), readline = require('node:readline');
const rpc = process.argv[2] === 'rpc'; let session = process.argv[3] || randomUUID(), turn, held = false;
const emit = v => process.stdout.write(JSON.stringify(v) + '\n');
function finish(interrupted = false) {
  held = false;
  if (rpc) emit({ method: 'turn/completed', params: { threadId: session, turn: { id: turn, status: interrupted ? 'interrupted' : 'completed' } } });
  else emit({ type: 'result', subtype: 'success', result: '', num_turns: 1 });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line);
  if (!rpc) {
    if (value.type === 'control_response') {
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: turn, content: 'Synthetic selection recorded.' }] } });
      setTimeout(() => finish(), 200); return;
    }
    if (value.type !== 'user') return;
    const text = value.message.content.filter(c => c.type === 'text').map(c => c.text).join('').replace(/^🤖\s*/, '');
    emit({ type: 'system', subtype: 'init', session_id: session });
    if (text === 'Coordinate inventory' && process.env.ARGUS_TEST_CONTROLLER) {
      const { spawn } = require('node:child_process'), path = require('node:path');
      const child = spawn(process.execPath, [path.join(__dirname, 'controller-runner.cjs')], { env: process.env, cwd: process.cwd(), windowsHide: true });
      let result = ''; child.stdout.on('data', data => { result += data; }); child.stderr.resume();
      child.on('exit', code => { emit({ type: 'assistant', message: { content: [{ type: 'text', text: (code === 0 ? 'Combined inventory passed ' : 'Combined inventory failed ') + result }] } }); finish(); });
      finish(); return;
    }
    if (text === 'Choose inventory') {
      turn = randomUUID(); const input = { questions: [{ question: 'Choose section', header: 'Section', options: [{ label: 'Stock' }, { label: 'Orders' }] }] };
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: turn, name: 'AskUserQuestion', input }] } });
      emit({ type: 'control_request', request_id: turn, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: turn, input } });
      held = true; return;
    }
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Synthetic inventory response.' }] } });
    if (text === 'Wait briefly' || text === 'Wait before tool') {
      held = true;
      setTimeout(() => {
        emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: randomUUID(), name: 'Bash', input: { command: 'synthetic wait' } }] } });
        if (text === 'Wait briefly') setTimeout(() => finish(), 100);
      }, text === 'Wait briefly' ? 0 : 500);
      return;
    }
    if (text === 'Hold inventory') held = true; else finish();
    return;
  }
  const { method, id, params = {} } = value;
  if (method === 'model/list') { emit({ id, result: { data: [{ id: 'inventory-model', model: 'inventory-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] } }); return; }
  if (method === 'thread/start' || method === 'thread/resume') { session = params.threadId || session; emit({ id, result: { thread: { id: session } } }); return; }
  if (method === 'turn/start') {
    turn = randomUUID(); emit({ id, result: { turn: { id: turn } } });
    emit({ method: 'item/agentMessage/delta', params: { threadId: session, turnId: turn, itemId: randomUUID(), delta: 'Synthetic inventory response.' } });
    if (params.input?.[0]?.text?.replace(/^🤖\s*/, '') === 'Hold inventory') held = true; else setTimeout(() => finish(), 15);
    return;
  }
  if (method === 'turn/steer') {
    emit({ id, result: {} });
    if (params.input?.[0]?.text?.replace(/^🤖\s*/, '') === 'Choose inventory') emit({ method: 'item/completed', params: { threadId: session, turnId: turn,
      item: { id: randomUUID(), type: 'agentMessage', text: 'Synthetic inventory choice', delivery: 'async', questions: [{ title: 'Choose section', options: ['Stock', 'Orders'] }] } } });
    setTimeout(() => finish(), 15); return;
  }
  if (method === 'turn/interrupt') { emit({ id, result: {} }); setTimeout(() => finish(true), 15); return; }
  if (id !== undefined) emit({ id, result: {} });
});
