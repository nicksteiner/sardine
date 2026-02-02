/**
 * SARdine - SAR Imagery Viewer Library
 * A SAR imagery viewer built on deck.gl and geotiff.js
 *
 * @module sardine
 */

// Loaders
export { loadCOG, loadMultipleCOGs, loadCOGFullImage } from './loaders/cog-loader.js';

// Layers
export { SARTileLayer } from './layers/SARTileLayer.js';
export { SARBitmapLayer } from './layers/SARBitmapLayer.js';
export { SARTiledCOGLayer } from './layers/SARTiledCOGLayer.js';
export {
  sarVertexShader,
  sarFragmentShader,
  COLORMAP_IDS,
  getColormapId,
} from './layers/shaders.js';

// Viewers
export { SARViewer } from './viewers/SARViewer.jsx';
export {
  ComparisonViewer,
  SwipeComparisonViewer,
} from './viewers/ComparisonViewer.jsx';
export { MapViewer } from './viewers/MapViewer.jsx';

// Utilities
export {
  computeStats,
  autoContrastLimits,
  computeHistogram,
  sampleTileStats,
} from './utils/stats.js';

export {
  COLORMAP_NAMES,
  grayscale,
  viridis,
  inferno,
  plasma,
  phase,
  getColormap,
  generateColorbar,
  createColorbarCanvas,
  applyColormap,
} from './utils/colormap.js';

// Import for default export
import { loadCOG } from './loaders/cog-loader.js';
import { SARTileLayer } from './layers/SARTileLayer.js';
import { SARTiledCOGLayer } from './layers/SARTiledCOGLayer.js';
import { SARViewer } from './viewers/SARViewer.jsx';
import { ComparisonViewer, SwipeComparisonViewer } from './viewers/ComparisonViewer.jsx';
import { MapViewer } from './viewers/MapViewer.jsx';

// Default export
export default {
  loadCOG,
  SARTileLayer,
  SARTiledCOGLayer,
  SARViewer,
  ComparisonViewer,
  SwipeComparisonViewer,
  MapViewer,
};
