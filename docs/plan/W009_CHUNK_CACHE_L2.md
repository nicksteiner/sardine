# W009 — IndexedDB L2 chunk cache + MERGE_GAP tuning

wave: 1
status: branch-ready (commit d991340, stacked on W006 40fe086)
blocked_by: [W006]
branch: w009-chunk-cache-l2

## Findings (from implementation)

- Premise was doubly stale: `MERGE_GAP` was already 2 MB (commit `cc93320`) — now
  hoisted to an exported constant with rationale + test guards; and an interim
  unbounded Cache-API L2 (`src/utils/chunk-cache.js`) was already half-wired in the
  URL loader — replaced by the bounded IDB design and deleted. Old browser entries
  under `sardine-chunks-v1` are orphaned (harmless; optional one-time
  `caches.delete` cleanup later). `docs/CHUNK_PIPELINE.md` still says 256 KB —
  needs a doc touch-up.
- Design: two stores (`chunks` payloads, `meta` bytes/lastAccess with index) so LRU
  touches never rewrite ~1 MB buffers; unit-separator composite key scoped by dataset
  PATH (session-stable); serialized fire-and-forget write chain; permanent no-op
  degradation on any IDB failure; Float32-only, URL sources only.
- Key addition beyond the sketch: `readDataChunksBatch()` L2-probe helper routed
  through all FIVE batch sites (coarse, refinement, pan prefetch, overview prefetch,
  export stripe) — without it, reloads would still refetch nearly everything.
- 20 checks incl. simulated-reload L2 hit and LRU eviction order; full suite
  259+5+22+20 green; build clean.

## Objective

Repeat sessions on the same scene re-download every chunk. Add an IndexedDB-backed L2
cache under the in-memory Map (L1), and raise `MERGE_GAP` per
`docs/CHUNK_PIPELINE.md` "Future / High impact".

## Scope

- New `src/loaders/chunk-cache-idb.js`: `get(key)`, `put(key, buffer)`, size-bounded
  (~200 MB) LRU by last-access, keyed `(sourceUrl, datasetPath, chunkRow, chunkCol)`.
  Store DECODED Float32 buffers. Never block reads on IDB writes (fire-and-forget
  puts). Full no-op fallback when `indexedDB` undefined (Node/tests).
- Wire as L2 in the nisar-loader chunk cache path (`cacheChunk`/lookup — grep; design
  per `docs/CHUNKING_USABILITY_REVIEW.md` gap 3 layered-cache sketch).
- Cache only URL sources (local File objects have no stable key and read at disk
  speed — skip).
- Raise `MERGE_GAP` in `src/loaders/h5chunk.js` from 256 KB to 2 MB
  (`docs/CHUNK_PIPELINE.md` argues adjacent ~1 MB chunks merge into row-sized reads).
  Make it a named constant with the rationale comment.

## Out of scope

- No cache UI/settings. No service worker. No cross-origin cache sharing.

## Acceptance criteria

- `npm test` + `npm run build` pass; Node environment unaffected (no-op fallback
  unit-tested).
- Unit test with a fake in-memory IDB shim: L1 miss → L2 hit avoids the fetch stub;
  LRU evicts beyond the size bound.
- PR documents manual check: load remote scene, reload page, network tab shows
  substantially fewer Range requests on second load.
