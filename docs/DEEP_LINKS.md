# Deep Links (W008)

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

## Behavior notes

- Params in the link override the loaders' post-load auto-derivation exactly once
  (auto-contrast, default pol/freq selection, view auto-fit) — after that first load,
  everything behaves as usual.
- Local `File` sources have no URL: the Copy button is shown disabled with a tooltip.
- Earthdata (DAAC) URLs still require the recipient's own EDL token — tokens never
  travel in links; the app prompts for one before loading.
