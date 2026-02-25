import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',   // Relative paths for JupyterHub proxy
  root: 'app',
  resolve: {
    alias: {
      'sardine': '/src/index.js',
      '@src': '/src',
    },
  },
  server: {
    host: '0.0.0.0',  // Listen on all interfaces for JupyterHub proxy
    port: 5173,
    open: false,  // Disable auto-open for headless/Jupyter environments
    allowedHosts: ['.jpl.nasa.gov'],  // Allow JupyterHub proxy domain
    proxy: {
      // Forward API requests to sardine-launch server during development
      '/api': {
        target: 'http://localhost:8050',
        changeOrigin: true,
      },
      '/data': {
        target: 'http://localhost:8050',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
