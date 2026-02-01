# 🐟 SARdine

A prompt-driven SAR (Synthetic Aperture Radar) imagery analysis tool built on deck.gl and geotiff.js. Designed for visualizing Cloud Optimized GeoTIFFs (COGs) with support for decibel scaling, multiple colormaps, and interactive state management.

## Development Phases

SARdine is being developed in phases, each fully functional before moving to the next:

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Basic Viewer | ✅ Complete |
| 2 | State as Markdown | ✅ Complete |
| 3 | Chat Input | 🔜 Planned |
| 4 | Basemap + Annotations | 🔜 Planned |
| 5 | Processing Backend | 🔜 Planned |
| 6 | Comparison Mode | 🔜 Planned |
| 7 | History + Rollback | 🔜 Planned |

## Features

### Phase 1: Basic Viewer
- **COG Support**: Load Cloud Optimized GeoTIFFs directly from URLs using geotiff.js
- **Decibel Scaling**: Toggle dB conversion for SAR amplitude data
- **Contrast Sliders**: Adjust min/max contrast limits in dB
- **Colormaps**: Grayscale and Viridis (plus Inferno, Plasma, Phase)
- **Auto-fit View**: Automatically fit view to image bounds

### Phase 2: State as Markdown
- **Live State Panel**: See current state as human-readable markdown
- **Bidirectional Sync**: Edit markdown to update viewer, or interact to update markdown
- **State Format**:
```markdown
## State
- **File:** s3://bucket/flood.tif
- **Contrast:** -22 to -3 dB
- **Colormap:** grayscale
- **dB Mode:** on
- **View:** [lat, lon], zoom 12
```

## Quick Start

```bash
# Install dependencies
npm install

# Start the SARdine app
npm run dev
```

Then open http://localhost:5173 in your browser.

## Usage

### Loading a COG

1. Enter a Cloud Optimized GeoTIFF URL in the "COG URL" field
2. Click "Load COG"
3. The image will automatically fit to view with auto-calculated contrast limits

### Adjusting Display

- **Colormap**: Choose from Grayscale, Viridis, Inferno, Plasma, or Phase
- **dB Scaling**: Toggle on/off for SAR amplitude data
- **Contrast Min/Max**: Use sliders to adjust contrast limits

### Editing State via Markdown

1. View the current state in the right panel
2. Edit any value in the markdown (e.g., change contrast values)
3. Click "Apply Changes" to update the viewer

## API Reference

### `loadCOG(url)`

Load a Cloud Optimized GeoTIFF and return a tile fetcher.

```javascript
import { loadCOG } from 'sardine';

const { getTile, bounds, crs, width, height } = await loadCOG(url);
```

### `SARViewer`

Basic SAR image viewer component.

```jsx
import { SARViewer } from 'sardine';

<SARViewer
  getTile={getTile}
  bounds={bounds}
  contrastLimits={[-25, 0]}
  useDecibels={true}
  colormap="grayscale"
  onViewStateChange={handleViewChange}
/>
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
