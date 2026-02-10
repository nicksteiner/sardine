# SARdine Codebase Audit

**Date:** 2026-02-10
**Scope:** Full read audit — code quality, security, cloud infrastructure readiness

---

## Executive Summary

SARdine is a well-architected **browser-native SAR viewer** with GPU-first rendering, cloud-optimized HDF5 streaming, and COG support. The core rendering pipeline (h5chunk → WebGL2 shaders → screen) is solid. However, the project sits at an inflection point: it works excellently as a **single-user local/JupyterHub viewer** but is missing key infrastructure to function as a component in a modern **cloud-native SAR processing ecosystem**.

### What Works Well
- GPU-accelerated rendering pipeline (WebGL2 GLSL shaders)
- Cloud-optimized HDF5 streaming via h5chunk (pure JS, no WASM dependency for I/O)
- COG loading via HTTP Range requests
- S3 presigned URL generation (browser-native Web Crypto SigV4)
- Client-side GeoTIFF export with proper georeferencing
- Zero external server dependency for core functionality

### What's Missing for Cloud Infrastructure
- **No STAC catalog integration** (no search, no item loading, no collection browsing)
- **No Nextflow/pipeline hooks** (no job submission, status polling, or output routing)
- **No Docker/container image** (no Dockerfile, no CI/CD)
- **No authentication layer** (relies on filesystem permissions)
- **No WebSocket/SSE for live updates** (polling only)
- **Monolithic frontend** (2,283-line main.jsx, 22 useState calls, no state management library)

---

## Cloud Infrastructure Assessment

### Where SARdine Fits Today

```
               ┌─────────────────────────────────────────────┐
               │           CURRENT ARCHITECTURE              │
               │                                             │
  Local File ──┤                                             │
       or      │  Browser ──→ h5chunk/geotiff.js ──→ GPU    │
  HTTP URL  ───┤                                             │
       or      │  Optional: launch.cjs (Range proxy)         │
  S3 presign ──┤                                             │
               └─────────────────────────────────────────────┘
```

### Where It Should Fit

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                    CLOUD-NATIVE SAR PIPELINE                     │
  │                                                                  │
  │  Ingest ──→ Nextflow ──→ S3 ──→ STAC Catalog ──→ SARdine UI   │
  │                │                      │              │           │
  │          Processing          Metadata Index    Visualization     │
  │          (RTC, GCOV)        (search, filter)   (GPU render)     │
  │                │                      │              │           │
  │                └──── Trigger ─────────┘     ← presigned URLs    │
  │                      on complete             from STAC API      │
  └──────────────────────────────────────────────────────────────────┘
```

### Gap Analysis: What's Missing

#### 1. STAC Catalog Integration (HIGH PRIORITY)

SARdine currently discovers data through:
- Local file picker (File API)
- S3 bucket listing (`bucket-browser.js` — raw ListObjectsV2)
- Hardcoded preset bucket URLs
- GeoJSON scene catalog (`SceneCatalog.jsx`)

**What's needed:**
- **STAC API client** — search by bbox, datetime, collection, properties
- **STAC Item → SARdine loader mapping** — extract `href` from assets, detect COG vs HDF5, auto-configure bands
- **Collection browsing UI** — replace `DataDiscovery.jsx` with STAC-aware catalog browser
- **STAC extension support** — `sar:` extension for polarization, frequency band, look direction; `eo:` for cloud cover filtering

**Concrete integration point:** The existing `SceneCatalog.jsx` loads GeoJSON with footprints and URLs — a STAC Items response is structurally identical (GeoJSON FeatureCollection with assets). Adapter is straightforward:

```javascript
// Transform STAC Item → SARdine scene
function stacItemToScene(item) {
  return {
    type: 'Feature',
    geometry: item.geometry,
    properties: {
      url: item.assets['data']?.href || item.assets['hdf5']?.href,
      filename: item.id,
      datetime: item.properties.datetime,
      polarization: item.properties['sar:polarizations'],
      frequency: item.properties['sar:frequency_band'],
    }
  };
}
```

**Effort:** Medium — the scene catalog pattern already exists; needs STAC search API client and asset resolution.

#### 2. Nextflow Pipeline Integration (MEDIUM PRIORITY)

SARdine has zero processing pipeline infrastructure. The `sardine-launch` server mentioned in the roadmap would be the integration surface.

**Two integration models:**

**Model A — SARdine as Nextflow output viewer (simpler):**
```
Nextflow pipeline ──→ writes COG/HDF5 to S3 ──→ registers in STAC
                                                       │
                               SARdine polls STAC ◄────┘
```
- SARdine doesn't need to know about Nextflow
- Pipeline writes outputs + STAC Items
- SARdine discovers via STAC search
- **Gap:** Need STAC client (see above)

**Model B — SARdine triggers Nextflow (richer, more complex):**
```
SARdine UI ──→ POST /api/process ──→ Nextflow Tower API ──→ Pipeline runs
     │                                        │
     │              WebSocket/SSE ◄───────────┘
     │              (status updates)
     │
     └──→ Load output when complete (via STAC or direct URL)
```
- Needs: REST endpoint in launch.cjs for job submission
- Needs: Nextflow Tower API client or Nextflow CLI wrapper
- Needs: WebSocket/SSE for progress streaming
- Needs: Job queue + status persistence (Redis/SQLite)
- **Gap:** No server-side processing hooks exist

**Recommendation:** Start with Model A. SARdine's strength is visualization, not orchestration. Let Nextflow write STAC-compliant outputs and let SARdine consume them.

#### 3. Container/Docker (HIGH PRIORITY for deployment)

**Currently missing:**
- No Dockerfile
- No .dockerignore
- No docker-compose.yml
- No health check endpoint
- No graceful shutdown handling

**Minimal Dockerfile:**
```dockerfile
FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps --production
COPY . .
RUN npm run build
EXPOSE 8050
HEALTHCHECK CMD curl -f http://localhost:8050/ || exit 1
CMD ["node", "server/launch.cjs"]
```

**For Kubernetes/ECS:**
- Add readiness probe (`/api/health`)
- Add liveness probe
- Configure resource limits (memory: 512Mi sufficient for static serving)
- Mount data via PVC or S3 FUSE

#### 4. Authentication & Authorization

**Current:** None. The launch.cjs server serves files to anyone who can reach it.

**Needed for cloud:**
- JupyterHub token validation (already detects JupyterHub env vars, but doesn't validate tokens)
- OAuth2/OIDC for standalone deployment
- S3 credential management (currently client-side — exposes keys in browser memory)
- Server-side presigning endpoint (instead of client-side SigV4)

---

## Code Quality Audit

### Critical Issues

| # | File | Issue | Impact |
|---|------|-------|--------|
| 1 | `h5chunk.js:941` | Unbounded B-tree recursion — malformed HDF5 can exhaust stack | DoS |
| 2 | `h5chunk.js:95` | `Number(BigUint64)` loses precision for offsets > 2^53 | Silent data corruption |
| 3 | `nisar-loader.js:2284` | `xCoords`/`yCoords` undefined in h5wasm path | Export georef broken |
| 4 | `overture-loader.js:376` | Varint decoder has no shift overflow check | Crash on malicious MVT |
| 5 | `shaders.js:82` vs `SARGPULayer.js:119` | Plasma colormap coefficients differ between files | Visual inconsistency |
| 6 | `SARGPULayer.js` | No WebGL context loss handling | Black screen on GPU reset |
| 7 | `SARTiledCOGLayer.js:392` | LRU cache evicts visible tiles | Flickering |
| 8 | `geotiff-writer.js:243` | Inverse-dB overview multilook uses wrong normalization | Wrong power in overviews |

### High Priority Issues

| # | File | Issue |
|---|------|-------|
| 9 | `nisar-loader.js:1656` | Tile cache unbounded — OOM on long sessions |
| 10 | `cog-loader.js:519` | Unbounded parallel COG loading — resource exhaustion |
| 11 | `stats.js:17` | Zero-masking excludes valid water/smooth-surface pixels |
| 12 | `SARGPUBitmapLayer.js:260` | Float32 → Uint8 quantization loses SAR dynamic range |
| 13 | `h5chunk.js:1341` | No size limit on continuation block reads — OOM on malicious HDF5 |
| 14 | `cog-loader.js:104` | Bounds calculation wrong for negative pixel scales |
| 15 | `figure-export.js:151` | Floating-point accumulation in gridline loop |
| 16 | `app/main.jsx` | 2,283 lines monolith, 22 useState calls, no state management |

### Medium Priority Issues

| # | File | Issue |
|---|------|-------|
| 17 | Colormap code | Duplicated 3× (shaders.js, SARGPULayer.js, SARGPUBitmapLayer.js) |
| 18 | `stretch.js:36` | Sigmoid overflow for gamma > 6 |
| 19 | `geo-overlays.js:32` | `isProjectedBounds()` heuristic (abs > 180) fragile |
| 20 | `stats.js:35` | Median wrong for even-length arrays |
| 21 | `geotiff-writer.js:398` | `pixelScaleY` can be negative (invalid GeoTIFF) |
| 22 | `SARGPULayer.js:219` | RGB mode masks all channels if ANY is NaN |
| 23 | `h5chunk.js:218` | `String.fromCharCode(...array)` fails for strings > 65535 chars |
| 24 | `nisar-loader.js:1203` | HTTP Range response not validated (should check 206 status) |

### Dead Code

| File | Lines | Description |
|------|-------|-------------|
| `hdf5-chunked.js` | 1-355 | Entire file unused — legacy, incomplete implementation |
| `SARBitmapLayer.js:52-77` | 25 | `_createR32FTexture()` never called |
| `SARTileLayer.js:126-150` | 24 | `_createR32FTexture()` never called |
| `nisar-loader.js:1127-1331` | 204 | `ChunkedDatasetReader` class never used |
| `geotiff-writer.js:747-838` | 91 | `writeLegacyRGBGeoTIFF()` deprecated |
| `rollup.config.js` | 30 | Not invoked by any npm script |
| `jest.config.cjs` | 23 | Not used (tests run via custom runner) |

---

## Security Concerns

### Ranked by Risk

1. **Malicious HDF5 / COG DoS** — Unbounded recursion, unbounded memory allocation in h5chunk.js. A crafted HDF5 file can crash the browser tab.
   - Fix: Add depth limits (B-tree: 100), size limits (continuation blocks: 10MB), loop guards.

2. **Client-side credential exposure** — S3 access keys stored in React state (`SceneCatalog.jsx:276`). Browser DevTools, memory dumps, or XSS can extract them.
   - Fix: Server-side presigning endpoint. Never send raw credentials to the browser.

3. **No input sanitization on URLs** — `normalizeUrl()` in cog-loader.js doesn't URL-encode S3 keys with special characters. Potential for request smuggling.
   - Fix: Use `URL` constructor or `encodeURIComponent()`.

4. **Path traversal in launch.cjs** — Has `safePath()` protection, but should be hardened with `path.resolve()` + prefix check.

5. **Silent data corruption** — Integer overflow in h5chunk `readUint64()`, type coercion bugs in nisar-loader EPSG reading. Data appears correct but has precision loss.

---

## Architecture Recommendations

### For Cloud-Native Deployment

**Phase 1 — STAC + Container (enables cloud discovery):**
1. Add STAC API client module (`src/loaders/stac-client.js`)
2. Adapt `SceneCatalog.jsx` to consume STAC search results
3. Add Dockerfile + docker-compose.yml
4. Add health check endpoint to launch.cjs
5. Server-side S3 presigning endpoint

**Phase 2 — Pipeline Integration (enables Nextflow output consumption):**
1. STAC catalog watches for new items (polling or webhook)
2. SARdine auto-discovers new processing outputs
3. Optional: WebSocket notification channel for real-time updates
4. Comparison viewer for before/after processing results

**Phase 3 — Processing Trigger (enables SARdine-initiated processing):**
1. REST API in launch.cjs for Nextflow Tower job submission
2. Job status tracking with SSE/WebSocket
3. Output routing: Nextflow writes STAC Item → SARdine loads automatically
4. Processing parameter UI (RTC options, geocoding params)

### For Code Quality

1. **Break up main.jsx** — Extract into: `useNISARLoader` hook, `useCOGLoader` hook, `useHistogram` hook, `ExportPanel`, `ControlPanel`, `ViewerContainer`
2. **Consolidate colormaps** — Single source of truth, import in all 3 shader locations
3. **Fix critical bugs** — Especially h5chunk recursion limits, WebGL context loss, coordinate undefined in h5wasm path
4. **Add AbortController** — All fetch operations should be cancellable
5. **Web Workers** — Move histogram computation and HDF5 metadata parsing off the main thread

---

## Test Coverage Assessment

| Area | Coverage | Quality |
|------|----------|---------|
| File existence & exports | 100+ checks | Good — validates all source files and APIs |
| Shader syntax | Basic (brace balance) | Minimal — no semantic validation |
| Colormap correctness | Unit tests | Good — validates gradient values |
| GeoTIFF writer | Comprehensive | Excellent — IFD parsing, CRS, multi-band |
| Stretch functions | Unit tests | Good — all 4 modes tested |
| Loaders (h5chunk, nisar) | None automated | Gap — only Python cross-validation script |
| GPU rendering | Browser-only manual | Gap — no automated visual regression |
| Cloud integration (S3, presign) | None | Gap — no mock S3 tests |
| Error handling paths | None | Gap — no tests for malformed input |

---

## Summary

SARdine is a strong **visualization engine** that needs **infrastructure skin** to fit into a cloud-native processing chain. The core GPU rendering, HDF5 streaming, and COG support are production-quality. The gaps are in **discovery** (STAC), **orchestration** (Nextflow), **deployment** (Docker), and **security** (auth, credential management).

The most impactful addition would be a **STAC client** — it unlocks the entire cloud ecosystem pattern where SARdine becomes the visualization endpoint for any STAC-compliant SAR data catalog, whether populated by Nextflow, manual upload, or other ingest pipelines.
