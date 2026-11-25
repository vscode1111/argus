const cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const spawn = cp.spawn, histories = new Map(), workspaces = new Map();
const sessions = require('../../out/backend/sessions'), find = sessions.findWorkspaceForSession;
sessions.findWorkspaceForSession = id => workspaces.get(id) ?? find(id);
cp.spawn = (binary, args, options) => {
  if (args?.[0] !== 'app-server' && !args?.includes('--input-format')) return spawn(binary, args, options);
  const rpc = args[0] === 'app-server', resumed = args[args.indexOf('--resume') + 1];
  const serverModule = path.resolve(__dirname, '../../out/backend/index.js');
  process.send?.({ type: 'fakeSpawn', serverModule, serverHash: createHash('sha256').update(fs.readFileSync(serverModule)).digest('hex'),
    moduleLoaded: !!require.cache[serverModule], daemonPort: options.env?.ARGUS_DAEMON_PORT, hasIdentity: typeof options.env?.ARGUS_AGENT_TOKEN === 'string' });
  const child = spawn(process.execPath, [path.join(__dirname, 'delivery-provider.cjs'), rpc ? 'rpc' : 'stream', !rpc && args.includes('--resume') ? resumed : ''], { ...options, shell: false });
  let session, buffer = '', pending = [];
  function bind(id) { session = id; workspaces.set(id, options.cwd); if (!histories.has(id)) histories.set(id, []); for (const text of pending) histories.get(id).push({ id: String(histories.get(id).length), role: 'user', content: text }); pending = []; }
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = (data, ...rest) => {
    try {
      const message = JSON.parse(String(data));
      const text = rpc ? ['turn/start', 'turn/steer'].includes(message.method) ? message.params.input?.filter(c => c.type === 'text').map(c => c.text).join('') : undefined
        : message.type === 'user' ? message.message.content?.filter(c => c.type === 'text').map(c => c.text).join('') : undefined;
      if (text !== undefined) { if (session) histories.get(session).push({ id: String(histories.get(session).length), role: 'user', content: text }); else pending.push(text); }
    } catch {}
    return write(data, ...rest);
  };
  child.stdout.on('data', data => {
    buffer += String(data); let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { const message = JSON.parse(line); if (message.type === 'system' && message.subtype === 'init') bind(message.session_id);
        else if (message.result?.thread?.id) bind('codex:' + message.result.thread.id);
      } catch {}
    }
  });
  return child;
};
const registry = require('../../out/backend/providers/registry');
for (const provider of registry.providers()) {
  provider.load = async id => histories.get(id) ?? [];
  provider.loadPage = async id => ({ messages: histories.get(id) ?? [] });
  provider.withHistoryReader = async (id, _cwd, action) => action(async () => ({ messages: histories.get(id) ?? [] }));
  provider.list = async cwd => [...histories].filter(([id]) => workspaces.get(id) === cwd && (id.startsWith('codex:') ? 'codex' : 'claude') === provider.descriptor.id)
    .map(([id]) => ({ id, title: 'Synthetic inventory', providerId: provider.descriptor.id, updatedAt: 1 }));
  // The agent graph resolves node titles through listTitles, not list; without this the
  // real transcript reader finds nothing for these fake sessions and the graph falls back
  // to stored node titles, so the synthetic native title would never be exercised.
  provider.listTitles = async (cwd, ids) => (await provider.list(cwd)).filter(s => ids.includes(s.id)).map(({ id, title }) => ({ id, title }));
}
