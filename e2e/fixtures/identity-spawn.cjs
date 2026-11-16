// Replace only provider process boundaries; keep the private server and adapters real.
const cp = require('node:child_process');
const path = require('node:path');
const spawn = cp.spawn;
cp.spawn = (binary, args, options) => {
  const rpc = args?.[0] === 'app-server';
  const execution = args?.includes('--input-format');
  if (rpc || execution) {
    const serverModule = path.resolve(__dirname, '../../out/backend/index.js');
    const serverHash = require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(serverModule)).digest('hex');
    process.send?.({ type: 'providerSpawn', rpc, agentToken: options.env?.ARGUS_AGENT_TOKEN, daemonPort: options.env?.ARGUS_DAEMON_PORT,
      serverModule, serverHash, moduleLoaded: !!require.cache[serverModule] });
    return spawn(process.execPath,
      [path.join(__dirname, 'identity-provider.cjs'), rpc ? 'rpc' : 'stream'], { ...options, shell: false });
  }
  return spawn(binary, args, options);
};
