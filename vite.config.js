import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',   // relative paths — required for JupyterHub proxy
  root: 'app',
  resolve: {
    alias: {
      'sardine': '/src/index.js',
    },
  },
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
