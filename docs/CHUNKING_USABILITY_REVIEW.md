# Chunking Usability Review

Review of `h5chunk.js` and `nisar-loader.js` for high-bandwidth remote streaming.

## Deployment Context

SARdine is browser-native, GPU-first. The target scenario is a user on a
reasonable home/office connection (50–500 Mbps) streaming NISAR GCOV HDF5 files
from S3 or similar object storage. No tile server, no pre-rendered pyramids.

Cloud GPU instances (e.g. g4dn with T4) are optimal for hosted interactive use
but expensive. The CPU fallback (`SARBitmapLayer`) works but is 240–720× slower
for interactive parameter changes (contrast, colormap, stretch). For a
"plug in and use" experience, the client's own GPU is the right target — the
network path is where usability breaks down.

## What Works Well

### Metadata prefetch (h5chunk.js:1178–1200)

A single 8 MB Range request captures virtually all HDF5 structural metadata for
NISAR files, avoiding ~280 sequential round-trips that naive 1 MB fetches would
require. On 100 Mbps this takes ~0.6 s — acceptable.

### Batch coalesced reads (h5chunk.js:2569–2690)

`readChunksBatch()` sorts chunks by file offset and merges adjacent ranges
within a 256 KB gap. This collapses N individual fetch() calls into far fewer
HTTP requests. The 30-request concurrency cap prevents browser connection
exhaustion.

### Foreground priority gating (nisar-loader.js:3773–3796)

Phase 2 background refinement defers until foreground tile requests complete.
`_enterForeground()` / `_leaveForeground()` prevent background chunk fetches
from saturating bandwidth during active pan/zoom. Generation counter
(`_refinementGeneration`) signals stale refinements to abort.

### Overview prefetch (nisar-loader.js:4218–4265)

An 8×8 coarse chunk grid is eagerly fetched so the initial zoomed-out view
renders from cache. Uses `readChunksBatch()` for coalesced fetching.

### Read-ahead cache (h5chunk.js:1221–1249)

Small reads (<64 KB) during tree-walking are promoted to 512 KB fetches. The
surplus is cached, coalescing sequential tiny reads into far fewer HTTP
round-trips.

## Gaps

### 1. No fetch cancellation

**Impact: High — wasted bandwidth and blocked connections on pan/zoom.**

Zero uses of `AbortController` or `AbortSignal` across both `h5chunk.js` and
`nisar-loader.js`. When the user pans or zooms:

- In-flight chunk fetches for tiles no longer in the viewport run to completion
- The 30-connection concurrency cap means new viewport tiles queue behind stale
  requests
- The refinement generation counter (nisar-loader.js:3780) prevents *processing*
  stale results, but the HTTP requests still consume bandwidth

**Recommendation:** Thread an `AbortSignal` through `readChunk()`,
`readChunksBatch()`, and `_fetchBytes()`. Expose a per-tile abort handle so the
tile layer can cancel in-flight fetches when tiles leave the viewport. deck.gl's
`TileLayer` already calls `onTileUnload` — wire this to abort.

```js
// h5chunk.js — readChunk with signal support
async readChunk(datasetId, row, col, { signal } = {}) {
  // ...existing resolution logic...
  const response = await fetch(this.url, {
    headers: { 'Range': `bytes=${offset}-${offset + size - 1}` },
    signal, // ← AbortController.signal
  });
  // ...decompress + decode...
}
```

### 2. No progress reporting

**Impact: Medium — user sees "Loading..." with no feedback.**

`h5chunk.js` has zero callbacks or progress events. The 8 MB metadata fetch
(h5chunk.js:1187) and batch chunk reads provide no way to report intermediate
progress. The app's `StatusWindow` component exists but receives no granular
events from the loader.

**Recommendation:** Add an optional `onProgress` callback to `openUrl()` and
`readChunksBatch()`. Report bytes fetched, chunks resolved, and estimated
remaining. Use `Response.body.getReader()` for streaming progress on the initial
metadata fetch.

```js
// Streaming progress for metadata fetch
const response = await fetch(url, { headers: { Range: `bytes=0-${readSize-1}` } });
const reader = response.body.getReader();
let received = 0;
const chunks = [];
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(value);
  received += value.length;
  onProgress?.({ phase: 'metadata', loaded: received, total: readSize });
}
```

### 3. No persistent chunk cache

**Impact: Medium — page reload discards all cached chunks.**

All chunk caches are in-memory `Map` objects (nisar-loader.js:1687–1688,
3729–3730). The 500–1000 entry LRU is reasonable for a session, but closing the
tab or reloading the page means re-downloading every chunk from scratch.

For NISAR workflows where users repeatedly explore the same scene across
sessions, this is a significant usability penalty.

**Recommendation:** Add an IndexedDB-backed chunk cache keyed by
`(url, datasetPath, chunkRow, chunkCol)`. Persist the overview prefetch chunks
(~64 entries) at minimum. Use a size-bounded store (e.g. 200 MB) with LRU
eviction. The in-memory Map stays as L1; IndexedDB serves as L2.

```js
// Layered cache: Map (L1) → IndexedDB (L2) → HTTP fetch (L3)
async function getChunk(key) {
  if (memoryCache.has(key)) return memoryCache.get(key);
  const persisted = await idbGet('chunks', key);
  if (persisted) { memoryCache.set(key, persisted); return persisted; }
  const fetched = await fetchChunk(key);
  memoryCache.set(key, fetched);
  idbPut('chunks', key, fetched); // async, don't await
  return fetched;
}
```

### 4. Cooperative refinement abort doesn't cancel HTTP

**Impact: Low-Medium — bandwidth wasted on discarded refinement chunks.**

The refinement system (nisar-loader.js:3780, 4060–4062) uses a generation
counter to detect stale refinements. When the user enters a new foreground
request, `_refinementGeneration` increments. Pending refinement coroutines
check this and bail — but their in-flight `fetch()` calls have already been
dispatched and continue to completion.

**Recommendation:** Each refinement batch should carry an `AbortController`.
When `_enterForeground()` fires, abort the current refinement controller. This
is a natural extension of gap #1.

### 5. No adaptive concurrency

**Impact: Low — suboptimal for both slow and very fast connections.**

The 30-request concurrency limit (h5chunk.js:2652) is hardcoded. On a 10 Mbps
connection, 30 concurrent requests may saturate the link and increase latency.
On a 1 Gbps connection, 30 may underutilize available bandwidth.

**Recommendation:** Not a priority. 30 is a reasonable default for most
scenarios. If addressed later, measure round-trip time on early fetches and
adjust concurrency dynamically (AIMD-style).

## Priority Order

| Priority | Gap | Effort | Impact |
|----------|-----|--------|--------|
| 1 | Fetch cancellation (AbortController) | Medium | High |
| 2 | Progress reporting | Low | Medium |
| 3 | Persistent chunk cache (IndexedDB) | Medium | Medium |
| 4 | Refinement abort cancels HTTP | Low | Low-Medium |
| 5 | Adaptive concurrency | Low | Low |

Items 1 and 2 are the highest-leverage changes for making "plug in on good
bandwidth" feel responsive. Item 3 matters most for repeated-session workflows.
