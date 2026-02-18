<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/sardine-logo.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/sardine-logo-light.svg">
  <img src="docs/sardine-logo-light.svg" alt="SARdine" width="480">
</picture>

<br>

**SAR Data INspection and Exploration**

*Browser-native SAR analysis — cloud-optimized HDF5 and COG streaming to GPU*

`v1.0.0-beta.2` · `MIT` · `Feb 2026`

</div>

---

## Overview

SARdine runs SAR analysis in the browser. No server, no Python, no GDAL — just open a local file or paste an S3 presigned URL.

It reads NISAR L2 GCOV HDF5 (`.h5`) and Cloud Optimized GeoTIFFs from any vendor. Rendering goes through WebGL2 shaders on deck.gl: dB scaling, colormaps, contrast, polarimetric composites — all on the GPU at 60 fps.

- NISAR GCOV HDF5 streaming (local files and HTTP Range)
- COG loading (ICEYE, Capella, Umbra, Sentinel-1, anything)
- RGB composites: Pauli, dual-pol, quad-pol, Freeman-Durden
- Histogram with auto-contrast, stretch modes (sqrt, gamma, sigmoid)
- GeoTIFF export (raw Float32 with CRS, or rendered RGBA)
- Figure export (PNG with scale bar, coords, colorbar)
- Overture Maps overlay, MapLibre basemap

---

## Prerequisites

SARdine requires **Node.js** (v18 or later) and **npm** (comes with Node).

### Installing Node.js

**macOS** — using [Homebrew](https://brew.sh/):

```bash
brew install node
```

Or download the macOS installer from https://nodejs.org/ (LTS recommended).

**Windows** — download the Windows installer from https://nodejs.org/ (LTS recommended). Run it, accept defaults. This installs both `node` and `npm`. After install, open a new terminal (Command Prompt or PowerShell) and verify:

```bash
node --version
npm --version
```

**Linux** (Debian/Ubuntu):

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Quick Start

```bash
git clone https://github.com/nicksteiner/sardine.git
cd sardine
npm install
npm run dev
```

Open **http://localhost:5173** in Chrome, Edge, or Firefox (WebGL2 required).

---

## Loading Data

Pick a mode from the **File Type** dropdown in the left panel.

### Local HDF5 Files

For NISAR GCOV `.h5` files on your machine.

1. **File Type** → **NISAR GCOV HDF5 (Local File)**
2. **Choose File** → pick your `.h5`
3. Pick **Frequency** (`frequencyA` = L-band, `frequencyB` = S-band)
4. Pick **Polarization** (`HHHH`, `HVHV`, `VVVV`, etc.)
5. Optionally switch to **RGB Composite** and pick a preset
6. **Load Dataset**

Nothing gets uploaded. Chunks are read directly from disk via the browser File API. GCOV files are 2–20 GB but only viewport-intersecting chunks get read, so it works fine without loading the whole file into memory.

### Presigned URLs (S3 / HTTPS)

For NISAR HDF5 or COG files on S3, GCS, Azure, or any HTTPS server that supports Range requests.

1. **File Type** → **Remote Bucket / S3**
2. Paste the presigned URL into **Direct URL**:
   ```
   https://bucket.s3.us-west-2.amazonaws.com/NISAR_L2_GCOV_001_005_A_219_4020_HH_20250101.h5?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...&X-Amz-Signature=...
   ```
3. **Load from URL** (or hit Enter)
4. Metadata arrives via Range requests (~8 MB). Pick frequency and polarization.
5. **Load Remote Dataset**

File type is detected from the path (ignoring query params): `.h5`/`.hdf5`/`.he5` → NISAR, `.tif`/`.tiff` → COG.

**Requirements for presigned URLs:**
- Server must support HTTP Range requests (S3, GCS, and Azure all do by default)
- Token must stay valid for your session
- Bucket needs CORS configured to expose `Range` headers — see [CORS Setup](#cors-setup)

### COG URLs

For Cloud Optimized GeoTIFFs (any vendor, any source).

1. **File Type** → **Cloud Optimized GeoTIFF (URL)**
2. Paste URL (presigned or public):
   ```
   https://bucket.s3.amazonaws.com/sar-image.tif
   ```
3. **Load COG**

Uses [geotiff.js](https://geotiffjs.github.io/) with Range reads. Overview selection is automatic based on zoom level.

---

## Controls

After loading data, the left panel shows:

| Control | Description |
|:---|:---|
| **Colormap** | Grayscale, viridis, inferno, plasma, phase, sardine, flood, diverging, polarimetric |
| **Contrast** | Min/max dB range — drag sliders or use **Auto** for percentile-based stretch |
| **Stretch** | Linear, sqrt, gamma, sigmoid — changes the transfer function |
| **Multi-look** | Toggle speckle reduction (box-filter averaging in linear power) |
| **Histogram** | Per-channel histogram with percentile markers and contrast handles |
| **Basemap** | Toggle MapLibre basemap under the SAR data |
| **Overture** | Overlay buildings, roads, or places from Overture Maps |

### Keyboard Shortcuts

| Key | Action |
|:---|:---|
| `F` | Fit view to data bounds |
| `R` | Reset contrast to auto |

---

## Export

### GeoTIFF

Three modes:

- **Raw Float32** — linear power values with CRS + tiepoints, for downstream analysis in QGIS/ArcGIS/Python
- **Rendered RGBA** — what you see on screen (dB, colormap, contrast) as a 4-band GeoTIFF
- **RGB Composite** — 3-band GeoTIFF when in composite mode

Draw an ROI to export a subregion, or export the full extent. Multi-look window (1×, 2×, 4×, 8×, 16×) is independent of the display setting.

### Figure PNG

Canvas capture with optional overlays: scale bar, corner coordinates, colorbar (or RGB triangle for composites).

---

## CORS Setup

Remote files require the bucket to allow cross-origin Range requests. For S3:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

Set this as the bucket CORS policy. CORS lives on the bucket, not on individual presigned URLs.

**GCS:** `gsutil cors set cors.json gs://your-bucket`
**Azure Blob:** configure CORS rules in the storage account settings.

---

## Server Mode (JupyterHub / NISAR ODS)

For deployment alongside JupyterHub:

```bash
cd ~/sardine
npm install --legacy-peer-deps && npm run build
node server/launch.cjs --data-dir /home/jovyan
```

Access via the JupyterLab proxy:

```
https://<hub-host>/user/<username>/proxy/8050/
```

`/api/files` lists files relative to `--data-dir`, `/data/` serves them. The Remote Bucket / S3 mode in the app can then browse and load server-local files.

---

## Architecture

```
File/URL → Loader → Chunks → GPU Texture → GLSL Shader → Screen
                                              ↓
                                    dB scale → stretch → colormap → contrast
```

### HDF5 Streaming

`h5chunk` is a JS-native Kerchunk. Reads cloud-optimized HDF5 without loading the full file:

1. Fetch metadata page (~8 MB, one request)
2. Parse HDF5 superblock, object headers, B-tree → build chunk index
3. For current viewport, calculate intersecting chunks
4. Fetch chunks via `File.slice()` (local) or HTTP Range (remote)
5. Decompress (deflate + shuffle) → Float32Array
6. Upload as WebGL2 R32F texture
7. Fragment shader: power → dB → normalize → stretch → colormap → RGBA

### Project Structure

```
sardine/
├── app/
│   ├── index.html              # Entry HTML
│   └── main.jsx                # React application
├── src/
│   ├── loaders/
│   │   ├── h5chunk.js          # Cloud-optimized HDF5 chunk reader
│   │   ├── nisar-loader.js     # NISAR GCOV product loader
│   │   ├── cog-loader.js       # COG loader (geotiff.js wrapper)
│   │   └── overture-loader.js  # Overture Maps PMTiles/GeoParquet
│   ├── layers/
│   │   ├── SARGPULayer.js      # Primary GPU-accelerated layer
│   │   ├── SARGPUBitmapLayer.js
│   │   └── shaders.js          # GLSL shaders (dB, colormaps, stretch)
│   ├── viewers/
│   │   ├── SARViewer.jsx       # Orthographic viewer
│   │   ├── MapViewer.jsx       # MapLibre basemap + SAR overlay
│   │   └── ComparisonViewer.jsx
│   ├── components/             # Histogram, StatusWindow, ScaleBar, etc.
│   ├── utils/                  # Composites, colormaps, stats, export
│   └── theme/
│       └── sardine-theme.css   # Dark-first design system
├── server/
│   └── launch.cjs              # JupyterHub launch server
├── test/                       # Test suite (100+ checks)
└── docs/                       # Architecture docs, style guide
```

### Tech Stack

| Dependency | Role |
|:---|:---|
| **React 18** | UI framework |
| **deck.gl 8.9** | WebGL tile/bitmap rendering |
| **geotiff.js** | COG loading via HTTP Range |
| **h5chunk** (built-in) | Cloud-optimized HDF5 streaming |
| **h5wasm** | HDF5 attribute/metadata parsing (WASM) |
| **MapLibre GL** | Basemap rendering |
| **Vite** | Dev server and build tool |

---

## Development

```bash
npm install          # Install dependencies
npm run dev          # Dev server at localhost:5173
npm run build        # Production build → dist/
npm test             # Full test suite (100+ checks)
npm run test:quick   # Fast smoke tests
npm run benchmark    # GPU vs CPU performance comparison
```

---

## Roadmap

| Feature | Status |
|:---|:---|
| NISAR GCOV HDF5 local + remote streaming | Done |
| Cloud Optimized GeoTIFF loading | Done |
| GPU dB scaling + colormaps + stretch modes | Done |
| RGB polarimetric composites (Pauli, dual-pol, quad-pol) | Done |
| Freeman-Durden decomposition | Done |
| Per-channel histogram + auto-contrast | Done |
| GeoTIFF + figure export | Done |
| Overture Maps vector overlay | Done |
| State-as-markdown editing | Done |
| STAC catalog search | Done |
| B-tree v2 parsing | Next |
| Worker thread decompression | Next |
| Chat-driven visualization control | Next |
| Drawing / annotation tools | Planned |
| GUNW / InSAR phase visualization | Planned |

---

## License

MIT

---

<sub>

[h5wasm](https://github.com/usnistgov/h5wasm) · [geotiff.js](https://geotiffjs.github.io/) · [deck.gl](https://deck.gl/) · NISAR cloud-optimization: [NSIDC](https://nsidc.org/) + JPL

`CCNY Earth & Atmospheric Sciences`

</sub>
