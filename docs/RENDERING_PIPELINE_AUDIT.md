# SARdine S3 Streaming & Tile Rendering Pipeline — Full Audit Brief

## Purpose

This document describes the complete data flow from file open to pixel on screen for NISAR GCOV HDF5 files loaded via S3 presigned URLs. It identifies known bugs, architectural issues, and provides enough context for a fresh agent to audit the pipeline end-to-end and write tests.

---

## 1. Architecture Overview

```
User opens NISAR file (S3 presigned URL)
  │
  ▼
loadNISARGCOVFromUrl()              [nisar-loader.js:3857]
  ├─ h5chunk opens URL, parses HDF5 superblock + metadata (~8 MB read-ahead)
  ├─ Reads coordinate arrays (xCoordinates, yCoordinates)
  ├─ Computes bounds, CRS, pixel spacing
  ├─ Returns: { getTile, getRGBTile, bounds, width, height, ... }
  │
  ▼
SARViewer.jsx receives getTile + bounds
  ├─ Computes defaultViewState from bounds (zoom, center)
  ├─ Creates SARTileLayer with stable getTileData reference
  │
  ▼
deck.gl TileLayer lifecycle
  ├─ Computes visible tiles for current viewState + zoom
  ├─ Calls getTileData(tile) for each tile
  │     └─ tile = { index: {x,y,z}, bbox, signal: AbortController.signal }
  ├─ Caches returned data per tile
  ├─ Calls renderSubLayers() to create SARGPULayer per tile
  │
  ▼
SARGPULayer                         [SARGPULayer.js]
  ├─ Uploads Float32Array as WebGL2 R32F texture
  ├─ Fragment shader: amplitude → dB → normalize → stretch → colormap → RGBA
  └─ Renders textured quad with deck.gl projection
```

---

## 2. File Locations & Key Line Numbers

| File | Purpose | Key Lines |
|------|---------|-----------|
| `src/loaders/nisar-loader.js` | NISAR GCOV loader (3 getTile implementations) | ~5000 lines |
| `src/loaders/h5chunk.js` | Cloud-optimized HDF5 chunk reader | ~2900 lines |
| `src/viewers/SARViewer.jsx` | React viewer with deck.gl | 1-468 |
| `src/layers/SARTileLayer.js` | deck.gl TileLayer wrapper | 1-207 |
| `src/layers/SARGPULayer.js` | Custom GPU layer (R32F → GLSL) | 1-545 |
| `src/layers/shaders.js` | GLSL fragment shader source | |
| `src/utils/s3-url.js` | S3 URL normalization | 1-71 |
| `src/utils/s3-presign.js` | AWS SigV4 presigning | |
| `app/main.jsx` | Main application | ~3000 lines |

---

## 3. The Three `getTile` Implementations

### 3A. Legacy h5wasm getTile (line ~2501)

- **Used for:** Local File objects loaded via h5wasm (full in-memory)
- **Signal handling:** None (no signal parameter)
- **Strategy:** Direct dataset.slice() — reads pixels from in-memory buffer
- **Not relevant to S3 streaming bugs**

### 3B. RGB Composite `getRGBTile` (line ~3112)

- **Used for:** Multi-band composites (Pauli, dual-pol) via h5chunk streaming
- **Signal handling:** **NONE — does not accept signal parameter**
- **Signature:** `async function getRGBTile({ x, y, z, bbox, multiLook = false })`
- **Strategy:**
  1. Convert bbox to pixel coordinates (handles both pixel-space and world-coord tiles)
  2. Coarse grid: `COARSE_MAX = 4`, strides if >4 chunks per axis
  3. Batch fetch uncached chunks per polarization via `readChunksBatch(dsId, coords)` — **no signal**
  4. Sample pixels from cached chunks, average with NaN/zero exclusion
  5. Return `{ bands: {pol1: Float32Array, pol2: ...}, width, height, compositeId }`
- **Known issues:**
  - Does NOT use `buildMosaicTile` — renders sparse grid directly (unfetched chunks → 0/transparent)
  - No progressive refinement (Phase 2) like single-band path
  - At stride=2, only ~25-30% of pixel sample points hit fetched chunks

### 3C. URL Streaming `getTile` (line ~4258) — **PRIMARY S3 PATH**

- **Used for:** Single-band polarization data loaded from presigned S3 URLs
- **Signal handling:** **YES — accepts and propagates signal**
- **Signature:** `const getTile = async ({ x, y, z, bbox, multiLook, signal }) => {`
- **Strategy:**

  **Small tiles (< 1M pixels):** Direct `readRegion()` with signal (line 4316)

  **Large tiles (overview zooms):** Two-phase progressive rendering:

  **Phase 1 — Coarse Grid (foreground, signal propagated):**
  - `COARSE_MAX = 4` (line 4372)
  - Stride: `Math.max(1, Math.ceil(totalChunks / COARSE_MAX))` per axis
  - Batch fetch: `readChunksBatch(datasetId, coords, { signal })` (line 4401) ← **SIGNAL PASSED**
  - Builds mosaic tile via `buildMosaicTile()` (line 4416) with bilinear interpolation
  - Returns immediately (fast first paint)

  **Phase 2 — Background Refinement (no signal, generation-gated):**
  - `FINE_MAX = 24` (line 4441)
  - Waits for idle: `_waitForIdle()` before fetching
  - Batch fetch: `readChunksBatch(datasetId, coords)` — **NO signal**
  - Checks generation counter to abort if new foreground work started
  - Stores refined tile for next request from same tile index

---

## 4. Signal Flow — The Abort Cascade Bug

### How signals flow:

```
deck.gl TileLayer
  │ Creates AbortController per tile
  │ Passes signal via tile object
  ▼
SARViewer.jsx stableGetTileData (line 73-84)
  │ Extracts signal from tile: const { bbox, signal } = tile;
  │ Passes to getTile: getTileRef.current({ ..., signal })
  ▼
nisar-loader.js getTile (line 4258)
  │ Passes signal to readRegion and readChunksBatch
  ▼
h5chunk.js readChunksBatch (line 2662)
  │ Passes signal to each fetch() call (line 2743):
  │   fetch(this.url, { headers: {...}, signal })
  ▼
Browser fetch API
  │ If signal.aborted → throws AbortError immediately
  │ If signal fires during fetch → rejects with AbortError
```

### When abort happens:

1. `loadNISARGCOVFromUrl` returns `{ getTile, bounds }`
2. `main.jsx` sets `bounds` state → triggers React re-render
3. `SARViewer` computes new `defaultViewState` from bounds (useMemo on bounds)
4. `useEffect` fires: `setViewState(defaultViewState)` — viewport changes
5. deck.gl re-evaluates visible tiles for new viewport
6. **deck.gl aborts ALL in-flight tile requests from the old viewport** (signals fire)
7. All `fetch()` calls in `readChunksBatch` reject with `AbortError: signal is aborted without reason`
8. `getTile` returns error/null for every tile
9. h5chunk adaptive concurrency sees failures, reduces concurrency (12→8→6)
10. New viewport's tiles start fresh, but may be aborted again if another state change triggers

### Why prefetch works but tiles don't:

- `prefetchOverviewChunks` (line ~3586 for RGB, line ~4754 for single-band) does **NOT** pass signal
- It runs as fire-and-forget from `loadNISARGCOVFromUrl` before any tiles are requested
- Chunks are cached successfully in the h5chunk chunk cache
- But when tiles try to USE those chunks via `getTile`, the signal abort prevents the tile from completing

### Console evidence:

```
[h5chunk] readChunksBatch: 4 coords for dataset ... [SIGNAL PASSED]
[h5chunk] Chunk read failed: signal is aborted without reason
[h5chunk] Chunk read failed: signal is aborted without reason
[h5chunk] Adaptive concurrency: 12 → 8 (avg 0.0 MB/s)
```

---

## 5. The Viewport Stabilization Problem

### Root cause sequence in main.jsx:

```javascript
// 1. handleLoadRemoteNISAR calls loadNISARGCOVFromUrl
const result = await loadNISARGCOVFromUrl(url, options);

// 2. Sets state that triggers SARViewer re-render
setBounds(result.bounds);           // → SARViewer computes new viewState
setGetTile(() => result.getTile);   // → Creates SARTileLayer

// 3. SARViewer.jsx reacts:
// - bounds change → useMemo recalculates defaultViewState
// - useEffect fires setViewState(defaultViewState)
// - deck.gl receives new viewState → recalculates tiles → aborts old ones
```

### The timing problem:

SARTileLayer starts requesting tiles **before** the viewport has stabilized. deck.gl creates tiles for the initial viewState, fires getTileData, then immediately aborts them when viewState updates from the bounds change. This can happen 2-3 times:

1. Initial viewState (default zoom=0, target=[0,0])
2. Bounds-derived viewState (zoom=-8, target=[center])
3. Any additional state changes (contrast limits auto-calc, etc.)

---

## 6. h5chunk Internals

### readChunksBatch (line 2662)

1. **Phase 1:** Resolve chunk coordinates → file byte offsets via B-tree index
2. **Phase 2:** Sort by file offset, merge nearby ranges (gap < MERGE_GAP bytes)
3. **Phase 3:** Fetch merged ranges in parallel with adaptive concurrency
   - `fetch(url, { headers: { Range: ... }, signal })` (line 2741-2744)
   - Measures throughput per batch, adapts concurrency
4. **Phase 4:** Extract individual chunks from merged buffers, decompress (pako inflate + shuffle)

### readChunk (line 2570)

- Single chunk read with signal support
- Used by `readRegion` internally (parallel Promise.all of readChunk calls)

### _fetchBytes (line 1296)

- Low-level byte reader for metadata/tree walking
- **Does NOT accept signal** — used only during file open (superblock, B-tree traversal)
- Has 512KB read-ahead cache for sequential tree walks

### Adaptive Concurrency (line ~1180-1208)

- Starts at `_concurrency = 6` (default)
- Adjusts based on throughput samples:
  - `>20 MB/s` → increase by 4 (up to max)
  - `>5 MB/s` → increase by 2
  - `<1 MB/s` → decrease by 4 (down to min)
  - `<3 MB/s` → decrease by 2
- **Problem:** AbortErrors register as 0 MB/s throughput, causing aggressive concurrency reduction even though the network is fine

### Streaming Stats

- `getStreamingStats()` returns `{ totalBytes, totalRequests, elapsedMs, currentMbps, avgMbps, concurrency }`
- `onStreamingStats` callback fires after each batch
- Used by `ThroughputOverlay.jsx` for live HUD display

---

## 7. SARViewer → SARTileLayer → SARGPULayer Pipeline

### SARViewer.jsx (line 23-355)

**Stable getTileData pattern (line 65-84):**
```javascript
const getTileRef = useRef(getTile);
getTileRef.current = getTile;
const stableGetTileData = useCallback(async (tile) => {
  const { bbox, signal } = tile;          // ← EXTRACTS SIGNAL
  return await getTileRef.current({
    x: tile.index.x, y: tile.index.y, z: tile.index.z,
    bbox, multiLook: multiLookRef.current,
    signal,                                // ← PASSES SIGNAL THROUGH
  });
}, []);  // Empty deps = never changes identity
```

**Purpose:** Prevents deck.gl from re-fetching tiles when visual props change (contrast, colormap, gamma). The function reference stays stable; only rendering params change via `updateTriggers`.

**Layer creation (line 218-235):**
```javascript
new SARTileLayer({
  id: `sar-tile-layer-v${tileVersion}`,   // Version changes = new layer = full re-fetch
  getTileData: stableGetTileData,
  bounds, contrastLimits, useDecibels, colormap, gamma, stretchMode, opacity, multiLook, useMask,
})
```

### SARTileLayer.js (line 13-166)

- Extends deck.gl `TileLayer`
- `minZoom` auto-calculated from bounds: `minZoom = -Math.ceil(Math.log2(maxSpan / tileSize))`
  - For a 16704×16272 image with bounds in degrees: minZoom ≈ -8
- `updateTriggers.renderSubLayers` includes visual props → sublayers re-render without re-fetch
- `renderSubLayers` creates `SARGPULayer` per tile:
  - Single-band: passes `tileData.data` (Float32Array) + tile bounds
  - RGB: passes `tileData.bands` through `computeRGBBands()` → 3 Float32Arrays as dataR/G/B

### SARGPULayer.js (line 173-545)

- Custom deck.gl Layer (not a sublayer of TileLayer — it's a standalone layer)
- Creates world-coordinate quad geometry from tile bounds
- Uploads Float32Array as R32F texture via raw WebGL2 API (luma.gl doesn't support R32F well)
- Fragment shader handles:
  - dB conversion: `10 * log2(amplitude) * 0.30103` (log10 via log2)
  - Contrast normalization: `(dB - min) / (max - min)`
  - Stretch modes: linear, sqrt, gamma, sigmoid
  - Colormaps: grayscale, viridis, inferno, plasma, phase, sardine, flood, diverging, polarimetric
  - NaN/zero masking → alpha = 0
  - NISAR mask support (0=invalid, 255=fill → transparent)
  - RGB mode: 3 separate R32F textures with per-channel contrast

---

## 8. Known Bugs & Issues

### BUG 1: Signal Abort Cascade (CRITICAL — tiles never render)

**Symptom:** All chunk reads fail with "signal is aborted without reason". No tiles render.

**Root cause:** deck.gl aborts tile signals during viewport stabilization (bounds change → viewState update). Signal propagates through stableGetTileData → getTile → readChunksBatch → fetch().

**Fix options:**
1. **Don't pass signal to chunk reads** — let them complete and cache the data even if the tile is no longer needed. The cached chunks will be used by the next tile request.
2. **Delay tile layer creation** until viewport has stabilized (add a debounce or wait for bounds + viewState to settle before creating SARTileLayer).
3. **Catch AbortError in getTile** and return the partially-cached data instead of throwing.

**Recommended:** Option 1 (simplest, most robust). The chunk cache makes aborted reads wasteful but harmless. Remove `{ signal }` from the `readChunksBatch` and `readRegion` calls in getTile. Background prefetch already works this way.

### BUG 2: Sparse Tile Rendering in RGB Path

**Symptom:** RGB overview tiles at low zoom are mostly transparent/invisible.

**Root cause:** `getRGBTile` uses coarse grid (COARSE_MAX=4, stride=2) but does NOT use `buildMosaicTile` for interpolation. Pixel samples that fall in unfetched chunks return 0/NaN → transparent. At stride=2, ~70% of pixel samples miss.

**Fix:** Port the `buildMosaicTile` approach from single-band to RGB, OR implement per-chunk sub-sampling where each fetched chunk contributes a representative block of pixels.

### BUG 3: Adaptive Concurrency Decay from AbortErrors

**Symptom:** Concurrency drops from 12→8→6 even on fast connections.

**Root cause:** When fetch() is aborted, the throughput for that batch registers as ~0 MB/s. The adaptive algorithm treats this as a slow connection and reduces concurrency.

**Fix:** Don't count AbortError failures in throughput measurement. Only adapt concurrency based on completed requests.

### BUG 4: Layer Recreation Storm (PARTIALLY FIXED)

**Symptom:** SARTileLayer gets recreated 2-5 times during initial load, each time re-fetching all tiles.

**Partial fix already applied:** `stableGetTileData` pattern prevents re-fetch on visual prop changes. `tileVersion` in layer ID allows explicit source changes without being affected by visual prop updates.

**Remaining:** Layer is still recreated when `bounds` changes (it's in the useMemo dependency array for layers). This is correct behavior but means tiles are requested, aborted, and re-requested during initialization.

---

## 9. Tile Coordinate System

### How deck.gl tiles map to pixel coordinates:

At zoom level `z`, the world is divided into `2^z × 2^z` tiles of size `tileSize` (256) world units each.

For NISAR data with bounds like `[west, south, east, north]` in degrees:
- `minZoom = -Math.ceil(Math.log2(maxSpan / 256))`
- At z=-8: each tile covers `256 * 2^8 = 65536` world units
- The entire image fits in ~1 tile at z=-8

**Pixel coordinate calculation in getTile (line ~4270-4310):**
```javascript
// bbox comes from deck.gl tile with left/top/right/bottom in world coords
const wPerPx = (bounds[2] - bounds[0]) / width;   // world units per pixel
const hPerPx = (bounds[3] - bounds[1]) / height;

const pxLeft = Math.floor((tileLeft - bounds[0]) / wPerPx);
const pxTop  = Math.floor((tileTop - bounds[1]) / hPerPx);
const pxRight = Math.ceil((tileRight - bounds[0]) / wPerPx);
const pxBottom = Math.ceil((tileBottom - bounds[1]) / hPerPx);
```

**World-coord vs pixel-coord tiles:**
- At very negative z (e.g., z=0 with large world bounds), tiles may cover areas entirely outside the image → getTile returns null
- The `extent` prop on TileLayer should prevent requesting these, but in practice some leak through

---

## 10. Chunk Cache Architecture

### In nisar-loader.js:

```javascript
const chunkCache = new Map();        // key: "row,col" → Float32Array
const MAX_CHUNK_CACHE = 512;         // LRU eviction at this size

function cacheChunk(key, data) {
  if (chunkCache.size >= MAX_CHUNK_CACHE) {
    chunkCache.delete(chunkCache.keys().next().value);  // Evict oldest
  }
  chunkCache.set(key, data);
}
```

- Separate caches per polarization for RGB (`chunkCaches = { HHHH: Map, HVHV: Map, ... }`)
- Separate mask chunk cache (`maskChunkCache`)
- Tile-level cache: `tileCache = new Map()` with key `"z/x/y"` (stores rendered tile data)
- `refinedTiles = new Map()` — stores Phase 2 refined versions

### In h5chunk.js:

- No chunk cache at the h5chunk level — caching is done by nisar-loader
- h5chunk maintains a read-ahead buffer (`_readAheadCache`) for sequential metadata reads only

---

## 11. Prefetch Architecture

### Overview Prefetch (runs at file open, before any tiles)

**Single-band** (line ~4754): `prefetchOverviewChunks`
- Calculates stride to sample ~16 chunks across entire dataset
- `COARSE_MAX = 4` per axis
- Batch fetch via `readChunksBatch(datasetId, coords)` — **NO signal**
- Runs as fire-and-forget (doesn't block file open return)

**RGB** (line ~3586): `prefetchOverviewChunks`
- Same strategy but per-polarization
- `step = Math.max(1, Math.floor(Math.sqrt(nChunkRows * nChunkCols / 16)))`
- Batch fetch per pol — **NO signal**

### Predictive Prefetch (runs during tile requests)

**Single-band only** (line ~4307): `_prefetchAhead`
- Tracks viewport history (`_trackViewport`)
- Predicts next likely viewport from pan/zoom direction
- Fetches chunks for predicted viewport
- Low priority, yields to foreground work

---

## 12. Testing Recommendations

### Unit Tests Needed:

1. **WKT Parser** — `src/utils/wkt.js`: Parse POLYGON, MULTIPOLYGON, BBOX, validate, convert to GeoJSON
2. **ROI Subset** — `src/utils/roi-subset.js`: Geographic bbox → pixel range mapping
3. **Tile coordinate mapping**: Verify pixel coordinate calculation for various zoom levels (z=-8 to z=0)
4. **Coarse grid calculation**: Verify COARSE_MAX=4 produces correct stride for various chunk counts
5. **buildMosaicTile**: Verify bilinear interpolation from sparse chunk grid

### Integration Tests Needed:

1. **Signal propagation test**: Create a mock AbortController, pass signal through getTile → readChunksBatch → verify fetch receives it (or verify it's NOT propagated, depending on fix)
2. **Viewport stabilization test**: Simulate bounds change → viewState update → verify tiles eventually render
3. **Chunk cache hit test**: Prefetch chunks, then request tile → verify no HTTP requests (all cache hits)
4. **Adaptive concurrency test**: Verify AbortErrors don't reduce concurrency
5. **S3 presigned URL preservation**: Verify `normalizeS3Url` does NOT rewrite URLs with `X-Amz-Signature` query params

### End-to-End Tests:

1. **Load NISAR from S3 presigned URL** → verify tiles render within 10 seconds
2. **Switch polarization** → verify old tiles cleared, new tiles load
3. **RGB composite** → verify 3 bands load and render
4. **Zoom in/out** → verify progressive refinement (coarse → fine)
5. **Export GeoTIFF** → verify output dimensions and georeference match input

### Performance Benchmarks:

1. **Time to first tile**: From URL load start to first visible tile
2. **Chunk fetch efficiency**: Number of HTTP requests vs number of chunks needed
3. **Cache hit rate**: After overview prefetch, what % of tile requests are fully cached?
4. **Throughput**: Sustained MB/s during bulk chunk loading

---

## 13. Quick Reference: Signal Handling Summary

| Location | Function | Signal? | Notes |
|----------|----------|---------|-------|
| `SARViewer.jsx:76` | `stableGetTileData` | Passes through | Extracts from deck.gl tile |
| `nisar-loader.js:4258` | `getTile` (URL streaming) | **Accepts** | Passes to readRegion + readChunksBatch |
| `nisar-loader.js:4316` | `readRegion` call | **YES** | Direct small-tile path |
| `nisar-loader.js:4401` | `readChunksBatch` Phase 1 | **YES** | Coarse grid foreground |
| `nisar-loader.js:4480` | `readChunksBatch` Phase 2 | NO | Background refinement |
| `nisar-loader.js:3112` | `getRGBTile` | NO | Never receives signal |
| `nisar-loader.js:3605` | RGB prefetch | NO | Fire-and-forget |
| `nisar-loader.js:4777` | Single-band prefetch | NO | Fire-and-forget |
| `h5chunk.js:2662` | `readChunksBatch` | **Accepts** | Passes to each fetch() |
| `h5chunk.js:2570` | `readChunk` | **Accepts** | Passes to fetch() |
| `h5chunk.js:2835` | `readRegion` | **Accepts** | Passes to readChunk |
| `h5chunk.js:1296` | `_fetchBytes` | NO | Metadata only |

---

## 14. Immediate Fix Priority

1. **P0: Remove signal propagation from getTile to chunk reads** — This unblocks all tile rendering. Chunks should always complete and cache. The cost of fetching a few extra chunks (from tiles that get aborted) is negligible compared to rendering nothing.

2. **P1: Don't count AbortErrors in adaptive concurrency** — Prevents false throughput degradation.

3. **P2: Port buildMosaicTile to RGB path** — Fixes sparse overview rendering for composites.

4. **P3: Debounce viewport stabilization** — Optional optimization to reduce wasted tile requests during initialization.
