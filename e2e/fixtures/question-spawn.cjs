const cp = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const spawn = cp.spawn;
// Fake native sessions have no transcript files. Supply their discovery metadata
// at the same provider boundary, without writing synthetic history to disk.
const workspaces = new Map();
const sessions = require('../../out/backend/sessions');
const nativeWorkspace = sessions.findWorkspaceForSession;
sessions.findWorkspaceForSession = id => workspaces.get(id) ?? nativeWorkspace(id);
cp.spawn = (binary, args, options) => {
  if (args?.[0] === 'app-server' || args?.includes('--input-format')) {
    const serverModule = path.resolve(__dirname, '../../out/backend/index.js');
    process.send?.({ type: 'fakeSpawn', serverModule, serverHash: createHash('sha256').update(fs.readFileSync(serverModule)).digest('hex'),
      moduleLoaded: !!require.cache[serverModule], daemonPort: options.env?.ARGUS_DAEMON_PORT,
      hasIdentity: typeof options.env?.ARGUS_AGENT_TOKEN === 'string' });
    const child = spawn(process.execPath, [path.join(__dirname, 'question-provider.cjs'), args[0] === 'app-server' ? 'rpc' : 'stream'], { ...options, shell: false });
    let buffer = '';
    child.stdout.on('data', data => {
      buffer += data.toString(); let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { const event = JSON.parse(line); if (event.type === 'system' && event.subtype === 'init') workspaces.set(event.session_id, options.cwd); } catch {}
      }
    });
    return child;
  }
  return spawn(binary, args, options);
};
