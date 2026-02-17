# Chunk Pipeline: Implementation & Optimization

Technical overview of how SARdine streams HDF5 chunks from S3 (or local files) and renders them as map tiles. This document covers the runtime data flow, caching architecture, and optimization strategies — both implemented and future.

For background on *why* NISAR HDF5 files are cloud-optimized (paged aggregation, chunk layout), see [CLOUD_OPTIMIZED_HDF5.md](CLOUD_OPTIMIZED_HDF5.md).

---

## Architecture Overview

```
                         ┌──────────────────────────────┐
                         │  h5chunk.js  (HDF5 engine)   │
                         │                              │
  Pre-signed URL ───────►│  openUrl()                   │
  or File object         │    ├─ 8 MB metadata fetch    │
                         │    ├─ parseSuperblock()       │
                         │    └─ _scanForDatasets()      │
                         │                              │
                         │  _ensureChunkIndex()          │
                         │    └─ B-tree walk → Map       │
                         │                              │
                         │  readChunksBatch()            │
                         │    ├─ Resolve offsets         │
                         │    ├─ Sort + merge ranges     │
                         │    ├─ fetch() HTTP Range      │
                         │    └─ Decompress + decode     │
                         └──────────┬───────────────────┘
                                    │ Float32Array chunks
                         ┌──────────▼───────────────────┐
                         │  nisar-loader.js  (tile mgr)  │
                         │                              │
                         │  loadNISARGCOVFromUrl()        │
                         │    ├─ Parallel metadata reads │
                         │    ├─ Coordinate endpoint     │
                         │    │  fallback                │
                         │    └─ prefetchOverviewChunks() │
                         │                              │
                         │  getTile({x,y,z,bbox})        │
                         │    ├─ Tile result cache       │
                         │    ├─ readRegion path (≤1M px)│
                         │    ├─ Chunk-sample path       │
                         │    │  ├─ Phase 1: 8×8 coarse │
                         │    │  ├─ buildMosaicTile()    │
                         │    │  └─ Phase 2: 24×24 fine  │
                         │    └─ Foreground priority gate│
                         └──────────┬───────────────────┘
                                    │ {data, width, height, mask}
                         ┌──────────▼───────────────────┐
                         │  SARGPULayer.js               │
                         │    Upload R32F texture        │
                         │    GLSL: dB → stretch → cmap  │
                         └──────────────────────────────┘
```

---

## Stage 1: File Open (`h5chunk.js`)

### `openUrl(url, metadataSize?)`

A single HTTP Range request fetches the first **8 MB** of the file:

```
Range: bytes=0-8388607
```

NISAR's paged aggregation places all file-level metadata (superblock, object headers, B-tree root nodes, local/global heaps) at the front. 8 MB captures virtually all structural metadata — the `parseSuperblock()` → `_scanForDatasets()` pipeline runs entirely from this buffer with no additional HTTP requests for most files.

**Why 8 MB?** NISAR files have 150+ datasets. At 1 MB, only a fraction of the metadata fits, forcing ~280 sequential HTTP round-trips during tree walking (each ~130 ms to S3 = 36+ seconds). At 8 MB, tree walking completes from the buffer.

### Lazy tree walking

The `lazyTreeWalking: true` option (default for URL mode) defers B-tree index construction for each dataset until the first read. This avoids parsing B-trees for datasets that are never accessed (e.g., unused polarizations).

### `_ensureChunkIndex(datasetId)`

On first access to a dataset, the B-tree is walked to build a `Map<string, {offset, size, filterMask}>` — a complete index of every chunk's byte position in the file. For NISAR GCOV 512×512 chunks on a ~35000×35000 grid, this is ~4400 entries.

If B-tree nodes fall outside the 8 MB metadata buffer, `_fetchBytes()` is called with a read-ahead cache (512 KB window) to minimize HTTP round-trips.

---

## Stage 2: File Setup (`nisar-loader.js`)

### `loadNISARGCOVFromUrl(url, options)`

Orchestrates the full setup pipeline:

1. **Open file** — `h5chunk.openUrl()` with 8 MB metadata buffer
2. **Parallel metadata reads** — Coordinate arrays, dataset shapes, CRS, and band lists are read concurrently (not sequentially)
3. **Coordinate endpoint fallback** — Reads only the first and last elements of latitude/longitude arrays to compute bounds, rather than downloading the entire coordinate dataset
4. **Deferred identification** — `readProductIdentification()` runs in the background after `getTile` is available, so the first tile render isn't blocked by metadata parsing
5. **`prefetchOverviewChunks()`** — Eagerly fetches an 8×8 coarse grid of data chunks covering the full image, so the first z0 overview tile renders instantly from cache

---

## Stage 3: Tile Rendering (`getTile`)

`getTile({x, y, z, bbox})` is called by deck.gl for each visible tile. Two code paths exist based on the requested region size.

### Path A: readRegion (small tiles, ≤1M pixels)

For zoomed-in views where `sliceW × sliceH ≤ 1,048,576`:

```
bbox → pixel coords → streamReader.readRegion(dataset, top, left, h, w)
  → h5chunk resolves intersecting chunks
  → fetch + decompress → contiguous Float32Array
  → resample to 256×256 if needed
  → return {data, width, height, mask}
```

This path uses h5chunk's built-in `readRegion()` which handles chunk boundary stitching internally. Data and mask datasets are read in parallel via `Promise.all`.

### Path B: Chunk-sample mosaic (large tiles, >1M pixels)

For zoomed-out views covering large regions (e.g., the full z0 overview of a 35000×35000 image):

#### Phase 1: Coarse grid (foreground, blocking)

```
1. Compute chunk range: startCR..endCR × startCC..endCC
2. Sample 8×8 grid (stride = totalChunks / 8)
3. Batch-fetch uncached chunks via readChunksBatch()
4. buildMosaicTile(): sub-sample each chunk → bilinear interpolation → 256×256
5. Mask: use only already-cached mask chunks (no new HTTP fetches)
6. Return coarse tile immediately
```

The coarse grid intentionally matches the `prefetchOverviewChunks()` grid, so for z0 the entire Phase 1 completes from cache with **zero HTTP requests**.

#### Phase 2: Fine grid (background, non-blocking)

```
1. Wait for foreground idle (no getTile calls in-flight)
2. 200ms grace period + generation check
3. Sample 24×24 grid (3× density of Phase 1)
4. Batch-fetch uncached data chunks
5. Batch-fetch mask chunks (deferred from Phase 1)
6. buildMosaicTile() at fine resolution
7. Store in refinedTiles map, invalidate tile result cache
8. Notify via onRefine callback → deck.gl re-renders
```

The user sees the coarse tile within ~1 second, then the refined tile seamlessly replaces it.

### `buildMosaicTile(grid, rows, cols, ...)`

Converts a sparse grid of full-resolution chunks into a 256×256 tile:

1. **Sub-sample** — Each chunk is divided into `subN×subN` blocks (4–16 per dimension), box-averaged
2. **Assemble mosaic** — Sub-sampled values placed in a `(gridRows × subN) × (gridCols × subN)` array
3. **Bilinear interpolation** — Each output pixel mapped to mosaic coordinates, bilinearly interpolated from the 4 nearest samples
4. **NaN/zero masking** — Zero and NaN values excluded from interpolation weights

---

## Caching Architecture

### Chunk Cache (per-dataset)

```
chunkCache:     Map<"row,col", Float32Array>  — MAX_CHUNK_CACHE = 1000
maskChunkCache: Map<"row,col", Float32Array>  — MAX_CHUNK_CACHE = 1000
```

Keyed by chunk grid coordinates. LRU eviction (delete oldest entry when full). Shared across all `getTile` calls for the loaded dataset. Each chunk is 512×512 × 4 bytes = ~1 MB, so 1000 chunks ≈ 1 GB maximum.

### Tile Result Cache

```
tileResultCache: Map<"x,y,z,ml", {data, width, height, mask}>  — MAX_TILE_CACHE = 64
```

Caches the final 256×256 tile output. Prevents redundant chunk reads when deck.gl re-requests the same tile (e.g., during pan/zoom). Invalidated when Phase 2 refinement completes.

### Read-Ahead Cache (`_fetchBytes`)

```
_readAheadCache: {start, buffer}  — 512 KB window
```

For small metadata reads (<64 KB), the actual fetch is promoted to 512 KB. Subsequent reads in the same byte region hit the cache. This coalesces sequential B-tree walking reads into far fewer HTTP round-trips.

---

## Batch Coalescing (`readChunksBatch`)

The most impactful optimization for S3 streaming. Instead of N individual `fetch()` calls for N chunks:

```
Phase 1: Resolve chunk coordinates → file byte offsets (from B-tree index)
Phase 2: Sort by file offset ascending
Phase 3: Merge adjacent ranges (gap < MERGE_GAP = 256 KB)
           chunk A: [offset=1000, size=500]
           chunk B: [offset=1800, size=500]  ← gap = 300, merge!
           merged:  [offset=1000, size=1300]  ← one HTTP request
Phase 4: Fetch merged ranges (max 30 concurrent)
Phase 5: Slice merged buffers → decompress → decode each chunk
```

For a typical 8×8 = 64 chunk prefetch, this reduces ~64 HTTP requests to ~8–15 merged Range requests.

---

## Foreground Priority Gate

Background Phase 2 refinement can saturate S3 bandwidth, starving foreground tile requests. The priority gate prevents this:

```
_pendingForeground:     number   — count of in-flight getTile calls
_refinementGeneration:  number   — incremented on each _enterForeground()
_foregroundWaiters:     array    — promises resolved when foreground drains to 0
```

**Mechanism:**

1. `getTile()` calls `_enterForeground()` on entry, `_leaveForeground()` on exit (try/finally)
2. Phase 2 refinement calls `_waitForIdle()` — blocks until `_pendingForeground === 0`
3. After idle, a 200ms grace period lets follow-up tile requests claim priority
4. **Generation check**: if `_refinementGeneration` changed since scheduling, the refinement aborts entirely — it would fetch stale data for tiles the user has already scrolled past

This ensures 100% of S3 bandwidth goes to the tile the user is looking at right now.

---

## Key Constants

| Constant | Value | Location | Purpose |
|:---------|:------|:---------|:--------|
| Metadata buffer | 8 MB | `h5chunk.openUrl` | Initial metadata fetch size |
| READ_AHEAD | 512 KB | `h5chunk._fetchBytes` | Read-ahead cache window for small reads |
| MERGE_GAP | 256 KB | `h5chunk.readChunksBatch` | Maximum gap between chunks to merge into one HTTP request |
| MAX_CONCURRENT | 30 | `h5chunk.readChunksBatch` | Maximum parallel HTTP requests per batch |
| COARSE_MAX | 8 | `nisar-loader.getTile` | Coarse grid dimension (Phase 1) |
| FINE_MAX | 24 | `nisar-loader.getTile` | Fine grid dimension (Phase 2) |
| MAX_CHUNK_CACHE | 1000 | `nisar-loader` (URL path) | Maximum cached chunks per dataset |
| MAX_TILE_CACHE | 64 | `nisar-loader` (URL path) | Maximum cached tile results |
| MAX_DIRECT_PIXELS | 1M | `nisar-loader.getTile` | Threshold for readRegion vs chunk-sample path |
| Grace period | 200 ms | `nisar-loader` Phase 2 | Delay before refinement starts after foreground idle |

---

## Performance Profile

Benchmark against 5 NISAR GCOV files on S3 (us-west-2, pre-signed URLs), measured with `test-chunk-pipeline.mjs`:

| Metric | Target | Typical |
|:-------|:-------|:--------|
| First paint (load + prefetch + z0) | < 10 s | 2–8 s |
| All foreground tiles (z0 → z8 transect) | < 30 s | 12–35 s |
| z0 tile from cache | — | < 1 s |
| Phase 2 refinement | — | 0 reqs (if tiles already cached) |
| HTTP requests per file open | — | ~40–80 (metadata + prefetch) |

File dimensions range from 33840×33120 to 40032×40176 pixels, with 512×512 chunks (deflate + shuffle compression).

---

## Optimization Opportunities

### Implemented

1. **8 MB metadata buffer** — Eliminates ~280 sequential HTTP round-trips during tree walking
2. **Lazy B-tree walking** — Only builds chunk index for accessed datasets
3. **Batch coalescing** — Merges nearby chunk reads into fewer HTTP requests (MERGE_GAP = 256 KB)
4. **Read-ahead cache** — 512 KB window for metadata tree walking
5. **Parallel metadata reads** — Coordinates, shapes, CRS read concurrently
6. **Coordinate endpoint fallback** — Reads first/last elements instead of full coordinate arrays
7. **Deferred identification** — Product metadata parsed in background, doesn't block first render
8. **Overview prefetch** — 8×8 chunk grid fetched eagerly, matching Phase 1 grid
9. **Progressive refinement** — Coarse → fine two-phase tile rendering
10. **Foreground priority gate** — Background refinement yields to user-facing requests
11. **Generation-based abort** — Stale refinements cancelled when user navigates
12. **Deferred mask chunks** — Phase 1 uses only cached masks; Phase 2 fetches new ones
13. **Tile result cache** — Avoids redundant chunk reads on tile re-request

### Future

**High impact:**

- **Increase MERGE_GAP to 2–4 MB** — NISAR chunks are stored sequentially by dataset. With 512×512 × 4 bytes ≈ 1 MB per chunk, a 256 KB gap means adjacent chunks are almost always mergeable. A larger gap could merge entire rows of chunks into single HTTP requests, cutting request count by 3–5×. The trade-off is fetching some unused bytes in the gaps, but at S3 throughput this is negligible.

- **Adaptive metadata buffer** — Files with larger coordinate arrays or more datasets may need 16–32 MB. Detecting metadata overflow (tree walking falls outside buffer) and issuing a second metadata fetch could eliminate residual `_fetchBytes` round-trips.

- **readProductIdentification before prefetch** — Currently identification reads run concurrently with prefetch, competing for bandwidth. Awaiting identification (or reading it from the metadata buffer) before starting prefetch would give prefetch uncontested bandwidth.

**Medium impact:**

- **CDN / CloudFront** — Pre-signed S3 URLs go directly to the S3 endpoint. A CloudFront distribution in front of the bucket reduces per-request latency by ~50–80 ms (edge caching, connection reuse, TCP optimization). For 40+ requests per file load, this saves 2–3 seconds.

- **Multi-range requests** — HTTP/2 allows multiple Range requests to be multiplexed on a single connection. Currently each merged range is a separate `fetch()`. Batching into fewer connections could reduce TLS handshake overhead.

- **Predictive chunk prefetch** — When the user pans, predict which tiles will be needed next and start fetching their chunks before deck.gl requests them. This turns "fetch on demand" into "fetch ahead of demand."

**Low impact (diminishing returns):**

- **WebWorker decompression** — Deflate + shuffle decompression currently runs on the main thread. For large batches (>20 chunks), offloading to a Worker pool could free the main thread. In practice, decompression time is dwarfed by network latency.

- **Chunk cache compression** — Store cached chunks as compressed ArrayBuffers to reduce memory. Decompression on cache hit adds ~1 ms per chunk but could double effective cache capacity.

- **Shared chunk cache across datasets** — Currently each `loadNISARGCOVFromUrl` call has its own chunk cache. If the user switches polarizations on the same file, mask chunks could be shared.

---

## File Reference

| File | Lines | Role |
|:-----|:------|:-----|
| `src/loaders/h5chunk.js` | ~2800 | HDF5 format parser, chunk index builder, batch fetcher |
| `src/loaders/nisar-loader.js` | ~4300 | NISAR product logic, tile management, caching, refinement |
| `test/test-chunk-pipeline.mjs` | ~300 | S3 streaming benchmark (first paint, foreground tiles, Phase 2) |
