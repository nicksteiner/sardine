<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/sardine-logo.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/sardine-logo-light.svg">
  <img src="docs/sardine-logo-light.svg" alt="SARdine" width="480">
</picture>

<br>

**SAR Data INspection and Exploration**

*Browser-native visualization and export for NISAR HDF5 and Cloud Optimized GeoTIFFs*

[![CI](https://github.com/nicksteiner/sardine/actions/workflows/ci.yml/badge.svg)](https://github.com/nicksteiner/sardine/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.0.0--beta.4-orange)](https://github.com/nicksteiner/sardine/releases)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![WebGL2](https://img.shields.io/badge/WebGL2-GPU--accelerated-blueviolet)](https://caniuse.com/webgl2)
[![No Server](https://img.shields.io/badge/runs-in--browser-brightgreen)](https://github.com/nicksteiner/sardine)

![SARdine viewer — NISAR GCOV RGB composite over the Amazon basin](docs/SARdine_window.png)

</div>

> **This project is under active development.** Some features are experimental or incomplete. Bug reports welcome via [GitHub Issues](https://github.com/nicksteiner/sardine/issues).

---

## What It Is

SARdine is a browser-native exploration and visualization GUI for NISAR HDF5 data. Drop in a file, explore the data, and export a figure or georeferenced dataset — no install beyond a web browser, no Python, no server.

It reads NISAR L2 GCOV HDF5 (`.h5`) directly using a custom JavaScript HDF5 reader (`h5chunk`). Rendering happens entirely on the GPU via WebGL2 shaders: dB scaling, colormaps, contrast stretching, and polarimetric composites all run at 60 fps. GCOV/GUNW files are 2–8 GB but only viewport-intersecting chunks are ever read.

---

## What You Can Do

**Explore full-resolution SAR data**
Drop in a large NISAR file and pan/zoom through it at full resolution. Switch polarizations (HH, HV, VV), adjust contrast with the live histogram, and apply stretch modes (linear, sqrt, gamma, sigmoid).

**Make publication-ready figures**
Enable the dual-pol RGB composite for multi-channel decomposition. Export a georeferenced figure PNG with scale bar, corner coordinates, and colorbar. Export scatter plots and histograms as publication SVGs.

**Classify and map land cover**
Draw an ROI, open the 2D feature space scatter (e.g. HH dB vs HV dB), define class regions by drawing rectangles, and see the classification overlay on the map in real time. Filter by incidence angle range (NISAR HDF5 only).

**Subset and export data**
Draw an ROI and export a subregion as a raw Float32 GeoTIFF (linear power, with CRS and tiepoints) or a rendered RGBA GeoTIFF. Works for both single-pol and RGB composites.

**Time series and change detection**
Load multiple dates for ROI time series plotting, or compose a multi-date RGB composite for change detection visualization.

**Stream from S3**
Paste a presigned URL and stream directly from a bucket — same workflow, no download required.

---

## Quick Start

SARdine requires **Node.js** (v18 or later) and **npm**.

```bash
git clone https://github.com/nicksteiner/sardine.git
cd sardine
npm install
npm run dev
```

Open **http://localhost:5173** in Chrome, Edge, or Firefox (WebGL2 required).

### Installing Node.js

**macOS:** `brew install node` or download from https://nodejs.org/

**Windows:** Download the installer from https://nodejs.org/ (LTS recommended).

**Linux (Debian/Ubuntu):**
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## Loading Data

Pick a mode from the **File Type** dropdown in the left panel.

### Local HDF5 Files

1. **File Type** → **NISAR GCOV HDF5 (Local File)**
2. **Choose File** → pick your `.h5`
3. Pick **Frequency** (`frequencyA` = high res, `frequencyB` = low res)
4. Pick **Polarization** (`HHHH`, `HVHV`, `VVVV`, etc.)
5. Optionally switch to **RGB Composite** and pick a preset
6. **Load Dataset**

Nothing is uploaded. Chunks are read directly from disk via the browser File API.

### Presigned URLs (S3 / HTTPS)

1. **File Type** → **Remote Bucket / S3**
2. Paste the presigned URL into **Direct URL**
3. **Load from URL** — metadata arrives via Range requests (~8 MB)
4. Pick frequency and polarization → **Load Remote Dataset**

File type is detected from the path: `.h5`/`.hdf5`/`.he5` → NISAR, `.tif`/`.tiff` → COG.

### COG URLs

1. **File Type** → **Cloud Optimized GeoTIFF (URL)**
2. Paste URL (presigned or public)
3. **Load COG**

---

## Tutorials

### Tutorial 1 — RGB Composite

RGB mode assigns polarimetric channels to color, making land cover patterns immediately visible. The most common case is a dual-pol file (HH + HV), which gives you two independent channels — SARdine fills the third using a ratio.

**You need:** A NISAR GCOV file with at least two polarizations (e.g. `HHHH` and `HVHV`).

1. Load your file (**File Type** → **NISAR GCOV HDF5 (Local File)**, click **Choose File**)
2. In the **Mode** selector, switch from **Single Polarization** to **RGB Composite**
3. Set **Preset** to **dual-pol-h** (HH+HV) or **dual-pol-v** (VV+VH) depending on your file
4. Click **Load Dataset** — SARdine loads both bands and renders the composite
5. Press `R` to auto-stretch contrast across all channels
6. Open the histogram (`H`) — you'll see three overlapping distributions, one per channel
7. Drag per-channel contrast handles to balance the composite if one color dominates
8. Press `Ctrl+S` to export a figure PNG with the RGB triangle colorbar

**Tips:**
- Water appears dark in all channels — usually a deep blue-black
- Vegetation is bright in cross-pol (HV) — shows as green
- Urban double-bounce is bright in co-pol (HH) — shows as red/orange
- Switch **Stretch** to `sqrt` or `gamma` to bring out low-backscatter features

---

### Tutorial 2 — Land Cover Classification

The feature space classifier lets you define land cover classes by drawing regions on a 2D scatter plot of two polarimetric channels. Classification updates on the map in real time.

**You need:** A NISAR GCOV file with at least two polarizations (e.g. `HHHH` and `HVHV`).

1. Load a single-pol dataset first (e.g. `HHHH`) so the basemap is visible
2. **Draw an ROI** — click and drag on the map to define your analysis region. Keep it focused on your area of interest; large ROIs are slower to scatter.
3. Press `C` to open the **Feature Space** panel
4. Set the **X axis** to `HH dB` and **Y axis** to `HV dB` using the axis dropdowns
5. The scatter plot populates with one point per pixel in your ROI
6. Click **+ Add Class** and give it a name (e.g. "Water")
7. Draw a rectangle on the scatter plot by clicking and dragging — pixels within that dB range light up on the map in the class color
8. Repeat for additional classes (e.g. "Vegetation", "Urban")
9. To filter by incidence angle (NISAR only): expand **Incidence Angle** and set a min/max range
10. Export options:
    - **SVG** button → publication-quality scatter plot with class regions
    - **Map** button → classification raster as a georeferenced PNG
    - **GeoTIFF** → rendered classification as an RGBA GeoTIFF

**Tips:**
- Zoom in on the scatter plot to draw precise class boundaries
- Water typically clusters at very low HH and HV (bottom-left corner)
- Urban double-bounce is high HH, low HV (right side, low on Y axis)
- Vegetation is high HV relative to HH (upper-left to center)

---

### Tutorial 3 — Time Series: ROI Plot and Multi-Date RGB Mosaic

SARdine supports two time series workflows: plotting backscatter over time for a fixed ROI, and compositing multiple dates into a single RGB image for change detection.

**You need:** Two or more NISAR GCOV files from the same track, different acquisition dates.

#### ROI Time Series Plot

1. Load your first date as usual (**Load Dataset**)
2. Draw an **ROI** over your target area (e.g. a field, wetland, or urban block)
3. In the **Time Series** panel, click **Add Date** and load a second `.h5` file
4. Repeat for all dates you want to include
5. SARdine extracts the mean backscatter (dB) within the ROI for each date and plots it as a time series
6. Click **Export SVG** to export the time series chart as a vector figure

**Tips:**
- Use a small, homogeneous ROI for cleaner signal — a 1 km² patch of a single land cover type
- Multi-look averaging is applied before extraction, matching on-screen rendering
- Add multiple ROIs to compare two land cover types on the same chart

#### Multi-Date RGB Mosaic (Change Detection)

This workflow assigns each of three acquisition dates to a color channel (R, G, B). Pixels that appear white have not changed; colored pixels changed between dates. Magenta/cyan artifacts often indicate flood extent or phenological change.

1. In **Mode**, select **RGB Composite** → **Preset: Multi-Date**
2. In the **Red channel** slot, load your earliest date
3. In the **Green channel** slot, load your middle date
4. In the **Blue channel** slot, load your latest date
5. Click **Load Dataset** — SARdine reads the same polarization from all three files and composites them
6. Press `R` to auto-stretch each channel independently
7. Zoom into areas of interest — colored patches indicate change, white/grey indicates stable backscatter
8. Export via `Ctrl+S` for a figure PNG, or use **GeoTIFF** → **RGB Composite** for a 3-band georeferenced export

**Tips:**
- Use the same polarization (e.g. `HHHH`) across all dates for a fair comparison
- Flood detection: flooded areas go dark in SAR — they appear as a single-channel dropout (pure R, G, or B color)
- For subtle change, try adjusting stretch to `sigmoid` to compress the dynamic range

---

## Controls

| Control | Description |
|:---|:---|
| **Colormap** | Grayscale, viridis, inferno, plasma, phase, sardine, flood, diverging, polarimetric |
| **Contrast** | Min/max dB range — drag sliders or use **Auto** for percentile-based stretch |
| **Stretch** | Linear, sqrt, gamma, sigmoid transfer function |
| **Multi-look** | Data reduction (box-filter averaging in linear power) |
| **Histogram** | Floating viewport histogram — auto-updates on pan/zoom, SVG export |
| **Classifier** | 2D/1D feature space scatter with class region drawing and incidence angle filter |
| **Overture** | Overlay boundaries, roads, or places from Overture Maps |

### Keyboard Shortcuts

| Key | Action |
|:---|:---|
| `H` | Toggle histogram overlay |
| `C` | Toggle feature space classifier |
| `F` | Fit view to data bounds |
| `R` | Reset contrast to auto |
| `G` | Toggle coordinate grid |
| `M` | Toggle overview map |
| `Ctrl+S` | Save figure (PNG) |

---

## Classification Workflow

1. Draw an **ROI** on the map (click and drag)
2. Press `C` to open the **Feature Space** scatter plot
3. Click **+ Add Class** to define a land cover class
4. Draw a rectangle on the scatter plot to assign pixels in that dB range
5. Pixels within the class region are colored on the map in real time
6. Export: **SVG** for the scatter plot, **Map** for the classification raster

---

## Export

### GeoTIFF

- **Raw Float32** — linear power values with CRS and tiepoints
- **Rendered RGBA** — what you see on screen (dB, colormap, contrast) as a 4-band GeoTIFF
- **RGB Composite** — 3-band GeoTIFF when in composite mode

Draw an ROI to export a subregion, or export the full extent.

### Figure PNG

Canvas capture with overlays: scale bar, corner coordinates, colorbar (or RGB triangle for composites), and classification overlay.

### Publication SVG

Vector graphics:
- **Scatter plot** — density heatmap with class regions, open L-axes, outward ticks, Helvetica
- **Histogram** — filled distribution with contrast limit markers and legend
- **Classification map** — embedded raster with vector legend and pixel counts

---

## How It Works

```
File/URL → h5chunk → Chunks → GPU Texture → GLSL Shader → Screen
                                                ↓
                                   dB scale → stretch → colormap → contrast
```

`h5chunk` is a pure JavaScript HDF5 chunk reader — no GDAL, no WASM, no server. It parses the HDF5 superblock, object headers, and B-tree to build a chunk index, then fetches only the chunks intersecting the current viewport via `File.slice()` (local) or HTTP Range (remote). Chunks are decompressed (deflate + shuffle) into Float32Arrays and uploaded directly as WebGL2 textures. The fragment shader handles the rest.

GCOV and GUNW products are supported. GUNW (interferometric phase and coherence) is developmental.

### Tech Stack

| Dependency | Role |
|:---|:---|
| **React 18** | UI framework |
| **deck.gl 8.9** | WebGL tile/bitmap rendering |
| **geotiff.js** | COG loading via HTTP Range |
| **h5chunk** (built-in) | Cloud-optimized HDF5 streaming (pure JS) |
| **h5wasm** | HDF5 attribute/metadata parsing (WASM) |
| **MapLibre GL** | Basemap rendering |
| **Vite** | Dev server and build tool |

---

## Server Mode (JupyterHub / NISAR ODS)

```bash
cd ~/sardine
npm install --legacy-peer-deps && npm run build
node server/launch.cjs --data-dir /home/jovyan
```

Access via JupyterLab proxy: `https://<hub-host>/user/<username>/proxy/8050/`

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

## Known Issues

| Issue | Status |
|:---|:---|
| Georeferencing errors on coarse overviews | Low priority |
| Small area GeoTIFFs may be invalid | Low priority |
| Slow loading RGB frequency A | Low priority |

---

## License

AGPL-3.0. Previously MIT (through 3/5/26). Commercial licensing available — contact [nick.steiner@gmail.com](mailto:nick.steiner@gmail.com).

---

<sub>

[h5wasm](https://github.com/usnistgov/h5wasm) · [geotiff.js](https://geotiffjs.github.io/) · [deck.gl](https://deck.gl/) · NISAR cloud-optimization: [NSIDC](https://nsidc.org/) + JPL

`CCNY Earth & Atmospheric Sciences`

</sub>
