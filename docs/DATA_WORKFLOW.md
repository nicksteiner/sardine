# SARdine — SAR Data INspection and Exploration: NISAR On-Demand Workflow

## Context

The NISAR On-Demand system is a private JupyterLab environment that gives science and operational teams early access to NISAR data products before public availability. Users have direct filesystem access to L0B through L2 products on shared storage.

SARdine runs inside this environment as a local dev server or Docker container with a volume mount to the data directory. It provides browser-based visualization of GCOV products on the shared filesystem.

---

## 1. Environment

### On-Demand JupyterLab

```
┌─────────────────────────────────────────────────┐
│  NISAR On-Demand (private JupyterLab)           │
│                                                  │
│  /data/nisar/                                    │
│  ├── L0B/          Raw signal data               │
│  ├── L1_RSLC/      Range-Doppler SLC             │
│  ├── L1_RIFG/      Range-Doppler interferograms  │
│  ├── L1_RUNW/      Range-Doppler unwrapped       │
│  ├── L1_ROFF/      Range-Doppler pixel offsets   │
│  ├── L2_GSLC/      Geocoded SLC                  │
│  ├── L2_GCOV/      Geocoded Covariance ← target  │
│  ├── L2_GUNW/      Geocoded unwrapped interf.    │
│  ├── L2_GOFF/      Geocoded pixel offsets         │
│  └── L3_SM/        Global soil moisture           │
│                                                  │
│  JupyterLab  │  Terminal  │  SARdine (browser)   │
└─────────────────────────────────────────────────┘
```

### SARdine Deployment Options

**Option A: Dev server (quick)**
```bash
# In the on-demand terminal
cd /home/user/sardine
npm run dev
# → http://localhost:5173
# Drag .h5 files from local filesystem
```

**Option B: sardine-launch (server mode)**
```bash
# Serves built frontend + file API for browsing /data
node server/launch.js --data-dir /data/nisar/L2_GCOV --port 8050
# → http://localhost:8050
# Browse and click to load — no drag-and-drop needed
```

**Option C: Docker**
```bash
docker run -v /data/nisar:/data:ro -p 8050:8050 sardine
# → http://localhost:8050
# Same file browser, data directory read-only mounted
```

---

## 2. NISAR Product Hierarchy

### What SARdine reads today

| Level | Product | Format | SARdine Support |
| :---- | :------ | :----- | :-------------- |
| L2 | **GCOV** — Geocoded Covariance | HDF5 (cloud-optimized) | **Shipped** — full streaming, RGB composites, export |
| L2 | GSLC — Geocoded SLC | HDF5 | Planned — complex data (amplitude + phase) |
| L2 | GUNW — Geocoded Unwrapped Interferogram | HDF5 | Planned — phase colormap, coherence layer |
| L2 | GOFF — Geocoded Pixel Offsets | HDF5 | Planned — diverging colormap for offsets |
| L1 | RSLC — Range-Doppler SLC | HDF5 | Future — radar geometry, not geocoded |
| Any | COG / GeoTIFF | GeoTIFF | **Shipped** — any single-band Float32 COG |

### GCOV Product Structure

A typical NISAR L2 GCOV HDF5 file:

```
NISAR_L2_PR_GCOV_001_005_A_219_4020_SHNA_A_20250211T010938_20250211T011006_D00501_P_P_J_001.h5

├── science/
│   └── LSAR/
│       ├── identification/           ← product metadata
│       │   ├── absoluteOrbitNumber
│       │   ├── trackNumber
│       │   ├── frameNumber
│       │   ├── zeroDopplerStartTime
│       │   └── ...
│       ├── GCOV/
│       │   └── grids/
│       │       ├── frequencyA/
│       │       │   ├── HHHH          ← |HH|² backscatter power (Float32, chunked)
│       │       │   ├── HVHV          ← |HV|² cross-pol power
│       │       │   ├── VHVH          ← |VH|² (if quad-pol)
│       │       │   ├── VVVV          ← |VV|² (if quad-pol)
│       │       │   ├── listOfPolarizations
│       │       │   ├── xCoordinates  ← longitude array
│       │       │   └── yCoordinates  ← latitude array
│       │       └── frequencyB/       ← S-band (if available)
│       │           └── ...
│       └── metadata/
│           └── processingInformation/
│               └── parameters/
│                   └── geocoding/
│                       └── ...
```

Key details:
- **Chunk size**: ~2–10 MiB per chunk (cloud-optimized)
- **Compression**: Deflate + shuffle
- **Dtype**: Float32 (power values, always ≥ 0)
- **Grid**: EPSG:4326, geographic lat/lon
- **Typical size**: 2–8 GB per file (depends on coverage and polarizations)
- **Typical dimensions**: ~16000 × 16000 pixels per polarization

---

## 3. Scientist Workflow

### Quick-look

```
1. Navigate to L2_GCOV/ directory
2. Open SARdine in browser
3. Drag the .h5 file onto SARdine (or click in file browser)
4. Auto-detection:
   - Frequency bands (frequencyA = L-band)
   - Available polarizations (HHHH, HVHV)
   - Geographic bounds (from coordinate arrays)
   - Best RGB composite (dual-pol-h: R=HH, G=HV, B=HH/HV)
5. Default rendering:
   - dB scale, grayscale, -25 to 0 dB
   - Auto-contrast from sampled tiles
6. Adjust: switch to RGB composite, change stretch, zoom
7. Export: GeoTIFF (for GIS) or figure PNG (for reports)
```

SARdine streams only the chunks intersecting the current viewport. The full file is never loaded into memory.

### Calibration/Validation

For cal/val activities, scientists need to compare products across orbits, frequencies, and processing versions:

```
1. Load GCOV from cycle 5 (reference)
2. Load GCOV from cycle 6 (new calibration)
3. Swipe comparison view — linked pan/zoom
4. Check: do backscatter levels match?
5. Export difference map as GeoTIFF for quantitative analysis
```

This requires the planned comparison mode (ComparisonViewer.jsx exists, needs main.jsx integration).

### Flood Monitoring (HiFLOWS)

For the HiFLOWS operational team:

```
1. New GCOV arrives for flood-prone region
2. Open in SARdine → auto-detects, renders
3. Switch to VV polarization (best for flood detection)
4. Adjust contrast to emphasize dark returns (water)
5. Enable flood mask overlay (threshold at ~-15 dB)
6. Export flood extent as GeoJSON polygon
7. Export rendered GeoTIFF for the situation report
```

This requires the planned flood thresholding tool.

### Time Series Analysis

For monitoring campaigns (land cover change, subsidence, ice dynamics):

```
1. Load shopping list CSV of GCOV granule filenames
2. SARdine loads all, populates timeline
3. Scrub through dates — animation of backscatter evolution
4. Draw AOI polygon over area of interest
5. View time series plot of mean σ₀ within AOI
6. Identify change events (deforestation, flooding, volcanic activity)
7. Export time series stats as CSV
```

This requires the planned time series mode.

---

## 4. Data Access Patterns

### Local File (on-demand system)

In the on-demand JupyterLab, files are on a shared filesystem. SARdine reads via `File.slice()` — no network latency, direct disk reads.

```
Scientist                    SARdine (browser)               Filesystem
    │                            │                              │
    │  drag .h5 file             │                              │
    ├───────────────────────────►│                              │
    │                            │  File.slice(0, 8MB)          │
    │                            ├─────────────────────────────►│
    │                            │  ◄── metadata page ─────────┤
    │                            │                              │
    │                            │  parse superblock, OHDR,     │
    │                            │  B-trees → chunk index       │
    │                            │                              │
    │  (viewport pan/zoom)       │                              │
    ├───────────────────────────►│                              │
    │                            │  File.slice(offset, size)    │
    │                            ├─────────────────────────────►│
    │                            │  ◄── chunk bytes ───────────┤
    │                            │  decompress → Float32Array   │
    │                            │  upload → GPU texture         │
    │                            │  shader → RGBA → screen      │
    │                            │                              │
    │  ◄── rendered tile ────────┤                              │
```

**Memory footprint**: Only viewport-visible chunks are in memory. A 4GB GCOV at overview zoom might use ~50MB of browser memory.

### Server Mode (sardine-launch)

When running with `sardine-launch`, the Express server exposes the filesystem as HTTP endpoints with Range request support:

```
Browser (SARdine)                Server (Express)              Filesystem
    │                               │                            │
    │  GET /api/files?dir=/L2_GCOV  │                            │
    ├──────────────────────────────►│  readdir()                 │
    │  ◄── JSON file listing ───────┤ ◄────────────────────────┤
    │                               │                            │
    │  (user clicks file)           │                            │
    │                               │                            │
    │  GET /api/data/file.h5        │                            │
    │  Range: bytes=0-8388607       │                            │
    ├──────────────────────────────►│  fs.createReadStream()     │
    │  ◄── 206 Partial Content ─────┤ ◄────────────────────────┤
    │                               │                            │
    │  (h5chunk parses metadata,    │                            │
    │   then fetches chunks         │                            │
    │   via more Range requests)    │                            │
```

The file browser UI lets users navigate the data directory and click to load.

### Future: S3 Direct Access

When NISAR data is publicly available in Earthdata Cloud (us-west-2), SARdine's h5chunk can stream directly from S3 using HTTP Range requests:

```
Browser (SARdine)                           S3 (us-west-2)
    │                                           │
    │  GET /bucket/NISAR_L2_GCOV_...h5          │
    │  Range: bytes=0-8388607                   │
    ├──────────────────────────────────────────►│
    │  ◄── 206 Partial Content ─────────────────┤
    │                                           │
    │  (same pattern: metadata → chunk index     │
    │   → fetch visible chunks on demand)        │
```

Requires CORS headers on the bucket. This is the same pattern COG uses — and it works today for GeoTIFFs via geotiff.js.

---

## 5. NISAR Filename Convention

Understanding the filename is important for auto-detection and metadata display:

```
NISAR_L2_PR_GCOV_001_005_A_219_4020_SHNA_A_20250211T010938_20250211T011006_D00501_P_P_J_001.h5
│     │  │  │    │   │   │ │   │    │    │ │                │                │      │ │ │ │
│     │  │  │    │   │   │ │   │    │    │ │                │                │      │ │ │ └─ version
│     │  │  │    │   │   │ │   │    │    │ │                │                │      │ │ └─── format (J=HDF5)
│     │  │  │    │   │   │ │   │    │    │ │                │                │      │ └───── processing stage
│     │  │  │    │   │   │ │   │    │    │ │                │                │      └─────── polarization config
│     │  │  │    │   │   │ │   │    │    │ │                │                └──────────── processing ID
│     │  │  │    │   │   │ │   │    │    │ │                └─────────────────────────── end time
│     │  │  │    │   │   │ │   │    │    │ └──────────────────────────────────────────── start time
│     │  │  │    │   │   │ │   │    │    └────────────────────────────────────────────── orbit direction (A/D)
│     │  │  │    │   │   │ │   │    └─────────────────────────────────────────────────── mode (SHNA=science)
│     │  │  │    │   │   │ │   └──────────────────────────────────────────────────────── frame number
│     │  │  │    │   │   │ └──────────────────────────────────────────────────────────── track number
│     │  │  │    │   │   └────────────────────────────────────────────────────────────── orbit direction
│     │  │  │    │   └────────────────────────────────────────────────────────────────── cycle number
│     │  │  │    └────────────────────────────────────────────────────────────────────── mission phase
│     │  │  └─────────────────────────────────────────────────────────────────────────── product type
│     │  └────────────────────────────────────────────────────────────────────────────── processing level
│     └───────────────────────────────────────────────────────────────────────────────── level (L2)
└─────────────────────────────────────────────────────────────────────────────────────── mission
```

SARdine can parse this to populate the metadata info bar with track, frame, cycle, orbit direction, and acquisition time without opening the file.

---

## 6. Integration with JupyterLab

### Side-by-side workflow

The on-demand JupyterLab environment supports multiple browser tabs. A typical power-user workflow:

```
Tab 1: JupyterLab — Python analysis, custom scripts
Tab 2: SARdine — interactive visualization of the same files
Tab 3: Terminal — sardine-launch server, file management
```

### Jupyter → SARdine handoff

Open a specific file with preset visualization parameters from a notebook:

```python
# In Jupyter notebook
import webbrowser
gcov_path = '/data/nisar/L2_GCOV/NISAR_L2_PR_GCOV_001_005_A_219_4020.h5'
webbrowser.open(f'http://localhost:8050/?file={gcov_path}&colormap=viridis&contrast=-20,0')
```

This requires the planned URL deep-linking feature.

### SARdine → Jupyter handoff

Export from SARdine and continue in Python:

```python
# In Jupyter notebook — after SARdine export
import rasterio
with rasterio.open('/home/user/exports/gcov_hh_ml4.tif') as src:
    data = src.read(1)  # Float32 power values, already multilooked
    # Continue with custom analysis...
```

Raw GeoTIFF exports contain Float32 power values with CRS and tiepoint tags.

---

## 7. Performance Considerations

### File sizes on the on-demand system

| Product | Typical size | SARdine memory usage |
| :------ | :----------- | :------------------- |
| L2 GCOV (dual-pol) | 2–4 GB | ~50 MB at overview zoom |
| L2 GCOV (quad-pol) | 4–8 GB | ~80 MB at overview zoom |
| L2 GUNW | 1–3 GB | ~40 MB (planned) |
| L1 RSLC | 5–15 GB | ~100 MB (future) |

At overview zoom, approximately 1% of chunks are read. At full zoom, only chunks intersecting the viewport are fetched.

### Disk I/O on shared storage

The on-demand system may have shared NFS or Lustre storage. h5chunk's sequential chunk reads are efficient — each read is a single contiguous byte range. No random seeks across the file.

### Export at full resolution

Exporting a full-resolution multilook GeoTIFF reads the entire dataset stripe-by-stripe (not all at once). Memory stays bounded by the stripe buffer size, not the output image size. A 16000×16000 GCOV at ml=2 produces an 8000×8000 export using ~256 MB peak memory.
