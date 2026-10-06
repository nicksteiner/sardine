import { defineConfig } from 'vite';

// Vite config for running tests and benchmarks
// Uses project root so test/ files are accessible
export default defineConfig({
  root: '.',
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  resolve: {
    alias: {
      'sardine': '/src/index.js',
    },
  },
  // Same as vite.config.js (W032): the @developmentseed/geotiff LZW codec uses
  // top-level await, which esbuild's default es2020 prebundle target rejects.
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' },
  },
  build: { target: 'es2022' },
  server: {
    port: 5175,
    open: '/test/benchmarks/gpu-vs-cpu.html',
  },
});
