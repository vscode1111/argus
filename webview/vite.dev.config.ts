import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { readDaemonInfo } from '../src/backend/daemonInfo';

export default defineConfig(async ({ mode }) => {
  const plugins: PluginOption[] = [react()];
  if (mode === 'daemon') {
    const daemon = readDaemonInfo();
    if (!daemon || !Number.isInteger(daemon.port) || daemon.port < 1 || daemon.port > 65535) {
      throw new Error('Argus daemon discovery is unavailable. Open Argus in VS Code and retry.');
    }
    const health = await fetch(`http://127.0.0.1:${daemon.port}/health`, { signal: AbortSignal.timeout(3000) })
      .then(response => response.ok ? response.json() : null)
      .catch(() => null);
    if (health?.pid !== daemon.pid) {
      throw new Error('The registered Argus daemon did not answer. Open Argus in VS Code and retry.');
    }
    plugins.push({
      name: 'argus-dev-daemon',
      transformIndexHtml: () => [{
        tag: 'meta',
        attrs: { name: 'argus-backend-port', content: String(daemon.port) },
        injectTo: 'head-prepend',
      }],
    });
  }
  return {
    root: __dirname,
    plugins,
    server: {
      port: mode === 'daemon' ? 5174 : 5173,
      strictPort: true,
      host: mode === 'daemon' ? 'localhost' : true,
    },
  };
});
