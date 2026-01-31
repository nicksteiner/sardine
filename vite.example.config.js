import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for running examples
export default defineConfig({
  plugins: [react()],
  root: 'examples/basic',
  resolve: {
    alias: {
      'sardine': '/src/index.js',
    },
  },
  server: {
    port: 5174,
    open: true,
  },
  build: {
    outDir: '../../dist-example',
    emptyOutDir: true,
  },
});
