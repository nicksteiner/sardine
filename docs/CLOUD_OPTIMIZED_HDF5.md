# Cloud-Optimized HDF5 Streaming for NISAR

## Background: What NISAR Did to Make HDF5 Cloud-Optimized

NISAR adopted the cloud-optimization approach that NSIDC developed for ICESat-2. When NSIDC was working on cloud-optimizing ICESat-2 data, NISAR was deciding how to produce their data and chose to implement the same user feedback and strategies.

### The Core Problem

Traditional HDF5 format was designed for local file systems and suffered from pathologies when accessed in the cloud — the metadata was fragmented, causing significant delays before the file could even be recognized.

### Three Specific Optimizations Applied

1. **Paged Aggregation** — A feature in the HDF5 C API that does two things:
   - Collects file-level metadata from datasets and stores it on dedicated metadata blocks at the front of the file
   - Forces the library to write both data and metadata using fixed-size pages

   This means only one data read is needed to learn about the file's content — what's in it and where it is. By default, the HDF5 library spreads internal file metadata in small blocks throughout the file.

2. **Large Chunk Sizes** — 2–10 MiB chunk sizes are preferred. The default HDF5 library dataset chunk cache is only 1 MiB. Appropriate chunk cache size has significant impact on I/O performance.

3. **Minimal Variable-Length Datatypes** — The current implementation of variable-length data in HDF5 files prevents easy retrieval using HTTP range GET requests.

### The Practical Result

A client can read the consolidated metadata page in one or two HTTP range requests, learn the byte offsets of every data chunk in the file, then fetch only the specific chunks it needs. **No need to download the whole file.**

---

## JavaScript Implementation

The cloud-optimization provides a predictable byte-level map of the file. Because NISAR's metadata is consolidated at the front, a client can:

1. **Fetch the first ~8MB** (one page) via a single HTTP range request → you now know every dataset, its shape, dtype, chunk layout, and the byte offset of every chunk in the file
2. **Fetch only the chunks you need** for the current viewport via targeted range requests

This is the same access pattern used by Cloud Optimized GeoTIFF (COG).

---

## Implementation Path: h5chunk

```
Step 1: Fetch metadata page (~8MB, one request)
        ↓
Step 2: Parse chunk index (offsets, sizes, compression)
        ↓  ← This is the hard/novel part
Step 3: For current viewport, calculate which chunks intersect
        ↓
Step 4: Fetch those chunks via HTTP Range requests
        ↓
Step 5: Decompress (gzip/zstd in JS) → Float32Array
        ↓
Step 6: Push to deck.gl as WebGL texture
        ↓
Step 7: GPU does dB conversion + colormap
```

Steps 4–7 are straightforward. The novel engineering is in **steps 1–3**: parsing the HDF5 metadata page in JavaScript to build a chunk index. This is essentially a **JS-native Kerchunk**.

---

## What h5chunk Does

A lightweight JS library that:

1. Takes an S3 URL (or any HTTP URL supporting range requests) or local File
2. Fetches the metadata page (~8MB)
3. Parses just enough HDF5 structure to build a chunk map:
   ```javascript
   {dataset_path → [{offset, size, chunk_coords}]}
   ```
4. Exposes a simple API:
   ```javascript
   getChunk(dataset, x, y) → ArrayBuffer
   readRegion(dataset, startRow, startCol, numRows, numCols) → Float32Array
   ```

This is simpler than a full HDF5 library because it only parses paged-aggregated metadata. NISAR's cloud optimization constrains the problem space to a subset of HDF5 features.

---

## HDF5 Structures Parsed

### Superblock (at byte 0)
- Signature: `\x89HDF\r\n\x1a\n`
- Version (0-3)
- Offset size (typically 8 bytes)
- Length size (typically 8 bytes)
- Root group address

### Object Headers (OHDR signature)
- Contains messages describing objects
- Key messages:
  - **Dataspace (0x0001)**: Dimensions and rank
  - **Datatype (0x0003)**: float32, float64, int16, etc.
  - **Data Layout (0x0008)**: Contiguous vs chunked, chunk dimensions, B-tree address
  - **Filter Pipeline (0x000B)**: Compression (deflate, shuffle, etc.)

### B-tree v1/v2 (TREE/BTHD signatures)
- Index of chunk locations
- Each entry contains:
  - Chunk coordinates (which chunk in the grid)
  - Byte offset in file
  - Compressed size
  - Filter mask

---

## Current Implementation Status

### Completed
- [x] Superblock parsing (v0-3)
- [x] Object header parsing (v1 and v2)
- [x] Dataspace message parsing
- [x] Datatype message parsing
- [x] Data layout message parsing
- [x] Filter pipeline message parsing
- [x] B-tree v1 parsing for chunk index
- [x] Chunk reading with byte-range requests
- [x] Decompression (deflate via DecompressionStream)
- [x] Shuffle filter implementation
- [x] Float16/32/64 decoding
- [x] Integration with nisar-loader.js
- [x] Tile-based streaming for deck.gl

### In Progress
- [x] Testing with real NISAR files (confirmed working on ODS, Feb 2026)
- [x] HDF5 link/group traversal for dataset names (v1 + v2 groups)
- [x] Coordinate array extraction from metadata
- [x] HTTP range request support (openUrl with Range headers)

### TODO: Lazy Tree-Walking (replace 8 MB bulk read)

**Problem:** h5chunk reads 8–32 MB upfront (the paged aggregation page), then
brute-force scans the buffer for OHDR/FRHP signatures. The actual structural
metadata is ~2–3 MB; the rest is zero-padding. For remote URLs, this wastes
bandwidth and adds latency. For non-NISAR files without paged aggregation, the
fixed buffer size is a guess that may miss structures or waste memory.

**Insight:** `_parseObjectAtAddress` already IS a tree walker — it follows
pointers, handles v1 Symbol Tables, v2 fractal heaps, continuation blocks,
and recurses into children. The `_fetchBytes` fallback handles any address
beyond the metadata buffer. The infrastructure is 90% built.

**Plan:**

1. **Superblock-only initial read** (~64 bytes)
   - `openUrl()` fetches just the superblock, parses offsetSize/lengthSize/rootGroupAddress
   - No large `metadataBuffer` — set it to the 64-byte superblock for compatibility
   - Everything goes through `_fetchBytes` from here

2. **Replace `_scanForDatasets` with pure tree walk**
   - Delete Strategy 2: OHDR signature byte-scan (~15 lines)
   - Delete Strategy 3: FRHP signature byte-scan (~8 lines)
   - Delete Strategy 4: `_scanForChunkedLayouts` brute-force (~150 lines)
   - Keep Strategy 1: `_parseObjectAtAddress(rootGroupAddress)` — this is the tree walk
   - All objects discovered via pointer-following, no scanning

3. **Make `_parseObjectAtAddress` always fetch on demand**
   - Remove `if (address < this.metadataBuffer.byteLength)` fast paths
   - Every object header fetched with targeted 8 KB `_fetchBytes` call
   - BufferReader with baseOffset already handles this transparently

4. **Lazy B-tree fetch**
   - Don't parse all datasets' B-trees at open time
   - Store `lazyBtreeAddress` on the dataset info
   - Fetch and parse B-tree on first `readChunk()` / `readRegion()` for that dataset
   - User picks one polarization → fetch that B-tree (~130 KB)
   - Switch polarization → fetch that B-tree then

5. **Lazy coordinate array fetch**
   - Don't read xCoordinates/yCoordinates at open time
   - Fetch on demand when bounds are needed (first tile render or export)
   - ~260 KB instead of pulling them from the 8 MB buffer

6. **Fetch coalescing (optimization, optional)**
   - Batch nearby `_fetchBytes` calls into merged range requests
   - Sort by offset, merge overlapping/adjacent ranges
   - Useful for HTTP/2 where fewer larger requests beat many small ones

**Expected result:**
- Open time: ~450 KB fetched (superblock + group walk + one B-tree + coords)
- vs current: 8–32 MB fetched
- Parsing: only structures that are actually needed, not brute-force scan of buffer
- Non-NISAR files: works regardless of paged aggregation

**What stays the same:**
- All existing parsing functions (parseObjectHeader, parseBTreeV1, etc.)
- `_fetchBytes` implementation
- BufferReader with baseOffset
- readChunk / readRegion / readSmallDataset APIs
- All nisar-loader.js call sites

**Fallback:** For local files where File.slice() is free, could still do
the 8 MB bulk read as an optimization — bulk read is faster than 30 sequential
slices on local disk. Gate on `this.file` vs `this.url`.

### TODO: Connect Metadata Cube (incidence angle, slant range)

**Problem:** `loadMetadataCube()` in `metadata-cube.js` is fully implemented
and exported. It reads 3D datasets from `/science/{band}/GCOV/metadata/radarGrid/`:
- incidenceAngle [nHeight × nY × nX]
- elevationAngle [nHeight × nY × nX]
- slantRange [nHeight × nY × nX]
- losUnitVectorX/Y, alongTrackUnitVectorX/Y

The consumers are wired up:
- `MetadataPanel.jsx:371` reads `imageData.metadataCube` for display
- `main.jsx:1177` appends cube fields to GeoTIFF export

But **nothing calls `loadMetadataCube()`**. The producer is missing.

**Plan:**
1. In `nisar-loader.js` streaming path (`loadNISARGCOVStreaming`), after
   opening the h5chunk reader, call `loadMetadataCube(streamReader, band)`
2. Attach the result to the returned imageData: `metadataCube: cube`
3. The radarGrid group is a v2 group (fractal heap) — h5chunk must discover
   its datasets during the tree walk. With lazy tree-walking, these would be
   fetched on demand when `loadMetadataCube` calls `reader.getDataset(path)`
4. The 3D datasets are chunked — `readSmallDataset` won't work for large
   cubes. May need to read via `readChunk` or add a `readFullDataset` method
   that reassembles all chunks. The cubes are small (~50×50×3 = 7500 values),
   so a single-chunk read should suffice.

### TODO: Kerchunk Sidecar Support (optional fast path)

**Problem:** Runtime HDF5 metadata parsing takes ~29 seconds on NISAR GCOV files.
Kerchunk/VirtualiZarr pre-computes the chunk index offline as JSON or Parquet.

**Plan:**
1. Check for `<filename>.kerchunk.json` sidecar before parsing HDF5
2. If found, load the JSON → build chunk map directly (skip all HDF5 parsing)
3. If not found, fall back to tree-walking (current behavior)
4. Sidecar generation happens in Nextflow pipeline, not in SARdine

**Format:** Kerchunk JSON maps Zarr-style keys to `[url, offset, length]`:
```json
{
  "version": 1,
  "refs": {
    ".zattrs": "{}",
    "HHHH/.zarray": "{\"shape\":[16704,16272],\"chunks\":[256,256],\"dtype\":\"<f4\"}",
    "HHHH/0.0": ["s3://bucket/file.h5", 8388608, 65536],
    "HHHH/0.1": ["s3://bucket/file.h5", 8454144, 64200],
    ...
  }
}
```
h5chunk would consume this directly — same chunk map, zero parse time.

### Future
- [ ] B-tree v2 parsing (for newer HDF5 files / extensible arrays)
- [ ] Worker thread for parsing/decompression (move h5chunk to Web Worker)
- [ ] LRU chunk cache with memory limits (current cache is unbounded)
- [ ] Adaptive metadata read for local files (read 8 MB page if paged, tree-walk if not)

---

## Significance

h5chunk enables client-side HDF5 streaming from S3 to GPU with no server or Python dependency. There is currently no comparable JavaScript library for cloud-optimized HDF5 range-read access. Potential users include anyone working with NISAR, ICESat-2, or similarly structured HDF5 products in the browser.

---

## References

- [NSIDC Cloud-Optimization for ICESat-2](https://nsidc.org/data/user-resources/help-center/nasa-earthdata-cloud-data-access-guide)
- [HDF5 File Format Specification](https://docs.hdfgroup.org/hdf5/develop/_f_m_t3.html)
- [h5wasm GitHub - Large File Discussion](https://github.com/usnistgov/h5wasm/issues)
- [NISAR Product Specification L2 GCOV (JPL D-102274 Rev E)](test_data/)

---

## File Structure

```
src/loaders/
├── h5chunk.js           # Core cloud-optimized HDF5 reader
├── nisar-loader.js      # NISAR-specific loader using h5chunk
└── hdf5-chunked.js      # Legacy/simpler implementation
```

## API Example

```javascript
import { openH5ChunkFile, openH5ChunkUrl } from './h5chunk.js';

// Local file
const reader = await openH5ChunkFile(file, 8 * 1024 * 1024);

// Remote URL (future)
const reader = await openH5ChunkUrl('https://bucket.s3.amazonaws.com/nisar.h5');

// List discovered datasets
const datasets = reader.getDatasets();
// → [{id: 'dataset_abc123', shape: [3500, 3500], dtype: 'float32', chunked: true, numChunks: 100}]

// Read a region
const result = await reader.readRegion('dataset_abc123', 0, 0, 256, 256);
// → {data: Float32Array, width: 256, height: 256}

// Read a specific chunk
const chunk = await reader.readChunk('dataset_abc123', 0, 0);
// → Float32Array
```
