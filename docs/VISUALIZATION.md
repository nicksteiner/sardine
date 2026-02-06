# SARdine SAR Visualization Plan

## Design Philosophy

A SAR scientist opens SARdine, points it at a NISAR product (or any supported SAR vendor), and immediately sees their data on a map with sensible defaults. No format conversion, no command-line preprocessing, no downloading. Every interaction a scientist would normally do in SNAP, QGIS, or a Jupyter notebook should be one click or one slider in SARdine.

---

## 1. Data Ingestion

### What the scientist does
Pastes an S3 URI, selects from a product catalog, or drags in a local file.

### What SARdine does

| Input | Behavior |
| :---- | :------- |
| S3 URI to NISAR `.h5` | Stream directly from cloud via range reads. No download. |
| S3 URI to ICEYE / Capella / Umbra `.tif` | Stream as COG via deck.gl TileLayer. |
| Local `.h5` or `.tif` | Read via h5wasm or GeoTIFF.js in browser. |
| Shopping list CSV | Batch load all products, populate time series selector. |
| ASF search URL | Query ASF API, display available scenes on map, click to load. |

### Auto-detection
SARdine reads the filename and metadata to auto-detect:
- **Vendor**: NISAR, ICEYE, Capella, Umbra, Sentinel-1
- **Product type**: GCOV, GUNW, GSLC, SLC, GRD, GEC
- **Polarization**: HH, HV, VH, VV, dual-pol, quad-pol
- **Orbit direction**: Ascending / Descending
- **Frequency band**: L-band, S-band, C-band, X-band

No menus to configure. It just knows.

---

## 2. Default Rendering

When a product loads, SARdine applies sensible SAR defaults immediately — no blank canvas, no "select a band" dialogs.

### Backscatter (GCOV, GRD, GEC)

| Setting | Default | Why |
| :------ | :------ | :-- |
| Scale | dB (10·log₁₀) | Nobody looks at linear power |
| Range | -25 to 0 dB | Reasonable for most land cover |
| Colormap | Grayscale | Standard SAR convention |
| Nodata | Transparent | NaN and 0 masked out |

### Interferometry (GUNW)

| Setting | Default | Why |
| :------ | :------ | :-- |
| Unwrapped phase | HSV cyclic colormap | Standard InSAR convention |
| Coherence | Magma, 0–1 | Highlights low coherence areas |
| Connected components | Categorical colors | Identify disconnected regions |

### Offset Tracking (GOFF)

| Setting | Default | Why |
| :------ | :------ | :-- |
| Range/Azimuth offset | Diverging colormap (blue-white-red) | Show direction of motion |
| Magnitude | Viridis | Highlight fast-moving areas |

### Complex (GSLC, RSLC)

| Setting | Default | Why |
| :------ | :------ | :-- |
| Amplitude | dB grayscale, -25 to 0 | Same as backscatter |
| Phase | HSV cyclic | Standard convention |

All of these are the starting point. The scientist tweaks from here, not from zero.

---

## 3. Interactive Controls

Everything a SAR scientist reaches for constantly, surfaced as immediate UI elements.

### Stretch / Colormap Panel (Always Visible)

```
┌─────────────────────────────────────┐
│  ◉ dB  ○ Linear  ○ Amplitude       │
│                                     │
│  Min ◄━━━━━━━━━━━━━━━━━━━━━► Max   │
│  -30 dB                     5 dB    │
│                                     │
│  Colormap: [Grayscale ▾]           │
│  ☐ Histogram stretch (2–98%)       │
│  ☐ Clip to AOI                     │
└─────────────────────────────────────┘
```

- **dB / Linear / Amplitude toggle** — GPU converts on the fly, no re-fetch
- **Min/Max sliders** — real-time adjustment, GPU colormap update
- **Histogram stretch** — auto-compute 2nd/98th percentile from visible viewport
- **Colormap picker** — grayscale, viridis, magma, inferno, turbo, HSV cyclic, diverging

All of this runs on the GPU. Changing the stretch or colormap is instant.

### Polarization Selector (Priority)

```
┌─────────────────────────────────────┐
│  Polarization                       │
│  ◉ HH  ○ HV  ○ VH  ○ VV          │
│                                     │
│  RGB Composite:                     │
│  R: [co-pol ▾]  G: [cross-pol ▾]  B: [co-pol/cross-pol ▾] │
│  ☐ Enable RGB mode                 │
└─────────────────────────────────────┘
```
Default --> R (co-pol), G (cross-pol), B (co-pol/cross-pol)

- Single-pol view: one click switches between available polarizations
- RGB composite: assign any pol to any channel, GPU blends in real time
- Pauli decomposition preset: R=HH-VV, G=HV, B=HH+VV (one-click)

### Orbit / Geometry Info Bar (Always Visible)


```
┌──────────────────────────────────────────────────────────┐
│  NISAR L2 GCOV │ Track 147 │ Frame 175 │ Asc │ L-band   │
│  2026-01-31 10:44 UTC │ Cycle 016 │ DHDH │ 0.25.6      │
└──────────────────────────────────────────────────────────┘
```

Parsed from product metadata. Always visible. No hunting through file attributes.

### Cursor Inspector

Hover over any pixel and see:

```
┌─────────────────────────────┐
│  Lat: 65.4321° Lon: -148.7654° │
│  HH: -12.3 dB (0.059 linear)   │
│  HV: -18.7 dB (0.013 linear)   │
│  Incidence angle: 34.2°         │
│  Slant range: 852.1 km          │
└─────────────────────────────┘
```

Scientists live by pixel values. This should update at 60fps as the cursor moves.

---

## 4. Time Series & Change Detection

### Timeline Scrubber (not priority)

When multiple acquisitions are loaded (e.g., from a shopping list CSV):

```
┌────────────────────────────────────────────────────┐
│  ◄  12/26  │  01/07  │  01/19  │  01/31  ►        │
│      ●         ●         ●         ◉               │
│                                                    │
│  ▶ Play   ⏸ Pause   Speed: [1x ▾]                │
│  ☐ Loop                                           │
└────────────────────────────────────────────────────┘
```

- Click a date to jump to that acquisition
- Play button animates through dates (configurable speed)
- deck.gl transitions smoothly between frames

### Split View / Swipe (not priority)

```
┌──────────────────┬──────────────────┐
│                  │                  │
│   2026-01-19     │   2026-01-31     │
│   (pre-flood)    ◄►  (post-flood)   │
│                  │                  │
└──────────────────┴──────────────────┘
```

- Vertical swipe divider between two dates
- Both sides zoom/pan in sync
- Drag the divider to reveal differences

### Difference Map 

One-click difference between any two dates:

- **dB difference**: σ₀(t2) - σ₀(t1) — highlights backscatter change
- **Log ratio**: 10·log₁₀(σ₀(t2) / σ₀(t1)) — standard change detection
- **Coherence change**: γ(t2) - γ(t1) — for InSAR products
- Rendered with diverging colormap (blue = decrease, red = increase)
- GPU computes the difference — no server round trip

---

## 5. Analysis Tools

### Transect / Profile Tool (not priority)

Draw a line on the map, get a backscatter profile:

```
     0 ┤
   -5  ┤        ╭─╮
  -10  ┤   ╭────╯ ╰──╮
  -15  ┤───╯          ╰───╮
  -20  ┤                   ╰──
  -25  ┤
       └─────────────────────── Distance (km)
         Water  │ Veg  │  Urban
```

- Click two points → instant profile chart
- Multi-date overlay: same transect across all loaded dates
- Export as CSV

### AOI Statistics (not priority)

Draw a polygon → get stats for that region:

```
┌─────────────────────────────────────┐
│  AOI Statistics (drawn polygon)     │
│  Mean: -11.2 dB   Std: 3.4 dB     │
│  Min: -24.1 dB    Max: -2.3 dB    │
│  Pixels: 14,832                    │
│  Area: 23.4 km²                    │
│                                     │
│  [Histogram]  [Time series plot]   │
│  [Export CSV]  [Copy to clipboard] │
└─────────────────────────────────────┘
```

- Time series plot of AOI mean across all loaded dates
- Histogram of pixel values within AOI
- All computed client-side from cached tile data

### Flood Extent Thresholding (not priority)

Since HiFLOWS is a core use case:

```
┌─────────────────────────────────────┐
│  Flood Detection                    │
│                                     │
│  Threshold: ◄━━━━━━━━━► -15.0 dB  │
│  ☐ Auto (Otsu)                     │
│  ☐ Show flood mask overlay         │
│  ☐ Show pre-event comparison       │
│                                     │
│  Flood area: 342.7 km²             │
│  [Export GeoJSON]  [Export GeoTIFF] │
└─────────────────────────────────────┘
```

- Adjustable dB threshold with real-time mask preview
- Otsu automatic thresholding
- Export flood polygon as GeoJSON or raster as GeoTIFF
- Change detection mode: (post - pre) with automatic threshold

---

## 6. Layer Management

### Base Maps (not priority)
- Satellite imagery (default for context)
- OpenStreetMap (for urban analysis)
- Terrain/hillshade (for topographic context)
- Dark/light minimal (for presentations)
- None (SAR only)

### Overlay Layers (not priority)
- Country/state/admin boundaries
- Coastlines and water bodies
- DEM contours
- User-uploaded GeoJSON/Shapefile (drag and drop)
- Flood extent polygons (from threshold tool)
- NISAR frame/track footprints

### Layer Opacity
Every layer (including SAR) has an opacity slider. Scientists constantly toggle between SAR and optical for context.

---

## 7. Export & Sharing

| Action | Output |
| :----- | :----- |
| Screenshot | PNG with scale bar, colorbar, metadata annotation |
| Export visible extent | GeoTIFF (from cached tiles, client-side) |
| Export flood polygon | GeoJSON |
| Export transect/stats | CSV |
| Share view | URL with encoded viewport, product, stretch settings |
| Embed | iframe snippet for reports/websites |

The share URL is critical — a scientist sends a colleague a link and they see the exact same view, same product, same stretch. No setup.

---

## 8. Keyboard Shortcuts

| Key | Action |
| :-- | :----- |
| `1-4` | Switch polarization (HH, HV, VH, VV) |
| `R` | Toggle RGB composite mode |
| `D` | Toggle dB / Linear |
| `H` | Histogram stretch to viewport |
| `F` | Toggle flood mask |
| `T` | Activate transect tool |
| `←` `→` | Previous / next date |
| `Space` | Play/pause time series |
| `S` | Screenshot |
| `I` | Toggle cursor inspector |
| `L` | Cycle base map |

SAR scientists process hundreds of scenes. Keyboard shortcuts are not optional.

---

## 9. Multi-Vendor Support Matrix

| Vendor | Format | Access | Polarizations | Auto-detect |
| :----- | :----- | :----- | :------------ | :---------- |
| NISAR | HDF5 (cloud-opt) | S3 range read | HH+HV or VV (L), full quad planned | ✅ |
| ICEYE | GeoTIFF / COG | S3 / HTTPS | VV | ✅ |
| Capella | GeoTIFF / COG | S3 / HTTPS | HH | ✅ |
| Umbra | GeoTIFF / COG | S3 / HTTPS | VV | ✅ |
| Sentinel-1 | SAFE / COG (ASF) | ASF S3 | VV+VH or HH+HV | ✅ |
| ALOS-2 | CEOS / GeoTIFF | Local / HTTPS | HH, HV, full quad | ✅ |

SARdine abstracts all of this behind the same UI. The scientist doesn't care about format — they care about backscatter.

---

## 10. Architecture Summary

```
┌──────────────────────────────────────────────────────┐
│                    Browser (Client)                   │
│                                                      │
│  ┌─────────┐  ┌──────────┐  ┌─────────────────────┐ │
│  │ UI      │  │ h5chunk  │  │ deck.gl             │ │
│  │ Controls│  │ (range   │  │ TileLayer           │ │
│  │ Panels  │  │  reader) │  │ GPU colormap        │ │
│  │ Charts  │  │          │  │ GPU compositing     │ │
│  │ Export  │  │          │  │ GPU change detect   │ │
│  └────┬────┘  └────┬─────┘  └─────────┬───────────┘ │
│       │            │                   │             │
│       └────────────┴───────────────────┘             │
│                        │                             │
└────────────────────────┼─────────────────────────────┘
                         │ HTTP Range GET
                         ▼
              ┌─────────────────────┐
              │  S3 / Cloud Storage │
              │  NISAR, ICEYE, etc. │
              │  (us-west-2)        │
              └─────────────────────┘
```

For NISAR: no server needed if h5chunk JS reader is built.
For COG vendors (ICEYE, Capella, Umbra): no server needed — GeoTIFF.js reads COGs natively in browser.

Optional thin tiler (titiler.xarray) as a fallback for complex HDF5 access or for generating pre-rendered tiles for slower connections.

---

## Priority Order

1. **Load and render a single NISAR GCOV with sensible defaults** — this is the demo moment
2. **Stretch controls + colormap picker** — first thing every scientist reaches for
3. **Polarization switcher** — second thing they reach for
4. **Cursor inspector with pixel values** — third thing
5. **Multi-date loading from shopping CSV + timeline scrubber**
6. **Split view / swipe comparison**
7. **Difference map (change detection)**
8. **Transect and AOI stats tools**
9. **Flood thresholding + export**
10. **Multi-vendor COG support**
11. **Share URLs**
12. **RGB composite / Pauli decomposition**