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
    host: '0.0.0.0',  // Listen on all interfaces for JupyterHub proxy
    port: 5173,
    open: false,  // Disable auto-open for headless/Jupyter environments
    allowedHosts: ['.jpl.nasa.gov'],  // Allow JupyterHub proxy domain
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
