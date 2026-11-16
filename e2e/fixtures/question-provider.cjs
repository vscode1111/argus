const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const session = randomUUID();
let choice, autonomous = false;
const input = { questions: [{ question: 'Choose features', header: 'Features', multiSelect: true,
  options: [{ label: 'Search', description: 'Search inventory' }, { label: 'Sort', description: 'Sort inventory' }] }] };
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (process.argv[2] === 'rpc') {
    if (message.id !== undefined) emit({ id: message.id, result: message.method === 'model/list' ? { data: [] } : {} });
    return;
  }
  if (message.type === 'user') {
    choice = randomUUID();
    emit({ type: 'system', subtype: 'init', session_id: session });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking inventory.' },
      { type: 'tool_use', id: choice, name: 'AskUserQuestion', input: { questions: JSON.stringify(input.questions) } }] } });
    emit({ type: 'control_request', request_id: choice, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: choice, input } });
  } else if (message.type === 'control_response' && message.response.request_id === choice) {
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: choice, content: 'Selection recorded.' }] } });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Inventory checked.' }] } });
    emit({ type: 'result', subtype: 'success', result: '', num_turns: 1 });
    if (!autonomous) {
      autonomous = true;
      setTimeout(() => {
        emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Background inventory complete.' }] } });
        emit({ type: 'result', subtype: 'success', result: '', num_turns: 1 });
      }, 100);
    }
  }
});
