# Why SARdine? A QGIS Comparison

> "Why not just use QGIS?" — a fair question, and one worth answering honestly.

## The Short Answer

QGIS is a general-purpose desktop GIS. SARdine is a purpose-built SAR data viewer. They solve different problems:

| | QGIS | SARdine |
|---|---|---|
| **Scope** | Everything spatial | SAR imagery |
| **Install** | Desktop app + GDAL + plugins | Browser tab |
| **NISAR HDF5** | Load entire file (2–8 GB) via GDAL | Stream viewport chunks (~100 KB) |
| **Contrast change** | CPU re-render (seconds) | GPU uniform update (< 16 ms) |
| **SAR composites** | Manual band math | One-click presets (Pauli, Freeman-Durden) |
| **Audience** | GIS analysts with desktop access | Anyone with a browser |

QGIS is the better tool when you need to overlay SAR with dozens of other vector/raster layers, run spatial analysis, or integrate into an existing GIS workflow. SARdine is the better tool when you need to quickly inspect, interpret, and share SAR data — especially NISAR products.

## Where SARdine Wins

### 1. Zero-Install, Zero-Config

SARdine runs in a browser. No installer, no GDAL, no conda environment, no plugin manager. Share a URL; the recipient is looking at SAR data in seconds.

This matters for:
- **Stakeholder briefings** — A program manager doesn't have QGIS installed
- **Field teams** — Tablet or Chromebook, no admin rights
- **Workshops** — 30 participants, zero setup time
- **Jupyter environments** — Embed in a notebook without a desktop session

### 2. Streaming HDF5 Without Loading the Whole File

NISAR GCOV products are 2–8 GB HDF5 files. QGIS (via GDAL) must download or memory-map the entire file before rendering a single pixel.

SARdine's `h5chunk.js` reads ~8 MB of metadata (superblock, B-trees, chunk index), then fetches only the chunks that intersect the current viewport via HTTP Range requests or `File.slice()`. Pan to a new area? Fetch those chunks. Zoom out? Fetch lower-resolution chunks.

**Practical difference:**
- QGIS on a 5 GB file over a 10 Mbps link: ~70 minutes to first pixel
- SARdine on the same file: ~10 seconds to first pixel (metadata + one screen of chunks)

This isn't a QGIS limitation per se — it's a GDAL limitation with NISAR's HDF5 layout. GDAL's HDF5 driver doesn't do chunk-indexed range reads the way SARdine does.

### 3. GPU-Accelerated SAR Rendering

Every pixel in SARdine's display pipeline runs through a WebGL2 fragment shader:

```
linear power → 10·log₁₀(dB) → normalize → stretch → colormap → RGBA
```

When you drag a contrast slider, change a colormap, or toggle dB mode, **no data is re-fetched**. The GPU re-renders the existing texture with updated uniforms in under 16 ms (one frame at 60 fps).

In QGIS, changing contrast or colormap triggers a CPU-side raster re-render. For a large raster this takes seconds, and the UI blocks during the operation.

This matters most during **iterative exploration** — the core SAR analysis workflow of "adjust contrast, check features, adjust again." SARdine makes this feel like adjusting brightness on a photo. QGIS makes it feel like re-opening the file.

### 4. SAR-Native Composites and Decompositions

SARdine ships with polarimetric composites that understand SAR physics:

| Preset | R | G | B | Use Case |
|--------|---|---|---|----------|
| **Pauli** | \|HH−VV\| | \|HV\| | \|HH+VV\| | Surface vs. volume vs. double-bounce |
| **Freeman-Durden** | Pd | Pv | Ps | 3-component physical decomposition |
| **Dual-pol H** | HH | HV | HH/HV | Vegetation structure with co/cross ratio |
| **Dual-pol V** | VV | VH | VV/VH | Same for V-transmit |
| **Quad-pol** | HH | HV | VV | Direct polarization comparison |

In QGIS, creating a Pauli composite requires:
1. Load all polarization bands separately
2. Open raster calculator
3. Write band math: `abs(HH - VV)`, `abs(HV)`, `abs(HH + VV)`
4. Create a virtual raster stack
5. Style as RGB
6. Manually set per-channel stretch

In SARdine: select "Pauli" from a dropdown. Done.

Freeman-Durden is even harder in QGIS — it requires the complex cross-covariance term (Re(HHVV*)), which QGIS's raster calculator can't access from HDF5 without preprocessing.

### 5. Interactive, Viewport-Adaptive Histogram

SARdine's histogram recomputes as you pan and zoom, showing the statistical distribution of **only the data currently on screen**. Percentile markers (2nd/98th) update in real time, and auto-contrast adapts to the local scene.

QGIS computes the histogram once at load time over the full raster. Its "cumulative cut" stretch is based on global statistics, which means bright urban areas wash out when you're zoomed into a dark forest, and vice versa.

### 6. Publication-Ready Figure Export

One click produces a PNG with:
- Scale bar (dynamically computed from bounds and zoom)
- Corner coordinates
- Colorbar (linear or RGB triangle for composites)
- Product metadata (filename, CRS, polarization, contrast limits)

QGIS has a powerful print composer, but it requires manual layout configuration — typically 10–15 minutes to produce a similar figure. SARdine optimizes for the common case: "I need a figure for a slide deck in 30 seconds."

### 7. NISAR Product Awareness

SARdine parses NISAR-specific metadata:
- Orbit number, track, frame, look direction, pass direction
- Zero-Doppler start/end times
- Processing flags (RTC applied, RFI correction, ionosphere correction)
- Available polarizations and covariance terms
- Backscatter convention (gamma0 vs. sigma0)

QGIS sees an HDF5 file. SARdine sees a NISAR GCOV product.

## Where QGIS Wins

Being honest about limitations:

### Multi-Layer Analysis
QGIS can overlay SAR with vector boundaries, DEMs, land cover, cadastral data, point clouds, and hundreds of other formats simultaneously. SARdine supports SAR rasters and Overture Maps vectors — that's it.

### Spatial Analysis & Processing
QGIS has ~1,000 processing algorithms (via QGIS Processing, GDAL, GRASS, SAGA). Buffer, intersect, reclassify, terrain analysis, network analysis. SARdine has no general-purpose spatial analysis.

### Cartography
QGIS's print composer is a full cartographic layout engine: multiple map frames, legends, text boxes, north arrows, scalebars with style options, atlas generation. SARdine exports single-frame figures.

### Vector Editing
QGIS has full-featured vector editing: create/modify geometries, attribute tables, joins, spatial queries. SARdine has read-only vector overlay.

### Plugin Ecosystem
3,000+ QGIS plugins. Need to connect to a WMS, run a machine learning classifier, generate contours from a DEM? There's a plugin. SARdine is a focused tool with no plugin system.

### Mature & Battle-Tested
QGIS has been developed since 2002 by hundreds of contributors. It handles edge cases, projections, and data formats that SARdine hasn't encountered yet.

## When to Use Which

| Scenario | Use |
|----------|-----|
| Quick-look at a NISAR GCOV file | **SARdine** |
| Iterative contrast/colormap exploration | **SARdine** |
| Stakeholder demo (no install) | **SARdine** |
| Polarimetric decomposition | **SARdine** |
| Overlay SAR with 10 other layers | **QGIS** |
| Spatial analysis (buffer, clip, reclassify) | **QGIS** |
| Production cartography | **QGIS** |
| Vector digitizing / editing | **QGIS** |
| Stream a remote 5 GB HDF5 without downloading | **SARdine** |
| Quick figure for a slide deck | **SARdine** |
| Formal map product with legend and multiple frames | **QGIS** |
| Workshop with 30 participants, mixed OS | **SARdine** |
| Time-series change detection RGB | **SARdine** |
| Machine learning on raster stacks | **QGIS** |

## The Honest Summary

QGIS is a Swiss Army knife. SARdine is a sashimi knife.

If your job is "do everything spatial," use QGIS. If your job is "look at SAR data, understand it quickly, and share what you see," SARdine does that faster, with less friction, and with more SAR domain knowledge built in.

They're complementary. SARdine exports GeoTIFFs that open directly in QGIS. The typical workflow is: explore in SARdine, export what matters, do deeper analysis in QGIS/Python.
