# W001 — Loader & export round-trip tests (the refactor safety net)

wave: 0
status: branch-ready (commit 2730fcc)
blocked_by: []
branch: w001-roundtrip-tests

## Findings (from implementation)

- **Real bug found + fixed in `src/utils/geotiff-writer.js`:** `writeRGBAGeoTIFF`
  produced corrupt TIFFs for single-tile images (≤512×512) — `writeIFD` wrote a `0`
  placeholder for inline TileOffsets. Float32 writer had the fix; the RGBA path
  didn't. Regression-tested both cases. (Minimal src/ change beyond stated scope.)
- **h5chunk superblock v0 bug (worked around, NOT fixed):** v0/v1 path misreads the
  root symbol-table entry's `linkNameOffset` as `rootGroupAddress` → default-libver
  h5py files fail discovery. Real NISAR files are superblock v2/v3 so production is
  unaffected. Fixture uses `fs_strategy='page'` + `libver='earliest'`. → Spun out as
  W013.
- 62 tests / ~2,260 assertions across geotiff round-trip (bit-exact Float32), stats,
  WKT/ROI, and a committed 12 KB synthetic chunked+gzip+shuffle HDF5 fixture (the
  escape hatch was not needed). `npm run test:unit` added; `.gitignore` negation for
  the fixture (blanket `*h5` rule).
- Node runs require `useWorkerPool = false` at HEAD (silent zero-fill on worker
  failure) — independently found and FIXED by W006; merging both resolves this.

## Objective

Add behavioral tests for the code paths every later work order touches, so refactors
have a net. Current `test/run-tests.js` checks structure (files exist, exports present,
braces balance) — not behavior.

## Scope

- New: `test/unit/geotiff-roundtrip.test.mjs` — write a small synthetic Float32 +
  RGBA GeoTIFF via `src/utils/geotiff-writer.js`, re-read with geotiff.js (already a
  dependency), assert: dimensions, pixel values (Float32 exact), ModelTiepoint,
  ModelPixelScale, GeoKey EPSG code survive.
- New: `test/unit/stats.test.mjs` — `computeStats`, `computeHistogram`,
  `autoContrastLimits`, `computeChannelStats` on synthetic arrays with NaN/zero nodata;
  assert min/max/mean/percentiles against hand-computed values.
- New: `test/unit/wkt-roi.test.mjs` — `src/utils/wkt.js` parse/validate/bbox +
  `src/utils/roi-subset.js` bboxToPixelRange/computeSubsetBounds round-trip on a
  synthetic file-metadata fixture.
- New: `test/unit/h5chunk-synthetic.test.mjs` — generate a tiny chunked+deflate HDF5
  fixture in Node (construct bytes directly or check in a <100 KB fixture built once
  with Python h5py if available; committed binary fixture is acceptable), open with
  h5chunk `openH5ChunkFile`, assert dataset discovery, `readChunk`, `readRegion`
  values. If building a valid fixture proves >2h of work, SKIP this file and note it
  in Findings — do not fake it.
- Modify: `package.json` — add `test:unit` script running these with plain `node`
  (no new test framework deps; use `node:assert` and a tiny runner, or extend the
  existing custom-runner pattern in `test/run-tests.js`).
- Modify: `test/run-tests.js` — ONLY to invoke the new unit files if trivial; this file
  has uncommitted changes in the primary working tree, so prefer a standalone runner.

## Out of scope

- No vitest/jest/playwright installation. No GPU/browser tests. No loader network tests.

## Acceptance criteria

- `npm test` passes (existing checks unbroken).
- `node test/unit/geotiff-roundtrip.test.mjs` (and each new file) exits 0 with
  assertions actually executed (print a count).
- Float32 GeoTIFF round-trip asserts bit-exact pixel recovery.

## Notes

`docs/RENDERING_PIPELINE_AUDIT.md` §12 lists the recommended test inventory — this
work order implements its "Unit Tests Needed" items 1, 2, 5 minimum.
