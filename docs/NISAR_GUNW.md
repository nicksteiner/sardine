# NISAR L2 GUNW Product Specification

> JPL D-102272 Rev E, November 8, 2024, Version 1.2.1
> Authors: Virginia Brancato, Jungkyo Jung, Xiaodong Huang, Heresh Fattahi
> See also: [NISAR_PRODUCTS.md](NISAR_PRODUCTS.md) for cross-product reference

## 1. Product Overview

**GUNW** (Geocoded Unwrapped Interferogram, L2_GUNW) measures ground surface displacement between two SAR acquisitions. It is derived from a pair of RSLC images by computing the interferometric phase difference, unwrapping the cyclic phase, and geocoding everything onto a map grid.

### Processing chain

```
RSLC (reference) ──┐
                    ├── L1 RIFG (wrapped interferogram in radar coords)
RSLC (secondary) ──┘       │
                           └── L1 RUNW (unwrapped in radar coords)
                                   │
                                   └── L2 GUNW (geocoded unwrapped interferogram)
```

### Science applications

- **Crustal deformation** — Earthquakes, volcanic inflation/deflation, tectonic creep
- **Land subsidence** — Groundwater extraction, mining, urban settlement
- **Glacier and ice sheet motion** — Via pixel offset layers
- **Landslide monitoring** — Slow-moving slope displacement
- **Ionospheric studies** — Via ionospheric phase screen layer

### Key properties

| Property | Value |
|:---------|:------|
| Product type | `L2_GUNW` |
| Format | HDF5 v5 (paged aggregation) |
| Projection | UTM or Polar Stereographic (per-frame EPSG) |
| Granule footprint | ~240 km x 240 km |
| Frequency bands | frequencyA only (current processing baseline) |
| Temporal | Pair of acquisitions (reference + secondary) |
| File size | 500 MB - 2 GB typical |

## 2. HDF5 Group Hierarchy

```
/
├── science/
│   └── LSAR/                              (or SSAR — never both)
│       ├── identification/                 Product ID metadata
│       │   ├── referenceAbsoluteOrbitNumber  UInt32 scalar
│       │   ├── secondaryAbsoluteOrbitNumber  UInt32 scalar
│       │   ├── trackNumber                  UInt32 scalar
│       │   ├── frameNumber                  UInt16 scalar
│       │   ├── referenceZeroDopplerStartTime string (UTC)
│       │   ├── secondaryZeroDopplerStartTime string (UTC)
│       │   ├── boundingPolygon              WKT string (EPSG:4326)
│       │   ├── lookDirection                "Left" or "Right"
│       │   ├── orbitPassDirection            "Ascending" or "Descending"
│       │   ├── isGeocoded                   "True"
│       │   └── ...
│       │
│       └── GUNW/
│           ├── grids/
│           │   └── frequencyA/
│           │       ├── centerFrequency                     Float64 scalar (Hz)
│           │       ├── listOfPolarizations                 string[]
│           │       │
│           │       ├── unwrappedInterferogram/             80 m posting
│           │       │   ├── mask                            UByte  (L x W)
│           │       │   └── [HH|VV]/
│           │       │       ├── projection                  UInt32 + EPSG attrs
│           │       │       ├── xCoordinates                Float64 (W,)
│           │       │       ├── yCoordinates                Float64 (L,)
│           │       │       ├── xCoordinateSpacing          Float64 = 80 m
│           │       │       ├── yCoordinateSpacing          Float64 = 80 m
│           │       │       ├── unwrappedPhase              Float32 (L x W)
│           │       │       ├── coherenceMagnitude           Float32 (L x W)
│           │       │       ├── connectedComponents          UInt16  (L x W)
│           │       │       ├── ionospherePhaseScreen        Float32 (L x W)
│           │       │       └── ionospherePhaseScreenUncertainty Float32 (L x W)
│           │       │
│           │       ├── wrappedInterferogram/               20 m posting
│           │       │   ├── mask                            UByte  (Lw x Ww)
│           │       │   └── [HH|VV]/
│           │       │       ├── projection + coords         (20 m posting)
│           │       │       ├── wrappedInterferogram        CFloat32 (Lw x Ww)
│           │       │       └── coherenceMagnitude           Float32  (Lw x Ww)
│           │       │
│           │       └── pixelOffsets/                        80 m posting
│           │           ├── mask                            UByte (Lo x Wo)
│           │           └── [HH|VV]/
│           │               ├── projection + coords         (80 m posting)
│           │               ├── slantRangeOffset             Float32 (Lo x Wo)
│           │               ├── alongTrackOffset              Float32 (Lo x Wo)
│           │               └── correlationSurfacePeak       Float32 (Lo x Wo)
│           │
│           └── metadata/
│               ├── processingInformation/
│               │   ├── parameters/
│               │   │   ├── common/frequencyA/...
│               │   │   ├── reference/frequencyA/...       (ref RSLC params)
│               │   │   ├── secondary/frequencyA/...       (sec RSLC params)
│               │   │   ├── wrappedInterferogram/frequencyA/...
│               │   │   ├── unwrappedInterferogram/frequencyA/...
│               │   │   ├── ionosphere/...
│               │   │   ├── pixelOffsets/frequencyA/...
│               │   │   └── geocoding/...                  (correction flags)
│               │   ├── algorithms/...
│               │   └── inputs/...
│               │
│               ├── orbit/
│               │   ├── temporalBaseline                   UInt16 (days)
│               │   ├── reference/ {time, position, velocity, orbitType}
│               │   └── secondary/ {time, position, velocity, orbitType}
│               │
│               ├── attitude/
│               │   ├── reference/ {time, quaternions, eulerAngles}
│               │   └── secondary/ {time, quaternions, eulerAngles}
│               │
│               └── radarGrid/                             3-D metadata cubes
│                   ├── xCoordinates, yCoordinates         Float64 1-D
│                   ├── heightAboveEllipsoid                Float64 1-D
│                   ├── projection                         UInt32 scalar
│                   ├── referenceSlantRange                 Float64 (H x L x W)
│                   ├── secondarySlantRange                 Float64 (H x L x W)
│                   ├── incidenceAngle                     Float32 (H x L x W)
│                   ├── losUnitVectorX/Y                   Float32 (H x L x W)
│                   ├── alongTrackUnitVectorX/Y             Float32 (H x L x W)
│                   ├── elevationAngle                     Float32 (H x L x W)
│                   ├── groundTrackVelocity                 Float64 (H x L x W)
│                   ├── parallelBaseline                   Float32 (W x L x 2)
│                   ├── perpendicularBaseline               Float32 (W x L x 2)
│                   ├── slantRangeSolidEarthTidesPhase      Float64 (H x L x W)
│                   ├── alongTrackSolidEarthTidesPhase      Float64 (H x L x W)
│                   ├── wetTroposphericPhaseScreen          Float64 (H x L x W)
│                   └── hydrostaticTroposphericPhaseScreen  Float64 (H x L x W)
```

## 3. Dataset Catalog

### 3.1 Unwrapped Interferogram Group (80 m posting)

Path: `/science/{band}/GUNW/grids/frequencyA/unwrappedInterferogram/{pol}/`

| Dataset | Type | Shape | Units | FillValue | Description |
|:--------|:-----|:------|:------|:----------|:------------|
| `unwrappedPhase` | Float32 | (L, W) | radians | NaN | Continuous displacement phase. LOS displacement = phase * wavelength / (4*pi). NISAR L-band wavelength ~ 0.2384 m. |
| `coherenceMagnitude` | Float32 | (L, W) | 1 | NaN | Normalized interferometric coherence [0, 1]. >0.5 = reliable phase. |
| `connectedComponents` | UInt16 | (L, W) | label | 65535 | Phase unwrapping connected component labels. Different components may have 2*pi ambiguities. 0 = invalid. |
| `ionospherePhaseScreen` | Float32 | (L, W) | radians | NaN | Estimated ionospheric phase from split-spectrum. NOT subtracted from unwrappedPhase by default. |
| `ionospherePhaseScreenUncertainty` | Float32 | (L, W) | radians | NaN | Uncertainty of ionosphere estimate. |

Shared mask at group level:

| Dataset | Type | Shape | Units | FillValue | Description |
|:--------|:-----|:------|:------|:----------|:------------|
| `mask` | UByte | (L, W) | 1 | 255 | 3-digit validity mask (see [NISAR_PRODUCTS.md](NISAR_PRODUCTS.md)) |

### 3.2 Wrapped Interferogram Group (20 m posting)

Path: `/science/{band}/GUNW/grids/frequencyA/wrappedInterferogram/{pol}/`

| Dataset | Type | Shape | Units | FillValue | Description |
|:--------|:-----|:------|:------|:----------|:------------|
| `wrappedInterferogram` | CFloat32 | (Lw, Ww) | 1 | NaN+NaN*j | Complex wrapped interferogram. Phase = atan2(imag, real). |
| `coherenceMagnitude` | Float32 | (Lw, Ww) | 1 | NaN | Coherence at 20 m posting. |
| `mask` | UByte | (Lw, Ww) | 1 | 255 | 3-digit mask (group level). |

### 3.3 Pixel Offsets Group (80 m posting)

Path: `/science/{band}/GUNW/grids/frequencyA/pixelOffsets/{pol}/`

| Dataset | Type | Shape | Units | FillValue | Description |
|:--------|:-----|:------|:------|:----------|:------------|
| `slantRangeOffset` | Float32 | (Lo, Wo) | meters | NaN | Sub-pixel range displacement from cross-correlation. |
| `alongTrackOffset` | Float32 | (Lo, Wo) | meters | NaN | Sub-pixel along-track displacement. |
| `correlationSurfacePeak` | Float32 | (Lo, Wo) | 1 | NaN | Normalized cross-correlation peak [0, 1]. |
| `mask` | UByte | (Lo, Wo) | 1 | 255 | 3-digit mask (group level). |

## 4. Georeferencing

### Projection

GUNW uses **projected coordinates in meters** (UTM or Polar Stereographic). See [NISAR_PRODUCTS.md](NISAR_PRODUCTS.md) for EPSG table.

### Coordinate arrays

Each dataset group has its own coordinate arrays and projection dataset:

| Dataset | Type | Shape | Description |
|:--------|:-----|:------|:------------|
| `xCoordinates` | Float64 | (width,) | Easting (m), increasing |
| `yCoordinates` | Float64 | (length,) | Northing (m), **decreasing** (North-up) |
| `xCoordinateSpacing` | Float64 | scalar | Posting in meters (80 or 20) |
| `yCoordinateSpacing` | Float64 | scalar | Posting in meters (negative = North-up) |
| `projection` | UInt32 | scalar | EPSG code with CRS attributes |

### Multi-resolution handling

A single GUNW file contains datasets at **two different postings**:

| Group | Posting | Typical Dimensions |
|:------|:--------|:-------------------|
| unwrappedInterferogram | 80 m | ~3000 x 3000 |
| wrappedInterferogram | 20 m | ~12000 x 12000 |
| pixelOffsets | 80 m | ~3000 x 3000 |

Each group has its own `xCoordinates`, `yCoordinates`, and `projection`. When switching layer groups, the tile grid and chunk index must be refreshed.

### Spatial organization

- Row-major (C-order): first index = line (northing), second = pixel (easting)
- North-up: yCoordinates decrease with row index
- Pixel-is-area convention
- All layers within a group share the same top-left corner coordinate

## 5. Rendering Guide

| Dataset | Transform | Colormap | Range | Notes |
|:--------|:----------|:---------|:------|:------|
| `unwrappedPhase` | Linear (no dB) | Diverging (`RdBu`, `coolwarm`) | Symmetric around 0 | Center on 0; can convert to LOS displacement (m) |
| `coherenceMagnitude` | Linear | Sequential (`viridis`, `grayscale`) | [0, 1] | |
| `connectedComponents` | Categorical | Discrete/hash-based | Integer labels | Per-label random color; 0 = transparent |
| `wrappedInterferogram` | `atan2(imag, real)` | Cyclic (`phase`, HSV wheel) | [-pi, pi] | Extract phase from complex |
| `ionospherePhaseScreen` | Linear | Diverging | Symmetric around 0 | |
| `slantRangeOffset` | Linear | Diverging | Symmetric around 0 | Units = meters |
| `alongTrackOffset` | Linear | Diverging | Symmetric around 0 | Units = meters |
| `correlationSurfacePeak` | Linear | Sequential | [0, 1] | Quality metric |
| `mask` | Categorical | Discrete | 0-155 | See mask encoding |

### Key difference from GCOV

GCOV data is backscatter power requiring dB conversion (`10 * log10(value)`). GUNW data is in physical units (radians, meters) — display with **linear** scaling and **diverging/cyclic** colormaps.

### Phase-to-displacement conversion

```
LOS_displacement_m = unwrappedPhase * wavelength / (4 * pi)
  where wavelength ~ 0.2384 m for NISAR L-band
  One fringe (2*pi radians) = wavelength/2 ~ 11.9 cm of LOS motion
```

### Vertical displacement from LOS

LOS displacement measures motion along the satellite line-of-sight. To estimate vertical ground motion (assuming purely vertical displacement), divide by the cosine of the local incidence angle:

```
d_vertical = d_LOS / cos(theta)
  where theta = local incidence angle from radarGrid metadata cube
```

SARdine implements this per-pixel correction using the incidence angle grid from `/science/{band}/GUNW/metadata/radarGrid/incidenceAngle`. The correction is applied in the GPU fragment shader, so toggling between LOS and vertical displacement is instantaneous.

**Important caveats:**
- This assumes **purely vertical motion**. Real-world displacement often has horizontal components (e.g., tectonic fault slip, glacier flow).
- The correction amplifies noise at steep incidence angles: cos(30°) = 0.87 gives 1.15× amplification, but cos(50°) = 0.64 gives 1.56× amplification.
- For proper 3D decomposition, combine ascending and descending pass observations using the full LOS unit vectors (`losUnitVectorX/Y`).
- The `verticalDisplacement` toggle in SARdine requires `LOS Displacement` mode to be active first.

| Incidence Angle | cos(θ) | Amplification Factor |
|:----------------|:-------|:---------------------|
| 25° | 0.906 | 1.10× |
| 30° | 0.866 | 1.15× |
| 35° | 0.819 | 1.22× |
| 40° | 0.766 | 1.31× |
| 45° | 0.707 | 1.41× |
| 50° | 0.643 | 1.56× |

## 6. h5chunk Adaptation

### What already works

h5chunk is product-agnostic at the HDF5 level. Since GUNW uses the same cloud-optimization as GCOV (paged metadata, 512x512 chunks, deflate), the core streaming engine needs **no modifications**:

- [x] Superblock parsing, B-tree traversal, chunk index construction
- [x] Float32 (unwrappedPhase, coherence, offsets)
- [x] Float64 (coordinate arrays, metadata cubes)
- [x] CFloat32 compound type (wrappedInterferogram)
- [x] Deflate + shuffle decompression

### Data types to verify with real GUNW files

| Type | Dataset | h5chunk Status |
|:-----|:--------|:---------------|
| UByte | mask | Likely works (same as GCOV mask) — needs testing |
| UInt16 | connectedComponents | Simpler than float — needs testing |

### Loader design (gunw-loader.js)

```javascript
// Path builder
function gunwPaths(band = 'LSAR') {
  const base = `/science/${band}/GUNW`;
  return {
    identification: `/science/${band}/identification`,
    freqA: `${base}/grids/frequencyA`,

    // Dataset paths
    unwrappedPhase: (pol) =>
      `${base}/grids/frequencyA/unwrappedInterferogram/${pol}/unwrappedPhase`,
    coherence: (pol) =>
      `${base}/grids/frequencyA/unwrappedInterferogram/${pol}/coherenceMagnitude`,
    connectedComponents: (pol) =>
      `${base}/grids/frequencyA/unwrappedInterferogram/${pol}/connectedComponents`,
    ionoPhaseScreen: (pol) =>
      `${base}/grids/frequencyA/unwrappedInterferogram/${pol}/ionospherePhaseScreen`,
    wrappedIfg: (pol) =>
      `${base}/grids/frequencyA/wrappedInterferogram/${pol}/wrappedInterferogram`,
    slantRangeOffset: (pol) =>
      `${base}/grids/frequencyA/pixelOffsets/${pol}/slantRangeOffset`,
    alongTrackOffset: (pol) =>
      `${base}/grids/frequencyA/pixelOffsets/${pol}/alongTrackOffset`,

    // Coordinate paths (per group)
    unwrappedCoords: (pol) => `${base}/grids/frequencyA/unwrappedInterferogram/${pol}`,
    wrappedCoords: (pol) => `${base}/grids/frequencyA/wrappedInterferogram/${pol}`,
    offsetCoords: (pol) => `${base}/grids/frequencyA/pixelOffsets/${pol}`,

    // Masks (group-level, shared across polarizations)
    unwrappedMask: `${base}/grids/frequencyA/unwrappedInterferogram/mask`,
    wrappedMask: `${base}/grids/frequencyA/wrappedInterferogram/mask`,
    offsetMask: `${base}/grids/frequencyA/pixelOffsets/mask`,

    radarGrid: `${base}/metadata/radarGrid`,
  };
}
```

### Dataset enumeration

GUNW enumerates **layer types per polarization**, not covariance terms:

```javascript
async function listGUNWDatasets(reader) {
  const band = await detectBand(reader);
  const paths = gunwPaths(band);
  const pols = await readStringArray(reader, `${paths.freqA}/listOfPolarizations`);

  const datasets = [];
  for (const pol of pols) {
    // Unwrapped group (80 m)
    for (const ds of ['unwrappedPhase', 'coherenceMagnitude', 'connectedComponents',
                       'ionospherePhaseScreen', 'ionospherePhaseScreenUncertainty']) {
      datasets.push({ group: 'unwrappedInterferogram', dataset: ds, pol, posting: 80 });
    }
    // Wrapped group (20 m)
    for (const ds of ['wrappedInterferogram', 'coherenceMagnitude']) {
      datasets.push({ group: 'wrappedInterferogram', dataset: ds, pol, posting: 20 });
    }
    // Pixel offsets (80 m)
    for (const ds of ['slantRangeOffset', 'alongTrackOffset', 'correlationSurfacePeak']) {
      datasets.push({ group: 'pixelOffsets', dataset: ds, pol, posting: 80 });
    }
  }
  return datasets;
}
```

### New shader modes needed

```glsl
// 1. Diverging (phase, displacement) — linear, centered on 0
float t = (val - u_min) / (u_max - u_min);
gl_FragColor = colormap_diverging(t);     // blue-white-red

// 2. Cyclic (wrapped phase) — atan2 of complex, wrap [-pi, pi]
float phase = atan(imag, real);
float t = (phase + PI) / (2.0 * PI);
gl_FragColor = colormap_cyclic(t);         // HSV phase wheel

// 3. Categorical (connected components) — integer label to color
gl_FragColor = hash_color(label);          // deterministic per-label
```

## 7. Implementation Roadmap

### Phase 1: Core loader (no viewer changes)

- [ ] Verify h5chunk UByte and UInt16 chunk decoding with real GUNW file
- [ ] Write `gunw-loader.js` (path builder, enumeration, coordinate extraction)
- [ ] Add `loadNISARGUNW()` returning `{ getTile, bounds, datasets }`
- [ ] Extend SardineAgent for `productType === 'L2_GUNW'` auto-detection
- [ ] MCP tools return GUNW layers with metadata

### Phase 2: Viewer support

- [ ] UTM-to-WGS84 reprojection for deck.gl overlay
- [ ] Linear rendering modes (no dB) for phase, coherence, displacement
- [ ] Diverging colormap (`RdBu`, `coolwarm`)
- [ ] Cyclic colormap (HSV phase wheel)
- [ ] Connected component categorical rendering
- [ ] Complex interferogram phase display

### Phase 3: InSAR-specific features

- [x] Phase-to-LOS-displacement conversion
- [x] LOS-to-vertical displacement correction (per-pixel cos(θ) via incidence angle texture)
- [ ] Temporal pair metadata display (reference/secondary dates, baseline)
- [ ] Coherence masking (threshold to mask low-quality phase)
- [ ] Ionosphere correction toggle
- [ ] Multi-granule time series (same track/frame, multiple dates)

## 8. Reference

- **Spec**: JPL D-102272 Rev E, "NASA SDS Product Specification L2 GUNW", Nov 8, 2024
- **ATBD**: JPL D-95677 Rev A, "NISAR NASA SDS Algorithm Theoretical Basis Document", Nov 12, 2023
- **InSAR simulation**: Eineder, M. (2003), IEEE TGRS, 41(6), 1415-1427
- **HDF5 spec**: https://docs.hdfgroup.org/hdf5/develop/_f_m_t3.html
