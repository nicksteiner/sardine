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
```

### Utility Functions

```javascript
import { autoContrastLimits, computeStats, getColormap } from 'sardine';

// Auto-calculate contrast limits (2nd-98th percentile)
const [min, max] = autoContrastLimits(data, useDecibels);

// Get colormap function
const viridis = getColormap('viridis');
const [r, g, b] = viridis(0.5);
```

## Project Structure

```
sardine/
├── package.json
├── README.md
├── vite.config.js
├── app/                      # Main SARdine application
│   ├── index.html
│   └── main.jsx
├── src/                      # Core library
│   ├── index.js
│   ├── loaders/
│   │   └── cog-loader.js
│   ├── layers/
│   │   ├── SARTileLayer.js
│   │   └── shaders.js
│   ├── viewers/
│   │   ├── SARViewer.jsx
│   │   ├── ComparisonViewer.jsx
│   │   └── MapViewer.jsx
│   └── utils/
│       ├── stats.js
│       └── colormap.js
└── examples/
    └── basic/
```

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