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
  // app/public is vite's publicDir in the app build; the test root is the
  // project, so serve it here too or model weights 404 under /models/.
  publicDir: 'app/public',
  server: {
    port: 5175,
    open: '/test/benchmarks/gpu-vs-cpu.html',
  },
});
