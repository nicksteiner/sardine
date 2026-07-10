# Contributing to SARdine

## Setup

```bash
git clone https://github.com/nicksteiner/sardine.git
cd sardine
npm install
npm run dev          # Vite dev server at localhost:5173
```

## Commands

```bash
npm test             # Main test suite (node test/run-tests.js, 100+ checks)
npm run test:quick   # Fast smoke tests
npm run build        # Production build → dist/
npm run test:layer   # Browser-based layer rendering test
npm run debug:gpu    # GPU shader debug page
npm run benchmark    # GPU vs CPU rendering benchmark
```

## Ground rules

- **Plain JavaScript** — no TypeScript in app code. ES modules throughout.
  React components use `.jsx`.
- **GPU-first** — new visualization features should run in GLSL shaders when possible.
- **No server required** — everything must work client-side from local File objects
  or HTTP Range URLs.
- **Minimal dependencies** — pure JS/WASM stack; no GDAL, no tile server.
- **Export parity** — any new rendering feature must work in both the on-screen
  and export paths.
- **Test with real data** — use actual NISAR GCOV `.h5` files and SAR GeoTIFFs.
- Keep diffs small and focused.

See [`CLAUDE.md`](../CLAUDE.md) for project structure, architecture, and coding
patterns, and [`API.md`](API.md) for the public API surface.

## Pull requests

1. Branch from `main`
2. Make your change; run `npm test` and `npm run build`
3. Open a PR with a clear description
