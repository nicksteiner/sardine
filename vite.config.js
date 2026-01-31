import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'examples/basic',
  resolve: {
    alias: {
      'sar-viewer': '/src/index.js',
    },
  },
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
});
