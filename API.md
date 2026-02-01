# SARdine API Documentation

## Table of Contents

- [SARdine Class](#sardine-class)
- [SARImageLayer Class](#sarimagelayer-class)
- [Utility Functions](#utility-functions)
- [Type Definitions](#type-definitions)

## SARdine Class

Main viewer class for rendering SAR imagery.

### Constructor

```typescript
new SARdine(options: SARdineOptions)
```

Creates a new SARdine viewer instance.

**Parameters:**
- `options` - Configuration options for the viewer

**Example:**
```typescript
const viewer = new SARdine({
  container: 'map-container',
  initialViewState: {
    longitude: -122.4,
    latitude: 37.8,
    zoom: 10
  }
});
```

### Methods

#### addLayer

```typescript
async addLayer(options: SARImageLayerOptions): Promise<void>
```

Adds a SAR image layer to the viewer.

**Parameters:**
- `options.id` (string) - Unique identifier for the layer
- `options.data` (string | ArrayBuffer) - GeoTIFF data source (URL or ArrayBuffer)
- `options.opacity?` (number) - Layer opacity (0-1), default: 1.0
- `options.colormap?` (ColorMap) - Color mapping configuration
- `options.bounds?` ([number, number, number, number]) - Custom bounds [minX, minY, maxX, maxY]
- `options.visible?` (boolean) - Layer visibility, default: true

**Example:**
```typescript
await viewer.addLayer({
  id: 'sar-layer-1',
  data: 'path/to/image.tif',
  opacity: 0.8,
  colormap: {
    type: 'linear',
    min: 0,
    max: 255
  }
});
```

#### removeLayer

```typescript
removeLayer(id: string): void
```

Removes a layer by its ID.

**Example:**
```typescript
viewer.removeLayer('sar-layer-1');
```

#### updateLayer

```typescript
updateLayer(id: string, props: Partial<SARImageLayerOptions>): void
```

Updates properties of an existing layer.

**Example:**
```typescript
viewer.updateLayer('sar-layer-1', { opacity: 0.5 });
```

#### getViewState

```typescript
getViewState(): ViewState
```

Returns the current viewport state.

**Returns:** ViewState object with longitude, latitude, zoom, pitch, and bearing.

**Example:**
```typescript
const state = viewer.getViewState();
console.log(state.longitude, state.latitude);
```

#### setViewState

```typescript
setViewState(viewState: Partial<ViewState>): void
```

Sets the viewport state.

**Example:**
```typescript
viewer.setViewState({
  longitude: -122.4,
  latitude: 37.8,
  zoom: 12
});
```

#### fitBounds

```typescript
fitBounds(bounds: [number, number, number, number]): void
```

Fits the viewport to the specified bounds.

**Parameters:**
- `bounds` - Array of [minLongitude, minLatitude, maxLongitude, maxLatitude]

**Example:**
```typescript
viewer.fitBounds([-123, 37, -122, 38]);
```

#### getLayerIds

```typescript
getLayerIds(): string[]
```

Returns an array of all layer IDs.

**Example:**
```typescript
const layerIds = viewer.getLayerIds();
console.log('Active layers:', layerIds);
```

#### clearLayers

```typescript
clearLayers(): void
```

Removes all layers from the viewer.

**Example:**
```typescript
viewer.clearLayers();
```

#### destroy

```typescript
destroy(): void
```

Destroys the viewer and cleans up resources.

**Example:**
```typescript
viewer.destroy();
```

## SARImageLayer Class

Custom deck.gl layer for rendering SAR imagery from GeoTIFF files.

### Properties

```typescript
interface SARImageLayerProps {
  id: string;
  data: ArrayBuffer | string;
  colormap?: ColorMap;
  bounds?: [number, number, number, number];
  opacity?: number;
  visible?: boolean;
}
```

### Usage

```typescript
import { SARImageLayer } from 'sardine';

const layer = new SARImageLayer({
  id: 'my-sar-layer',
  data: arrayBufferOrUrl,
  opacity: 0.8
});
```

## Utility Functions

### loadGeoTIFF

```typescript
async function loadGeoTIFF(source: string | ArrayBuffer): Promise<GeoTIFF>
```

Loads a GeoTIFF from a URL or ArrayBuffer.

**Example:**
```typescript
import { loadGeoTIFF } from 'sardine';

const tiff = await loadGeoTIFF('image.tif');
```

### getGeoTIFFMetadata

```typescript
async function getGeoTIFFMetadata(tiff: GeoTIFF): Promise<GeoTIFFMetadata>
```

Extracts metadata from a GeoTIFF image.

**Example:**
```typescript
import { loadGeoTIFF, getGeoTIFFMetadata } from 'sardine';

const tiff = await loadGeoTIFF('image.tif');
const metadata = await getGeoTIFFMetadata(tiff);
console.log(metadata.width, metadata.height);
```

### readGeoTIFFData

```typescript
async function readGeoTIFFData(
  tiff: GeoTIFF,
  options?: {
    window?: [number, number, number, number];
    samples?: number[];
  }
): Promise<ImageData>
```

Reads raster data from a GeoTIFF image.

**Example:**
```typescript
import { loadGeoTIFF, readGeoTIFFData } from 'sardine';

const tiff = await loadGeoTIFF('image.tif');
const imageData = await readGeoTIFFData(tiff);
```

### normalizeData

```typescript
function normalizeData(
  data: TypedArray,
  min?: number,
  max?: number
): Uint8Array
```

Normalizes raster data to 0-255 range for visualization.

**Example:**
```typescript
import { normalizeData } from 'sardine';

const normalized = normalizeData(floatData, 0, 1000);
```

### applyColorMap

```typescript
function applyColorMap(data: Uint8Array): Uint8ClampedArray
```

Applies a grayscale colormap to normalized data.

**Example:**
```typescript
import { applyColorMap } from 'sardine';

const rgbaData = applyColorMap(normalizedData);
```

## Type Definitions

### SARdineOptions

```typescript
interface SARdineOptions {
  container: string | HTMLElement;
  initialViewState?: ViewState;
  controller?: boolean | object;
  style?: {
    width?: string;
    height?: string;
  };
}
```

### ViewState

```typescript
interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
}
```

### GeoTIFFMetadata

```typescript
interface GeoTIFFMetadata {
  width: number;
  height: number;
  bounds: [number, number, number, number];
  origin: [number, number];
  resolution: [number, number];
  noDataValue?: number;
  description?: string;
}
```

### SARImageLayerOptions

```typescript
interface SARImageLayerOptions {
  id: string;
  data: ArrayBuffer | string;
  opacity?: number;
  colormap?: ColorMap;
  bounds?: [number, number, number, number];
  visible?: boolean;
}
```

### ColorMap

```typescript
interface ColorMap {
  type: 'linear' | 'log' | 'custom';
  min?: number;
  max?: number;
  colors?: string[];
  mapFunction?: (value: number) => [number, number, number, number];
}
```

### ImageData

```typescript
interface ImageData {
  data: TypedArray;
  width: number;
  height: number;
  bounds: [number, number, number, number];
}
```

### TypedArray

```typescript
type TypedArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;
```
