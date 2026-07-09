# W003 — Fix signal-abort cascade + adaptive-concurrency decay (P0)

wave: 0
status: merged — was branch-ready (commit 9b4f090)
blocked_by: []
branch: w003-abort-cascade-fix

## Findings (from implementation, 2026-07-08)

- Premise had partially drifted: signal-forwarding removal already landed in commit
  `3392d9f`, but it removed signals entirely — the tile-level `signal?.aborted` CPU-skip
  had to be re-plumbed through `SARViewer.jsx` (`stableGetTileData` now forwards
  `tile.signal`). Audit doc §13 line numbers no longer reflect HEAD.
- Concurrency fix: `readChunksBatch` Phase 3 now uses `Promise.allSettled`; batches
  containing any rejection record no throughput sample and don't call
  `_adaptConcurrency()`.
- Tests added in `test/w003-abort-cascade.test.mjs` (chained via package.json, leaving
  WIP-modified `test/run-tests.js` untouched). Small uncommitted-WIP overlap in
  `SARViewer.jsx`/`package.json` — trivial rebase expected.

## Objective

Implement the P0/P1 fixes from `docs/RENDERING_PIPELINE_AUDIT.md` §14: tiles fail to
render during viewport stabilization because deck.gl aborts in-flight chunk fetches,
and those AbortErrors also poison the adaptive-concurrency estimator.

## Background (read first)

`docs/RENDERING_PIPELINE_AUDIT.md` — especially §4 (signal flow), §8 (BUG 1, BUG 3),
§13 (signal-handling table). Line numbers in that doc have drifted; grep for the
functions.

## Scope

1. **BUG 1 (P0):** In the URL-streaming `getTile` in `src/loaders/nisar-loader.js`,
   stop propagating the deck.gl tile `signal` into `readChunksBatch` / `readRegion`
   chunk reads. Chunk reads should run to completion and populate the chunk cache even
   when the requesting tile has been aborted (recommended Option 1 in the audit).
   KEEP the signal check at the tile level: after chunks resolve, if
   `signal?.aborted`, return null without building the tile (cheap CPU skip) — the
   cached chunks serve the next request.
2. **BUG 3 (P1):** In `src/loaders/h5chunk.js` adaptive concurrency, exclude
   aborted/failed fetches from throughput samples — only completed requests adjust
   concurrency.
3. Add a regression note in both files: a one-line comment stating chunk reads are
   intentionally not abortable (constraint the code can't otherwise show).

## Out of scope

- BUG 2 (sparse RGB mosaic) — separate order later. No worker threads (W006). No
  viewport-stabilization debounce (P3 optional).

## Acceptance criteria

- `grep -n "signal" src/loaders/nisar-loader.js` shows no signal forwarded into
  `readChunksBatch(`/`readRegion(` calls from the URL getTile path.
- `npm test` passes; `npm run build` succeeds.
- New unit check (extend or add a small test file): a mock in which `readChunksBatch`
  is called with an already-aborted signal context still resolves chunk data (simulate
  with a stub fetch), and the adaptive-concurrency sampler ignores a batch containing
  an AbortError.

## Notes

W006 (decode workers) and W009 (L2 cache) build on these same functions — land this
first, keep the diff surgical.
