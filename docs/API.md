# SARdine API

SARdine is a plain-JavaScript ES-module library. The public API is the set of named
exports in [`src/index.js`](../src/index.js) — that file is the authoritative list.
There is no `SARdine` viewer class; you compose loaders, deck.gl layers, and React
viewer components directly. This page covers the key entry points.

## Loaders

### NISAR HDF5 (GCOV)

```javascript
import { listNISARDatasets, loadNISARGCOV } from 'sardine';

const datasets = await listNISARDatasets(file);
// → [{frequency: 'frequencyA', polarization: 'HHHH', shape: [16704, 16272], ...}]

const { getTile, bounds, getExportStripe } = await loadNISARGCOV(file, {
  frequency: 'frequencyA',
  polarization: 'HHHH',
  multilook: 4,
});
```

Related exports: `loadNISARGCOVFullImage`, `loadNISARRGBComposite`,
`loadNISARGCOVFromUrl`, `listNISARDatasetsFromUrl`, `loadNISARTimeSeriesROI`,
GUNW support (`listNISARGUNWDatasets`, `loadNISARGUNW`), and product detection
(`detectNISARProduct`, `openNISARReader`).

### Cloud Optimized GeoTIFF

```javascript
import { loadCOG } from 'sardine';

const { getTile, bounds } = await loadCOG(url);
```

Related exports: `loadLocalTIF`, `loadLocalTIFs`, `loadMultipleCOGs`,
`loadCOGFullImage`, `loadMultiBandCOG`, `loadTemporalCOGs`.

### NITF / remote files

`loadNITF`, `listNITFDatasets`, `loadNITFDataset`, plus URL-streaming variants
(`loadNITFFromUrl`, `listNITFDatasetsFromUrl`, `loadNITFDatasetFromUrl`) and the
`URLFile` HTTP Range adapter.

## Layers (deck.gl)

- `SARGPULayer` — primary GPU-accelerated layer (WebGL2 R32F textures, GLSL dB/colormap/stretch)
- `SARBitmapLayer` — CPU-fallback bitmap layer
- `SARTiledCOGLayer`, `SARTileLayer` — tiled variants
- Shader building blocks: `sarVertexShader`, `sarFragmentShader`, `glslColormaps`,
  `COLORMAP_IDS`, `getColormapId`, `STRETCH_MODE_IDS`, `getStretchModeId`

## Viewers (React)

- `SARViewer` — orthographic viewer (no basemap)
- `MapViewer` — MapLibre basemap + SAR overlay
- `ComparisonViewer`, `SwipeComparisonViewer` — side-by-side / swipe comparison

## RGB Composites

```javascript
import { computeRGBBands, createRGBTexture } from 'sardine';

const rgb = computeRGBBands(bandData, 'dual-pol-h', tileSize);
// rgb = {R: Float32Array, G: Float32Array, B: Float32Array}

const imageData = createRGBTexture(rgb, width, height,
  contrastLimits, useDecibels, gamma, stretchMode);
```

Presets live in `SAR_COMPOSITES`; see also `autoSelectComposite`,
`getAvailableComposites`, `getRequiredDatasets`.

## Export

```javascript
import { writeRGBAGeoTIFF, writeFloat32GeoTIFF, downloadBuffer } from 'sardine';

const buffer = await writeRGBAGeoTIFF(rgbaData, width, height, bounds, epsgCode);
downloadBuffer(buffer, 'export.tif');
```

- `writeRGBAGeoTIFF(rgbaData, width, height, bounds, epsgCode, options)` — rendered
  RGBA Cloud Optimized GeoTIFF (tiled, DEFLATE, overviews)
- `writeFloat32GeoTIFF(...)` — raw Float32 GeoTIFF with CRS + tiepoints
- `exportFigure`, `downloadBlob` — annotated PNG figure export

## Utilities

- Stats: `computeStats`, `autoContrastLimits`, `computeHistogram`, `sampleViewportStats`
- Colormaps: `getColormap`, `COLORMAP_NAMES`, `applyColormap`, `generateColorbar`
- Stretch: `STRETCH_MODES`, `applyStretch`, `createStretchFn`
- WKT/ROI: `parseWKT`, `wktToBbox`, `bboxToPixelRange`, `reprojectBbox`
- GPU compute: `hasWebGPU`, `computeHistogramGPU`, `applySpeckleFilter`
- Overture Maps: `fetchAllOvertureThemes`, `createOvertureLayers`
- STAC: `fetchCatalog`, `searchItems`, `resolveAsset`

For the full list, read `src/index.js`. Architecture and pipeline details are in
[`CLAUDE.md`](../CLAUDE.md) and [`CLOUD_OPTIMIZED_HDF5.md`](CLOUD_OPTIMIZED_HDF5.md).
