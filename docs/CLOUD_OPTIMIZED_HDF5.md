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

## Capitalizing on This in JavaScript

This is where it gets exciting for SARdine. The cloud-optimization essentially gives you a predictable byte-level map of the file.

### The Key Insight

Because NISAR's metadata is consolidated at the front of the file, you can:

1. **Fetch the first ~8MB** (one page) via a single HTTP range request → you now know every dataset, its shape, dtype, chunk layout, and the byte offset of every chunk in the file
2. **Fetch only the chunks you need** for the current viewport via targeted range requests

This is exactly how **Cloud Optimized GeoTIFF (COG)** works, and it's why COG has such great browser support. NISAR's cloud-optimized HDF5 enables the same pattern.

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

This is dramatically simpler than a full HDF5 library because you only need to parse the paged-aggregated metadata — not handle arbitrary HDF5 features. NISAR's cloud optimization constrains the problem space.

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
- [ ] Testing with real NISAR files
- [ ] HDF5 link/group traversal for dataset names
- [ ] Coordinate array extraction from metadata

### Future
- [ ] B-tree v2 parsing (for newer HDF5 files)
- [ ] HTTP range request support (currently File.slice() only)
- [ ] Worker thread for parsing/decompression
- [ ] LRU chunk cache with memory limits

---

## Why This Matters

**Zero server. Zero Python. Pure client-side streaming from S3 to GPU.**

That would be a first in the earth science community and a huge differentiator for SARdine. It's also the kind of open-source contribution (a JS cloud-optimized HDF5 reader) that would get serious attention from:
- NASA
- The HDF Group
- The broader geospatial-JS community

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
