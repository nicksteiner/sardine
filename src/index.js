/**
 * SAR Viewer Library
 * A SAR imagery viewer built on deck.gl and geotiff.js
 *
 * @module sar-viewer
 */

// Loaders
export { loadCOG, loadMultipleCOGs } from './loaders/cog-loader.js';

// Layers
export { SARTileLayer } from './layers/SARTileLayer.js';
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

// Default export
export default {
  loadCOG,
  SARTileLayer,
  SARViewer,
  ComparisonViewer,
  SwipeComparisonViewer,
  MapViewer,
};
