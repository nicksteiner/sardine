# SARdine 🐟

**A lightweight SAR imagery viewer library built on deck.gl and geotiff.js**

> SAR + sardine — small, lightweight, packed tight

SARdine is a specialized library for visualizing SAR (Synthetic Aperture Radar) imagery in web applications. It combines the power of deck.gl for high-performance rendering with geotiff.js for efficient GeoTIFF handling, without the overhead of larger dependencies like Viv.

## Features

- 🚀 **Lightweight**: Minimal dependencies, focused on SAR imagery
- 🗺️ **deck.gl powered**: Leverage WebGL for smooth, high-performance rendering
- 📊 **GeoTIFF native**: Direct support for GeoTIFF files via geotiff.js
- 🎨 **Customizable**: Flexible color mapping and visualization options
- 🔍 **Interactive**: Built-in viewport controls and layer management
- 📦 **No Viv dependency**: Streamlined architecture for SAR-specific use cases

## Installation

```bash
npm install sardine
```

### Peer Dependencies

SARdine requires the following peer dependencies:

```bash
npm install @deck.gl/core @deck.gl/layers geotiff
```

## Quick Start

```typescript
import { SARdine } from 'sardine';

// Create a viewer
const viewer = new SARdine({
  container: 'map-container',
  initialViewState: {
    longitude: -122.4,
    latitude: 37.8,
    zoom: 10
  }
});

// Add a SAR image layer
await viewer.addLayer({
  id: 'sar-layer-1',
  data: 'path/to/sar-image.tif',
  opacity: 0.8
});
```

## API Reference

### SARdine

Main viewer class for rendering SAR imagery.

#### Constructor

```typescript
new SARdine(options: SARdineOptions)
```

**Options:**
- `container` (string | HTMLElement): Container element ID or HTMLElement
- `initialViewState` (ViewState, optional): Initial viewport state
- `controller` (boolean | object, optional): deck.gl controller options
- `style` (object, optional): Custom styling for the container

#### Methods

##### `addLayer(options: SARImageLayerOptions): Promise<void>`

Add a SAR image layer to the viewer.

```typescript
await viewer.addLayer({
  id: 'my-layer',
  data: 'image.tif', // URL or ArrayBuffer
  opacity: 1.0,
  colormap: {
    type: 'linear',
    min: 0,
    max: 255
  }
});
```

##### `removeLayer(id: string): void`

Remove a layer by ID.

```typescript
viewer.removeLayer('my-layer');
```

##### `updateLayer(id: string, props: Partial<SARImageLayerOptions>): void`

Update layer properties.

```typescript
viewer.updateLayer('my-layer', { opacity: 0.5 });
```

##### `getViewState(): ViewState`

Get current viewport state.

##### `setViewState(viewState: Partial<ViewState>): void`

Set viewport state.

```typescript
viewer.setViewState({
  longitude: -122.4,
  latitude: 37.8,
  zoom: 12
});
```

##### `fitBounds(bounds: [number, number, number, number]): void`

Fit the view to specified bounds.

```typescript
viewer.fitBounds([-123, 37, -122, 38]);
```

##### `getLayerIds(): string[]`

Get all layer IDs.

##### `clearLayers(): void`

Clear all layers from the viewer.

##### `destroy(): void`

Destroy the viewer and clean up resources.

### SARImageLayer

Custom deck.gl layer for rendering SAR imagery.

```typescript
import { SARImageLayer } from 'sardine';

const layer = new SARImageLayer({
  id: 'sar-layer',
  data: arrayBufferOrUrl,
  opacity: 0.8,
  colormap: {
    type: 'linear',
    colors: ['#000000', '#ffffff']
  }
});
```

### Utility Functions

#### `loadGeoTIFF(source: string | ArrayBuffer): Promise<GeoTIFF>`

Load a GeoTIFF from URL or ArrayBuffer.

#### `getGeoTIFFMetadata(tiff: GeoTIFF): Promise<GeoTIFFMetadata>`

Extract metadata from a GeoTIFF.

#### `readGeoTIFFData(tiff: GeoTIFF, options?): Promise<ImageData>`

Read raster data from a GeoTIFF.

#### `normalizeData(data: TypedArray, min?: number, max?: number): Uint8Array`

Normalize raster data to 0-255 range.

#### `applyColorMap(data: Uint8Array, colors?: string[]): Uint8ClampedArray`

Apply a colormap to normalized data.

## Examples

### Basic Usage

```typescript
import { SARdine } from 'sardine';

const viewer = new SARdine({
  container: 'map',
  initialViewState: {
    longitude: 0,
    latitude: 0,
    zoom: 2
  }
});

// Load a SAR image
await viewer.addLayer({
  id: 'sar-image',
  data: '/path/to/sar-image.tif'
});
```

### Custom Color Mapping

```typescript
await viewer.addLayer({
  id: 'sar-image',
  data: '/path/to/image.tif',
  colormap: {
    type: 'linear',
    min: 0,
    max: 100,
    colors: ['#000000', '#ff0000', '#ffff00', '#ffffff']
  }
});
```

### Multiple Layers

```typescript
// Add multiple SAR images
await viewer.addLayer({
  id: 'layer-1',
  data: 'image1.tif',
  opacity: 0.7
});

await viewer.addLayer({
  id: 'layer-2',
  data: 'image2.tif',
  opacity: 0.5
});

// Update layer opacity
viewer.updateLayer('layer-1', { opacity: 1.0 });
```

### Using with ArrayBuffer

```typescript
// Fetch and load from ArrayBuffer
const response = await fetch('/path/to/image.tif');
const arrayBuffer = await response.arrayBuffer();

await viewer.addLayer({
  id: 'sar-layer',
  data: arrayBuffer
});
```

## Development

```bash
# Install dependencies
npm install

# Build the library
npm run build

# Run tests
npm test

# Development mode with watch
npm run dev
```

## TypeScript Support

SARdine is written in TypeScript and includes full type definitions.

```typescript
import type { SARdineOptions, ViewState, SARImageLayerOptions } from 'sardine';
```

## Browser Support

SARdine requires a browser with WebGL support. It works with all modern browsers:
- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments

- Built on [deck.gl](https://deck.gl/) for rendering
- Uses [geotiff.js](https://geotiffjs.github.io/) for GeoTIFF parsing
- Designed specifically for SAR imagery visualization