<div align="center">

```
                                  ███████╗ █████╗ ██████╗      ██╗██╗███╗   ██╗███████╗
                                  ██╔════╝██╔══██╗██╔══██╗ ██████║██║████╗  ██║██╔════╝
                                  ███████╗███████║██████╔╝██╔══██║██║██╔██╗ ██║█████╗
                                  ╚════██║██╔══██║██╔══██╗██║  ██║██║██║╚██╗██║██╔══╝
                                  ███████║██║  ██║██║  ██║╚█████╔╝██║██║ ╚████║███████╗
                                  ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚════╝ ╚═╝╚═╝  ╚═══╝╚══════╝
```

**Browser-native NISAR HDF5 viewer**

*Stream cloud-optimized SAR data straight to GPU — javascript-native chunking*

`v1.0` · `MIT` · `Feb 2026`

</div>

---

> **`01` OVERVIEW**

SARdine loads NASA NISAR Level-2 GCOV products directly in the browser. It parses the cloud-optimized HDF5 metadata in a single read, fetches only the chunks needed for the current viewport, and renders them through WebGL shaders on deck.gl. Zero Python. Zero backend. Just a URL (or a local file drag-and-drop) and you're looking at quad-pol SAR data.

---

> **`02` CAPABILITIES**

| Capability | Detail |
|:---|:---|
| **NISAR GCOV HDF5** | L2 Geocoded Covariance — `HHHH` `HVHV` `VHVH` `VVVV` and cross-pol terms |
| **Cloud-optimized streaming** | Paged-aggregation metadata read (~8 MB), chunk index, byte-range fetch on demand — same pattern as COG |
| **RGB polarimetric composites** | `HH/HV/VV` · Pauli power · dual-pol VV/VH · custom presets → 3-channel GPU textures |
| **Cloud Optimized GeoTIFF** | Loads COGs from any URL — ICEYE, Capella, Umbra, Sentinel-1, any SAR vendor |
| **dB scaling on GPU** | GLSL: linear power → σ° dB · colormaps (grayscale, viridis, inferno, plasma, phase) · per-channel contrast · 60 fps |
| **GeoTIFF export** | Current RGB composite → georeferenced 3-band GeoTIFF with CRS + tiepoints |
| **Figure export** | deck.gl canvas → PNG with metadata overlay |

---

> **`03` QUICK START**

```bash
npm install
npm run dev
```

→ Open `http://localhost:5173`
→ Drag a NISAR `.h5` file onto the file picker, or paste a COG URL

---

> **`04` LOADING NISAR HDF5**

#### In the app

1. Set **File Type** → `NISAR GCOV HDF5`
2. Select a `.h5` file
3. SARdine reads metadata, discovers frequency bands (`L`/`S`) and polarizations
4. Choose **Single Band** or **RGB Composite** display mode
5. Click **Load** — data streams in chunk-by-chunk

#### Programmatically

```javascript
import {
  listNISARDatasets,
  loadNISARGCOV,
  loadNISARRGBComposite,
} from 'sardine';

// → Discover what's in the file
const datasets = await listNISARDatasets(file);
// → [{frequency: 'A', polarization: 'HHHH'}, {frequency: 'A', polarization: 'HVHV'}, ...]

// → Load a single polarization band
const { getTile, bounds, width, height, crs, stats } = await loadNISARGCOV(file, {
  frequency: 'A',
  polarization: 'HHHH',
});

// → Load an RGB composite
const rgb = await loadNISARRGBComposite(file, {
  frequency: 'A',
  compositeId: 'pauli-power',
});
```

#### RGB composite presets

| Preset | R | G | B | Use case |
|:---|:---|:---|:---|:---|
| `hh-hv-vv` | `HHHH` | `HVHV` | `VVVV` | Standard quad-pol overview |
| `pauli-power` | `\|HH−VV\|` | `HV` | `HH+VV` | Scattering mechanism decomposition |
| `dual-pol-v` | `VV` | `VH` | `VV÷VH` | Sentinel-1 style dual-pol |
| `dual-pol-h` | `HH` | `HV` | `HH÷HV` | H-transmit dual-pol |

---

> **`05` LOADING CLOUD OPTIMIZED GeoTIFFs**

```javascript
import { loadCOG, SARViewer } from 'sardine';

const cog = await loadCOG('https://bucket.s3.amazonaws.com/sar-image.tif');

<SARViewer
  cogUrl={cog.cogUrl}
  bounds={cog.bounds}
  contrastLimits={[-25, 0]}
  useDecibels={true}
  colormap="grayscale"
/>
```

→ Auto-detects projected vs geographic coordinates
→ Selects appropriate overview level for current zoom

---

> **`06` HOW CLOUD-OPTIMIZED HDF5 STREAMING WORKS**

NISAR adopted the same cloud-optimization strategy developed by NSIDC for ICESat-2:

| Step | Detail |
|:---|:---|
| **Paged aggregation** | All file-level metadata consolidated at the front of the file in a fixed-size page |
| **Large chunk sizes** | 2–10 MiB data chunks for efficient range reads |
| **Minimal variable-length types** | Enables clean HTTP range GET access |

SARdine's `h5chunk` module exploits this — a **JavaScript-native Kerchunk**:

```
→ Fetch metadata page (~8 MB, one request)
  → Parse HDF5 superblock, object headers, B-tree
  → Build chunk index: {dataset → [{offset, size, chunk_coords}]}
  → For current viewport, fetch intersecting chunks via Range requests
  → Decompress (deflate + shuffle) → Float32Array
  → Push to deck.gl as WebGL texture
  → GPU does dB conversion + colormap at 60 fps
```

---

> **`07` RENDERING PIPELINE & MULTI-LOOK**

SARdine processes radar backscatter in **linear power** (σ⁰) and only converts to decibels at the final GPU stage. This ordering matters — averaging in dB would compute a geometric mean, underestimating true mean backscatter and distorting radiometric calibration.

```
raw σ⁰ (linear)  →  resample / average  →  10·log₁₀  →  colormap  →  RGBA texture
     ↑                    ↑                    ↑            ↑
  Float32Array     box-filter or NN        GPU shader    GLSL LUT
```

#### Multi-look mode

The **Multi-look** toggle switches between two downsampling strategies:

| | Multi-look ✓ | Multi-look ✗ |
|:---|:---|:---|
| **Resample** | Box-filter — sums every source pixel in each output footprint | Nearest-neighbour — one sample per output pixel |
| **Chunk path** | `nSub = 4–8` (reads more samples per chunk) | `nSub = 1` (one sample per chunk) |
| **Speckle** | Reduced ~1/√N | Full speckle |
| **Speed** | Slower (10–50× more samples) | Blazing fast |
| **Cache** | Separate key (`ml` suffix) | Separate key (`nn` suffix) |

Box-filter area averaging in linear power is equivalent to **spatial multi-looking** — the standard SAR technique for speckle suppression. Both tile sets coexist in cache, so toggling is instant for already-fetched tiles.

#### Why linear, not dB?

Averaging *N* pixels in linear power gives the arithmetic mean:

$$\bar{\sigma}^0 = \frac{1}{N}\sum_{i=1}^{N} \sigma^0_i$$

Averaging in dB would give:

$$\frac{1}{N}\sum_{i=1}^{N} 10\log_{10}(\sigma^0_i) = 10\log_{10}\!\left(\prod_{i=1}^{N} \sigma^0_i\right)^{1/N}$$

— a geometric mean, which is always ≤ the arithmetic mean and systematically biases backscatter low. SARdine avoids this by keeping all resampling in linear power space.

---

> **`08` ARCHITECTURE**

```
src/
├── loaders/
│   ├── h5chunk.js           ← Cloud-optimized HDF5 chunk reader (JS Kerchunk)
│   ├── nisar-loader.js      ← NISAR GCOV product loader (h5chunk + h5wasm)
│   ├── hdf5-chunked.js      ← Fallback chunked HDF5 reader
│   └── cog-loader.js        ← Cloud Optimized GeoTIFF loader
├── layers/
│   ├── SARTileLayer.js      ← deck.gl tile layer with SAR shaders
│   ├── SARBitmapLayer.js    ← Full-image bitmap layer
│   ├── SARTiledCOGLayer.js  ← Tiled COG with dynamic overviews
│   └── shaders.js           ← GLSL: dB scaling, 5 colormaps, contrast
├── viewers/
│   ├── SARViewer.jsx        ← Primary orthographic viewer
│   ├── ComparisonViewer.jsx ← Side-by-side + swipe comparison
│   └── MapViewer.jsx        ← MapLibre basemap with SAR overlay
├── components/
│   ├── Histogram.jsx        ← Per-channel histogram with contrast sliders
│   ├── StatusWindow.jsx     ← Collapsible log panel
│   ├── LoadingIndicator.jsx
│   └── ScaleBar.jsx
├── utils/
│   ├── sar-composites.js    ← RGB composite presets (Pauli, dual-pol, etc.)
│   ├── colormap.js          ← Grayscale, viridis, inferno, plasma, phase
│   ├── stats.js             ← Histogram, percentile, auto-contrast
│   ├── geotiff-writer.js    ← Minimal GeoTIFF writer for export
│   └── figure-export.js     ← Canvas → PNG export
└── theme/
    └── sardine-theme.css    ← Design system (dark-first, mission-critical)
```

---

> **`09` TECH STACK**

| Dependency | Role |
|:---|:---|
| `h5wasm` | Full HDF5 reading for files loaded into memory |
| `h5chunk` (built-in) | Cloud-optimized HDF5 streaming via byte-range requests |
| `geotiff.js` | COG loading and metadata parsing |
| `deck.gl 8.9` | WebGL tile rendering with custom GLSL shaders |
| `React 18` | UI components |
| `MapLibre GL` | Basemap rendering |
| `Vite` | Dev server and build |

---

> **`10` DEVELOPMENT**

```bash
npm install          # → Install dependencies
npm run dev          # → Dev server at http://localhost:5173
npm run build        # → Production build
npm run example      # → Minimal example app
```

#### Testing with NISAR data

Place a NISAR GCOV `.h5` file in `test_data/`, then:

```bash
node test-h5-diagnostic.mjs   # → Parse HDF5 structure, report B-tree layout
node test-h5-images.mjs       # → Read chunks, write PGM images to test_output/
```

---

> **`11` ROADMAP**

| Feature | Status |
|:---|:---|
| NISAR GCOV HDF5 loading (`h5wasm`) | ✅ Complete |
| Cloud-optimized HDF5 streaming (`h5chunk`) | ✅ Complete |
| RGB polarimetric composites | ✅ Complete |
| COG loading + tiled rendering | ✅ Complete |
| GPU dB scaling + colormaps | ✅ Complete |
| Per-channel histogram + contrast | ✅ Complete |
| GeoTIFF RGB export | ✅ Complete |
| State-as-markdown editing | ✅ Complete |
| HTTP range-request streaming (S3/HTTPS) | 🔜 Next |
| B-tree v2 parsing | 🔜 Next |
| Worker thread decompression | 🔜 Next |
| Chat-driven state control | 🔜 Next |
| Basemap annotations + drawing | 🔜 Next |
| GUNW / InSAR phase visualization | 🔜 Planned |
| ASF catalog search integration | 🔜 Planned |

---

> **`12` DESIGN SYSTEM**

SARdine uses a dark-first design system built for operational SAR monitoring.

| Token | Value | Role |
|:---|:---|:---|
| `--sardine-bg` | `#0a1628` | Base background — deep navy |
| `--sardine-cyan` | `#4ec9d4` | Primary accent — interactive elements, links, active states |
| `--sardine-orange` | `#e8833a` | Alerts — warnings, urgent data, flood events |
| `--sardine-green` | `#3ddc84` | VV polarization — success, complete |
| `--sardine-magenta` | `#d45cff` | HH polarization — code syntax |
| `--font-mono` | JetBrains Mono | Data, coordinates, timestamps, metrics, code |
| `--font-display` | Space Grotesk | Section headers, card titles |
| `--font-body` | IBM Plex Sans | Descriptions, paragraphs, body text |

→ [Full style guide](docs/sardine-style-guide.html) — complete component reference with swatches, typography specimens, and UI patterns

---

> **`13` LICENSE**

MIT

---

<sub>

**→** [h5wasm](https://github.com/usnistgov/h5wasm) — HDF5 in WebAssembly
**→** [geotiff.js](https://geotiffjs.github.io/) — GeoTIFF parsing
**→** [deck.gl](https://deck.gl/) — WebGL rendering
**→** NISAR cloud-optimization strategy — [NSIDC](https://nsidc.org/) + JPL

`Earth Big Data LLC` × `CCNY Earth & Atmospheric Sciences`

</sub>
