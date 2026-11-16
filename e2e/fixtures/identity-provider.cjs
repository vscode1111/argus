const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const { WebSocket } = require('ws');
const rpc = process.argv[2] === 'rpc';
const id = randomUUID();
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let pending;
async function identity() {
  const port = process.env.ARGUS_DAEMON_PORT;
  if (!port || !process.env.ARGUS_AGENT_TOKEN) throw Error('Missing execution identity');
  const nonce = await (await fetch(`http://127.0.0.1:${port}/nonce`)).text();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent?nonce=${nonce}&dir=${encodeURIComponent(process.cwd())}&client=browser`);
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error('Identity timed out')); }, 2000);
    ws.on('error', reject);
    ws.on('message', text => {
      const message = JSON.parse(String(text));
      if (message.type !== 'whoami' || message.requestId !== requestId) return;
      clearTimeout(timer); ws.close();
      if (message.error) reject(Error('Identity rejected')); else resolve(message);
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'whoami', requestId, agentToken: process.env.ARGUS_AGENT_TOKEN })));
  });
}
let serial = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', line => {
  serial = serial.then(async () => {
    const message = JSON.parse(line);
    if (!rpc) {
      if (message.type !== 'user') return;
      pending ??= await identity();
      emit({ type: 'system', subtype: 'init', session_id: id });
      await new Promise(r => setTimeout(r, 20));
      const current = await identity();
      const checks = { pending: pending.sessionId === null, assigned: current.sessionId === id,
        workspace: current.workspace === process.cwd(), provider: current.providerId === 'claude',
        port: Number(process.env.ARGUS_DAEMON_PORT) > 0 };
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(checks) }] } });
      emit({ type: 'result', subtype: 'success', result: '', num_turns: 1 });
      return;
    }
    const { method, params = {}, id: requestId } = message;
    if (method === 'initialize') emit({ id: requestId, result: {} });
    else if (method === 'model/list') {
      // Model metadata helpers must not inherit the server caller's identity.
      if (process.env.ARGUS_AGENT_TOKEN || process.env.ARGUS_DAEMON_PORT) throw Error('Metadata inherited identity');
      emit({ id: requestId, result: { data: [{ id: 'inventory-model', model: 'inventory-model', isDefault: true }] } });
    } else if (method === 'thread/start' || method === 'thread/resume') {
      pending = await identity();
      emit({ id: requestId, result: { thread: { id } } });
    } else if (method === 'turn/start') {
      const current = await identity();
      const checks = { pending: pending.sessionId === null, assigned: current.sessionId === `codex:${id}`,
        workspace: current.workspace === params.cwd || current.workspace === process.env.IDENTITY_WORKSPACE,
        provider: current.providerId === 'codex', port: Number(process.env.ARGUS_DAEMON_PORT) > 0 };
      const turnId = randomUUID();
      emit({ id: requestId, result: { turn: { id: turnId } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: id, turnId, itemId: 'inventory-result', delta: JSON.stringify(checks) } });
      emit({ method: 'turn/completed', params: { threadId: id, turn: { id: turnId, status: 'completed' } } });
    } else if (requestId !== undefined) emit({ id: requestId, result: {} });
  }).catch(() => { emit(rpc ? { error: { message: 'Fake provider identity check failed' } }
    : { type: 'result', is_error: true, result: 'Fake provider identity check failed' }); process.exitCode = 1; process.stdin.destroy(); });
});
