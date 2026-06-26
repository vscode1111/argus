import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync } from 'fs';

// Copy just the shared bridge into media/ after the bundle is written, so the
// extension webview and the daemon's HTTP server load the same factory the dev
// server serves from /public. A targeted copy (not publicDir) avoids clobbering
// other tracked media assets (e.g. argus-icon.svg differs from the public copy).
function copyWsBridge() {
  return {
    name: 'copy-ws-bridge',
    closeBundle() {
      copyFileSync(
        resolve(__dirname, 'public/ws-bridge.js'),
        resolve(__dirname, '../media/ws-bridge.js'),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), copyWsBridge()],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      name: 'ArgusWebview',
      formats: ['iife'],
      fileName: () => 'webview.js',
    },
    outDir: resolve(__dirname, '../media'),
    emptyOutDir: false,
    cssFileName: 'webview',
    minify: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        assetFileNames: (info) =>
          info.names?.some(n => n.endsWith('.css')) ? 'webview.css' : (info.names?.[0] ?? 'asset'),
      },
    },
  },
});
