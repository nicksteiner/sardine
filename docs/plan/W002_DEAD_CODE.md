# W002 — Delete dead code and stale docs

wave: 0
status: branch-ready (commit c8fa22b, +103/−1429)
blocked_by: []
branch: w002-dead-code

## Findings (from implementation)

- Every scoped candidate confirmed dead by grep and deleted; `readFileRange()` and
  `writeLegacyOverflow()` removed by cascade (only callers were inside deleted code).
- **Public-API note:** the deprecated `writeRGBGeoTIFF()` wrapper (sole caller of
  `writeLegacyRGBGeoTIFF`) was also removed, including its `src/index.js` export —
  flag if any external consumer imports it (app + tests use only
  `writeRGBAGeoTIFF`/`writeFloat32GeoTIFF`).
- `rollup.config.js` didn't exist (conditional item). `ChunkedDatasetReader` had
  drifted to lines 1151–1354. `docs/API.md`/`CONTRIBUTING.md` rewritten to match
  reality. `test/run-tests.js` touch surface: three small removals (upstream WIP
  rebase should be trivial).

## Objective

Remove modules that are exported but never used, and docs that describe the pre-1.0
TypeScript library. Shrinks the audit surface for every later work order.

## Scope (verify each is truly unreferenced before deleting — grep imports first)

- Delete `src/layers/SARGPUBitmapLayer.js` (exported from `src/index.js`, never
  instantiated). Remove its export from `src/index.js` and any `@deprecated` comment
  in `SARTileLayer.js` that points to it. Remove related checks from `test/run-tests.js`
  ONLY if they fail after deletion (that file has uncommitted changes upstream — touch
  minimally).
- Delete `src/loaders/hdf5-chunked.js` (never imported; h5chunk.js is the production
  path). Remove the reference to it from `docs/CLOUD_OPTIMIZED_HDF5.md` file-structure
  section.
- Delete `ChunkedDatasetReader` class in `src/loaders/nisar-loader.js` (~lines
  1127–1331 per Feb 2026 audit — RE-LOCATE by grep, line numbers have drifted).
- Delete `writeLegacyRGBGeoTIFF` in `src/utils/geotiff-writer.js` (marked deprecated)
  and its export if unused.
- Delete `rollup.config.js` and `jest.config.cjs` if no npm script references them.
- Replace `docs/API.md` and `docs/CONTRIBUTING.md` content (they document the v0.1
  TypeScript `SARdine` class that no longer exists) with a short accurate version:
  API.md → point at `src/index.js` exports with the key loader/export signatures from
  CLAUDE.md; CONTRIBUTING.md → actual setup (npm install / dev / test, plain-JS rule).

## Out of scope

- No refactors of live code. No renames. If grep shows ANY live import of a candidate,
  leave it and note it in Findings.

## Acceptance criteria

- `grep -rn "SARGPUBitmapLayer\|hdf5-chunked\|ChunkedDatasetReader\|writeLegacyRGBGeoTIFF" src/ app/` returns nothing.
- `npm test` passes; `npm run build` succeeds.
- `docs/API.md` no longer mentions `new SARdine(` or `SARImageLayer`.
