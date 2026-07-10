# Deep Links (W008, W016)

Paste a granule URL, see it in seconds. SARdine auto-loads a remote dataset from URL
query params on startup, and the **Share Link → Copy share link** button (sidebar)
serializes the current source + render state back into a URL. Parser/serializer live in
`src/utils/deep-link.js` (pure functions, unit-tested in `test/unit/deep-link.test.mjs`).

```
https://<sardine-host>/?url=https://host/scene.tif&colormap=viridis&contrastMin=-20&contrastMax=0
```

## Source params (one required for auto-load)

| Param | Meaning |
|:------|:--------|
| `url` | Generic remote source; type inferred from extension: `.h5/.he5/.hdf5/.hdf` → NISAR, `.tif/.tiff/.geotiff` → COG, `.ntf/.nitf` → NITF/SICD. Unknown extension falls back to NISAR HDF5 (same as the direct-URL input). |
| `cog` / `nisar` / `nitf` (or `sicd`) | Explicit source type; wins over `url`. |

## Render params (all optional, short or long form)

| Short | Long | Values |
|:------|:-----|:-------|
| `cmap` | `colormap` | `grayscale`, `viridis`, `inferno`, `plasma`, … |
| `min` | `contrastMin` | number (dB when decibels on) |
| `max` | `contrastMax` | number |
| `db` | `useDecibels` | `0`/`1` |
| `stretch` | `stretchMode` | `linear`, `sqrt`, `gamma`, `sigmoid` |
| `gamma` | — | number |
| `rev` | — | reverse colormap, `0`/`1` |
| `pol` | `polarization` | e.g. `HHHH`, `HVHV` (NISAR) |
| `freq` | `frequency` | `A` / `B` (NISAR) |
| `ml` | `multilook` | integer |
| `comp` | `compositeId` | e.g. `pauli`, `dual-pol-h` |
| `mode` | — | `single` / `rgb` display mode |
| `c` | — | view center `lon,lat` |
| `z` | — | view zoom |

Short keys win when both spellings are present. "Copy share link" emits short keys and
omits defaults to keep URLs paste-friendly; it uses `?url=` when the extension
round-trips to the loaded type, otherwise pins `?cog=`/`?nisar=`/`?nitf=`.

## Spatial subset params (W016)

| Param | Meaning |
|:------|:--------|
| `bbox` | `w,s,e,n` in WGS84 lon/lat. Fits the initial view to the region, applies it as the ROI (WKT input + profile panel), and — for remote NISAR — restricts overview chunk prefetch and background refinement to the chunks intersecting the region. |
| `wkt` | URL-encoded WKT (`POLYGON`, `BBOX(w,s,e,n)`, `MULTIPOLYGON`, …) in WGS84. Wins over `bbox` when both are present. The polygon is kept verbatim in the ROI/WKT input; fetch scoping uses its bounding box. |

```
https://<sardine-host>/?url=https://datapool.asf.alaska.edu/GCOV/NISAR_L2_GCOV_001.h5&bbox=-91.4,30.2,-91.0,30.6
https://<sardine-host>/?url=https://host/scene.tif&wkt=POLYGON%20((-91.4%2030.2%2C%20-91.0%2030.2%2C%20-91.0%2030.6%2C%20-91.4%2030.6%2C%20-91.4%2030.2))
```

- Malformed values are ignored with a console warning — the scene loads full-frame.
- A region that does not intersect the scene falls back to a full-scene load
  (status log warns).
- Explicit `c`/`z` in the same link win over the region view-fit; the ROI is
  still applied.
- Panning outside the region still works — tile fetches stay viewport-driven
  and load lazily; only the eager prefetch and background refinement are scoped.
- "Copy share link" emits `bbox=` (WGS84, 5 dp) whenever a rectangular ROI is
  active, reprojecting from projected file CRSs via proj4.
- COG sources need no fetch scoping (tile/overview reads are already
  viewport-driven); the region fit + ROI apply the same way.

## Behavior notes

- Params in the link override the loaders' post-load auto-derivation exactly once
  (auto-contrast, default pol/freq selection, view auto-fit) — after that first load,
  everything behaves as usual.
- Local `File` sources have no URL: the Copy button is shown disabled with a tooltip.
- Earthdata (DAAC) URLs still require the recipient's own EDL token — tokens never
  travel in links; the app prompts for one before loading.
