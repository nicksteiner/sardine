# NISAR L2 GCOV Product Specification

> JPL D-102274 Rev E, November 8, 2024, Version 1.2.1
> Author: Gustavo H. X. Shiroma, NASA JPL
> See also: [NISAR_GUNW.md](NISAR_GUNW.md) for the companion interferometric product

## 1. Product Overview

**GCOV** (Geocoded Polarimetric Covariance, L2_GCOV) provides **terrain-corrected, geocoded polarimetric covariance matrices** derived from the L1 RSLC product. It is the primary backscatter product from NISAR.

### Processing chain

```
L0 Raw → L0B RRSD → L1 RSLC → L2 GCOV
```

GCOV is derived from RSLC by:
1. Computing the polarimetric covariance matrix from SLC scattering vectors
2. Applying area-based radiometric terrain correction (RTC), normalizing to gamma0
3. Geocoding onto a predefined UTM/polar stereographic grid with adaptive multilooking

### Science applications

- **Land cover classification** — Forest, agriculture, urban, water via backscatter signatures
- **Biomass estimation** — HV/VH cross-pol backscatter correlates with vegetation structure
- **Flood mapping** — Anomalous backscatter from inundated areas
- **Sea ice classification** — Polarimetric signatures distinguish ice types
- **Soil moisture** — HH/VV ratio sensitive to dielectric constant
- **Polarimetric decomposition** — Pauli, Freeman-Durden, H/A/alpha from full covariance

### Key properties

| Property | Value |
|:---------|:------|
| Product type | `L2_GCOV` |
| Format | HDF5 v5 (paged aggregation) |
| Projection | UTM or Polar Stereographic (per-frame EPSG) |
| Backscatter convention | gamma0 (linear power) |
| Granule footprint | ~240 km x 240 km |
| Frequency bands | L-band (LSAR), optionally S-band (SSAR) |
| Temporal | Single acquisition |
| File size | 500 MB - 4 GB typical |

## 2. HDF5 Group Hierarchy

```
/
├── science/
│   └── LSAR/                              (or SSAR — never both)
│       ├── identification/                 Product ID metadata
│       │   ├── absoluteOrbitNumber          UInt32 scalar
│       │   ├── trackNumber                  UInt32 scalar
│       │   ├── frameNumber                  UInt16 scalar
│       │   ├── listOfFrequencies            string[] — ["A"] or ["A","B"]
│       │   ├── zeroDopplerStartTime         string (UTC)
│       │   ├── zeroDopplerEndTime           string (UTC)
│       │   ├── boundingPolygon              WKT string (EPSG:4326)
│       │   ├── lookDirection                "Left" or "Right"
│       │   ├── orbitPassDirection            "Ascending" or "Descending"
│       │   ├── isGeocoded                   "True"
│       │   ├── isFullFrame                  "True" or "False"
│       │   └── ...                          (granuleId, productVersion, etc.)
│       │
│       └── GCOV/
│           ├── grids/
│           │   ├── frequencyA/              Primary frequency band
│           │   │   ├── listOfPolarizations   string[] — e.g. ["HH","HV"]
│           │   │   ├── listOfCovarianceTerms string[] — e.g. ["HHHH","HVHV","HHHV"]
│           │   │   ├── centerFrequency       Float64 scalar (Hz)
│           │   │   ├── projection            UInt32 scalar (EPSG code + attrs)
│           │   │   ├── xCoordinates          Float64 (width,)  — Easting (m)
│           │   │   ├── yCoordinates          Float64 (length,) — Northing (m)
│           │   │   ├── xCoordinateSpacing    Float64 scalar (m)
│           │   │   ├── yCoordinateSpacing    Float64 scalar (m)
│           │   │   │
│           │   │   │   Diagonal terms (Float32, shape: length x width)
│           │   │   ├── HHHH                  |HH|^2 backscatter
│           │   │   ├── HVHV                  |HV|^2 backscatter
│           │   │   ├── VHVH                  |VH|^2 backscatter
│           │   │   ├── VVVV                  |VV|^2 backscatter
│           │   │   ├── RHRH                  |RH|^2 (compact pol)
│           │   │   ├── RVRV                  |RV|^2 (compact pol)
│           │   │   │
│           │   │   │   Off-diagonal terms (CFloat32, shape: length x width)
│           │   │   ├── HHHV                  complex cross-term
│           │   │   ├── HHVH                  complex cross-term
│           │   │   ├── HHVV                  complex cross-term
│           │   │   ├── HVVH                  complex cross-term
│           │   │   ├── HVVV                  complex cross-term
│           │   │   ├── VHVV                  complex cross-term
│           │   │   ├── RHRV                  complex cross-term
│           │   │   │
│           │   │   │   Ancillary (same shape as imagery)
│           │   │   ├── numberOfLooks         Float32 — adaptive multilook count
│           │   │   ├── rtcGammaToSigmaFactor Float32 — gamma0-to-sigma0 ratio
│           │   │   └── mask                  UByte   — validity mask
│           │   │
│           │   └── frequencyB/              Secondary band (if dual-freq)
│           │       └── (same structure as frequencyA)
│           │
│           └── metadata/
│               ├── calibrationInformation/   Antenna patterns, NESZ, RFI
│               ├── processingInformation/    Algorithms, flags, parameters
│               │   └── parameters/
│               │       ├── isFullCovariance   "True" or "False"
│               │       ├── radiometricTerrainCorrectionApplied
│               │       └── polarimetricSymmetrizationApplied
│               ├── sourceData/              Input RSLC metadata
│               ├── orbit/                   Ephemeris (ECEF pos/vel)
│               ├── attitude/                Quaternions, Euler angles
│               └── radarGrid/              3-D metadata cubes
│                   ├── slantRange            Float64 (H, L, W)
│                   ├── zeroDopplerAzimuthTime Float64 (H, L, W)
│                   ├── incidenceAngle        Float32 (H, L, W)
│                   ├── losUnitVectorX        Float32 (H, L, W)
│                   ├── losUnitVectorY        Float32 (H, L, W)
│                   ├── elevationAngle        Float32 (H, L, W)
│                   ├── groundTrackVelocity   Float64 (L, W)
│                   ├── xCoordinates          Float64 (cubeWidth,)
│                   ├── yCoordinates          Float64 (cubeWidth,)
│                   ├── heightAboveEllipsoid   Float64 (cubeHeight,)
│                   └── projection            UInt32 scalar
```

## 3. Dataset Catalog

### 3.1 Diagonal Terms (Real-Valued Backscatter)

| Dataset | Type | Shape | Units | FillValue | Polarization Mode |
|:--------|:-----|:------|:------|:----------|:------------------|
| `HHHH` | Float32 | (L, W) | 1 (gamma0 linear) | NaN | Single/Dual/Quad |
| `HVHV` | Float32 | (L, W) | 1 | NaN | Dual/Quad |
| `VHVH` | Float32 | (L, W) | 1 | NaN | Quad only |
| `VVVV` | Float32 | (L, W) | 1 | NaN | Single/Dual/Quad |
| `RHRH` | Float32 | (L, W) | 1 | NaN | Compact pol |
| `RVRV` | Float32 | (L, W) | 1 | NaN | Compact pol |

To convert to dB: `dB = 10 * log10(value)`. Typical range: -30 dB to +10 dB.

### 3.2 Off-Diagonal Terms (Complex Covariance)

Present only when `isFullCovariance == "True"`. Stored as CFloat32 (compound: `{r: float32, i: float32}`).

| Dataset | Type | Shape | Units | FillValue | Description |
|:--------|:-----|:------|:------|:----------|:------------|
| `HHHV` | CFloat32 | (L, W) | 1 | NaN+NaN*j | Covariance HH x HV* |
| `HHVH` | CFloat32 | (L, W) | 1 | NaN+NaN*j | Covariance HH x VH* |
| `HHVV` | CFloat32 | (L, W) | 1 | NaN+NaN*j | Covariance HH x VV* |
| `HVVH` | CFloat32 | (L, W) | 1 | NaN+NaN*j | Covariance HV x VH* |
| `HVVV` | CFloat32 | (L, W) | 1 | NaN+NaN*j | Covariance HV x VV* |
| `VHVV` | CFloat32 | (L, W) | 1 | NaN+NaN*j | Covariance VH x VV* |
| `RHRV` | CFloat32 | (L, W) | 1 | NaN+NaN*j | Covariance RH x RV* |

Only upper-triangular terms stored (Hermitian matrix).

### 3.3 Ancillary Layers

| Dataset | Type | Shape | Units | FillValue | Description |
|:--------|:-----|:------|:------|:----------|:------------|
| `numberOfLooks` | Float32 | (L, W) | 1 | NaN | Adaptive multilook count per pixel |
| `rtcGammaToSigmaFactor` | Float32 | (L, W) | 1 | NaN | sigma0 = gamma0 * factor |
| `mask` | UByte | (L, W) | 1 | 255 | 3-digit validity mask (see Rendering Guide below) |

### 3.4 Polarimetric Covariance Matrix

For quad-pol with symmetrization, the scattering vector is `k3 = [s_HH, avg(s_HV, s_VH), s_VV]^T`. The full 3x3 covariance:

```
     [ HHHH    HHHV*   HHVV* ]
C3 = [ HHHV    HVHV    HVVV* ]
     [ HHVV    HVVV    VVVV  ]
```

- Diagonal = real Float32 (stored directly)
- Off-diagonal = complex CFloat32 (upper triangle only)
- sqrt(2) factor NOT applied during symmetrization
- Values in linear gamma0; multiply by `rtcGammaToSigmaFactor` for sigma0

## 4. Georeferencing

### Projection

GCOV uses **projected coordinates in meters** (UTM or Polar Stereographic). The per-frame EPSG code is stored in the `projection` dataset (see coordinate arrays below).

### Coordinate arrays

| Dataset | Type | Shape | Description |
|:--------|:-----|:------|:------------|
| `xCoordinates` | Float64 | (width,) | Easting (m), increasing |
| `yCoordinates` | Float64 | (length,) | Northing (m), **decreasing** (North-up) |
| `projection` | UInt32 | scalar | EPSG code with CRS attributes |

The `projection` dataset attributes include: `epsg_code`, `utm_zone_number`, `false_easting`, `false_northing`, `latitude_of_projection_origin`, `longitude_of_central_meridian`, `spatial_ref`.

### Pixel spacing

Depends on RSLC range bandwidth:

| RSLC Bandwidth | Posting (m) | Typical Dimensions |
|:---------------|:------------|:-------------------|
| 5 MHz | 80 x 80 | ~3000 x 3000 |
| 20 MHz | 20 x 20 | ~12000 x 12000 |
| 40 MHz | 10 x 10 | ~24000 x 24000 |
| 77 MHz | 20 x 20 | ~12000 x 12000 |

### Spatial organization

- Row-major (C-order): first index = line (northing), second = pixel (easting)
- North-up: yCoordinates decrease with row index
- Pixel-is-area convention
- Single resolution per file (all datasets share the same grid)

## 5. Rendering Guide

| Dataset | Transform | Colormap | Range | Notes |
|:--------|:----------|:---------|:------|:------|
| Diagonal (HHHH, etc.) | `10 * log10(val)` (dB) | Sequential: `viridis`, `inferno` | [-30, +10] dB | Mask val <= 0 as transparent |
| Off-diagonal magnitude | `10 * log10(sqrt(r^2 + i^2))` | Sequential | [-40, 0] dB | |
| Off-diagonal phase | `atan2(i, r)` | Cyclic: `phase` | [-pi, pi] | |
| numberOfLooks | Linear | Sequential | [0, max] | |
| rtcGammaToSigmaFactor | Linear | Sequential | [0, 2] | |
| mask | Categorical | Discrete | 0-255 | See mask encoding |

### NaN/Zero masking

GCOV uses NaN as FillValue for Float32, 255 for UByte mask. Additionally, power values of exactly 0 indicate zero illuminated area (shadow, layover exclusion, or no contributing samples):

```javascript
// Pixel is nodata if:
//   isNaN(value)       — FillValue
//   value === 0        — zero illuminated area (shadow, layover exclusion, no samples)
//   mask === 0         — invalid/partially focused
//   mask === 255       — outside acquisition bounds
```

### RGB composites

GCOV diagonal terms support polarimetric RGB composites:

| Preset | R | G | B | Use Case |
|:-------|:--|:--|:--|:---------|
| Dual-pol-H | HHHH | HVHV | HHHH/HVHV | Land cover (dual-H mode) |
| Dual-pol-V | VVVV | HVHV | VVVV/HVHV | Land cover (dual-V mode) |
| Pauli (power approximation, no phase) | HHHH-VVVV | HVHV | HHHH+VVVV | Scattering mechanism proxy — true Pauli needs Re(HHVV): R = (HHHH+VVVV-2*Re(HHVV))/2, B = (HHHH+VVVV+2*Re(HHVV))/2 |
| Quad-pol | HHHH | HVHV | VVVV | Full-pol land cover |

## 6. h5chunk Adaptation

### What works (already implemented)

- [x] Superblock v2/v3 parsing
- [x] Paged metadata (first ~8 MB)
- [x] B-tree v1 and v2 chunk indices
- [x] Deflate + Shuffle decompression
- [x] Float32 (diagonal terms)
- [x] Float64 (coordinate arrays)
- [x] CFloat32 compound type (off-diagonal terms)
- [x] UByte (mask)
- [x] 1-D coordinate array reading
- [x] Attribute reading (EPSG, FillValue, units)
- [x] Spec-compliant paths via `nisarPaths()`
- [x] dB conversion in rendering pipeline
- [x] NaN masking

### Loader design (nisar-loader.js)

```javascript
// Path builder
const paths = nisarPaths('LSAR', 'GCOV');
paths.dataset('A', 'HHHH')  → '/science/LSAR/GCOV/grids/frequencyA/HHHH'
paths.freqGrid('A')         → '/science/LSAR/GCOV/grids/frequencyA'

// Dataset enumeration
const datasets = await listNISARDatasets(file);
// → [{ frequency: 'A', polarization: 'HHHH', type: 'diagonal', dtype: 'float32' }, ...]

// Load for tiled access
const { getTile, bounds, shape } = await loadNISARGCOV(file, {
  frequency: 'frequencyA',
  polarization: 'HHHH'
});
```

### Data type mapping

| GCOV Type | HDF5 Type | h5chunk Output | Bytes/pixel |
|:----------|:----------|:---------------|:------------|
| Float32 (diagonal) | H5T_IEEE_F32LE | Float32Array | 4 |
| CFloat32 (off-diag) | H5T_COMPOUND{r:F32, i:F32} | Float32Array (interleaved) | 8 |
| Float64 (coords) | H5T_IEEE_F64LE | Float64Array | 8 |
| UByte (mask) | H5T_STD_U8LE | Uint8Array | 1 |
| UInt32 (projection) | H5T_STD_U32LE | Uint32Array | 4 |

### Performance

| Operation | Requests | Transfer |
|:----------|:---------|:---------|
| Open (metadata) | 1 | ~4-8 MB |
| Read coordinates | 1-2 | ~200 KB |
| One 512x512 tile | 1 | ~200-600 KB |
| Full scene (12000x12000) | ~576 | ~200 MB |
| Statistics (sampling) | 10-20 | ~5 MB |

### Potential future adaptations

- [ ] S-band (SSAR) testing with real data
- [ ] Frequency B (dual-freq mode)
- [ ] 3-D metadata cube reading
- [ ] Polar stereographic reprojection (EPSG 3031/3413)
- [ ] Sigma0 conversion via rtcGammaToSigmaFactor
- [ ] Compact polarization (RHRH/RVRV)


## 8. Reference

- **Spec**: JPL D-102274 Rev E, "NASA SDS Product Specification L2 GCOV", Nov 8, 2024
- **RTC algorithm**: Shiroma et al., "An Area-Based Projection Algorithm for SAR RTC and Geocoding", IEEE TGRS, vol. 60, 2022
- **HDF5 spec**: https://docs.hdfgroup.org/hdf5/develop/_f_m_t3.html
