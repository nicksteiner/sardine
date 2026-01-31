# SAR Viewer (Sardine)

A SAR (Synthetic Aperture Radar) imagery viewer library built on deck.gl and geotiff.js. Designed for visualizing Cloud Optimized GeoTIFFs (COGs) with support for decibel scaling, multiple colormaps, and geographic overlays.

## Features

- **COG Support**: Load Cloud Optimized GeoTIFFs directly from URLs using geotiff.js
- **Decibel Scaling**: Automatic dB conversion for SAR amplitude data
- **Multiple Colormaps**: Grayscale, Viridis, Inferno, Plasma, and Phase (cyclic)
- **Three Viewer Types**:
  - `SARViewer`: Basic orthographic viewer
  - `ComparisonViewer`: Side-by-side comparison with linked pan/zoom
  - `MapViewer`: SAR overlay on MapLibre basemap
- **Auto Contrast**: Percentile-based automatic contrast limit calculation
- **React Components**: Ready-to-use React components with deck.gl

## Installation

```bash
npm install sar-viewer
```

## Quick Start

```jsx
import { SARViewer, loadCOG } from 'sar-viewer';

// Load a Cloud Optimized GeoTIFF
const { getTile, bounds } = await loadCOG('https://bucket.s3.amazonaws.com/flood.tif');

// Render the viewer
<SARViewer
  getTile={getTile}
  bounds={bounds}
  contrastLimits={[-25, 0]}
  useDecibels={true}
  colormap="viridis"
/>
```

## API Reference

### `loadCOG(url)`

Load a Cloud Optimized GeoTIFF and return a tile fetcher.

```javascript
const { getTile, bounds, crs, width, height } = await loadCOG(url);
```

**Returns:**
- `getTile({x, y, z})` - Function to fetch tile data
- `bounds` - `[minX, minY, maxX, maxY]` bounding box
- `crs` - Coordinate reference system (e.g., "EPSG:4326")
- `width`, `height` - Image dimensions

### `SARViewer`

Basic SAR image viewer component.

```jsx
<SARViewer
  getTile={getTile}           // Required: Tile fetcher function
  bounds={bounds}             // Required: [minX, minY, maxX, maxY]
  contrastLimits={[-25, 0]}   // [min, max] for scaling
  useDecibels={true}          // Apply dB conversion
  colormap="grayscale"        // Colormap name
  opacity={1}                 // Layer opacity (0-1)
  width="100%"                // Container width
  height="100%"               // Container height
  onViewStateChange={fn}      // View state change callback
/>
```

### `ComparisonViewer`

Side-by-side comparison viewer with synchronized navigation.

```jsx
<ComparisonViewer
  leftImage={{
    getTile,
    bounds,
    contrastLimits: [-25, 0],
    colormap: 'viridis'
  }}
  rightImage={{
    getTile: getTile2,
    bounds: bounds2,
    contrastLimits: [-25, 0],
    colormap: 'grayscale'
  }}
  syncViews={true}            // Link pan/zoom between views
  showLabels={true}           // Show panel labels
  leftLabel="Before"
  rightLabel="After"
/>
```

### `MapViewer`

SAR overlay on MapLibre basemap for geographic context.

```jsx
<MapViewer
  getTile={getTile}
  bounds={bounds}
  contrastLimits={[-25, 0]}
  useDecibels={true}
  colormap="viridis"
  opacity={0.8}
  mapStyle="https://demotiles.maplibre.org/style.json"
  showControls={true}
/>
```

### `SARTileLayer`

Low-level deck.gl layer for custom integrations.

```javascript
import { SARTileLayer } from 'sar-viewer';

const layer = new SARTileLayer({
  id: 'sar-layer',
  getTile,
  bounds,
  contrastLimits: [-25, 0],
  useDecibels: true,
  colormap: 'viridis',
  opacity: 1
});
```

### Utility Functions

#### Statistics

```javascript
import { computeStats, autoContrastLimits, computeHistogram } from 'sar-viewer';

// Compute statistics from raw data
const stats = computeStats(data, useDecibels);
// { min, max, mean, std, median, count }

// Auto-calculate contrast limits (2nd-98th percentile)
const [min, max] = autoContrastLimits(data, useDecibels);

// Compute histogram
const { bins, edges } = computeHistogram(data, useDecibels, 256);
```

#### Colormaps

```javascript
import { getColormap, generateColorbar, COLORMAP_NAMES } from 'sar-viewer';

// Get colormap function
const viridis = getColormap('viridis');
const [r, g, b] = viridis(0.5); // Returns RGB 0-255

// Generate colorbar array
const colors = generateColorbar('viridis', 256);

// Available colormaps
console.log(COLORMAP_NAMES); // ['grayscale', 'viridis', 'inferno', 'plasma', 'phase']
```

## Available Colormaps

| Name | Description |
|------|-------------|
| `grayscale` | Linear black-to-white gradient |
| `viridis` | Perceptually uniform, colorblind-friendly |
| `inferno` | High contrast, perceptually uniform |
| `plasma` | Perceptually uniform warm tones |
| `phase` | Cyclic colormap for interferometric phase |

## Project Structure

```
sar-viewer/
├── package.json
├── README.md
├── src/
│   ├── index.js              # Main exports
│   ├── loaders/
│   │   └── cog-loader.js     # Load COGs via geotiff.js
│   ├── layers/
│   │   ├── SARTileLayer.js   # deck.gl TileLayer with dB shader
│   │   └── shaders.js        # GLSL for dB scaling, colormaps
│   ├── viewers/
│   │   ├── SARViewer.jsx     # Basic viewer (React + deck.gl)
│   │   ├── ComparisonViewer.jsx  # Side-by-side comparison
│   │   └── MapViewer.jsx     # SAR overlay on MapLibre
│   └── utils/
│       ├── stats.js          # Auto contrast limits, histogram
│       └── colormap.js       # Colormap functions
└── examples/
    └── basic/
        ├── index.html
        └── main.jsx
```

## Running the Example

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Then open http://localhost:5173 in your browser.

## Dependencies

- `@deck.gl/core` ^8.9.0
- `@deck.gl/geo-layers` ^8.9.0
- `@deck.gl/layers` ^8.9.0
- `@deck.gl/react` ^8.9.0
- `@luma.gl/core` ^8.5.21
- `geotiff` ^2.1.0
- `maplibre-gl` ^4.0.0
- `react` ^18.2.0
- `react-dom` ^18.2.0

## License

MIT