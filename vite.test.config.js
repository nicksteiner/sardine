import { defineConfig } from 'vite';

// Vite config for running tests and benchmarks
// Uses project root so test/ files are accessible
export default defineConfig({
  root: '.',
  resolve: {
    alias: {
      'sardine': '/src/index.js',
    },
  },
  server: {
    port: 5175,
    open: '/test/benchmarks/gpu-vs-cpu.html',
    proxy: {
      '/api': {
        target: 'http://localhost:8050',
        changeOrigin: true,
      },
    },
  },
});
