import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
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
