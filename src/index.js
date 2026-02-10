/**
 * SARdine - SAR Imagery Viewer Library
 * A SAR imagery viewer built on deck.gl and geotiff.js
 *
 * @module sardine
 */

// Loaders
export { loadCOG, loadMultipleCOGs, loadCOGFullImage } from './loaders/cog-loader.js';
export { loadNISARGCOV, listNISARDatasets, loadNISARGCOVFullImage, loadNISARRGBComposite } from './loaders/nisar-loader.js';

// Layers
export { SARTileLayer } from './layers/SARTileLayer.js';
export { SARBitmapLayer } from './layers/SARBitmapLayer.js';
export { SARTiledCOGLayer } from './layers/SARTiledCOGLayer.js';
export { SARGPUBitmapLayer } from './layers/SARGPUBitmapLayer.js';
export { SARGPULayer } from './layers/SARGPULayer.js';
export {
  sarVertexShader,
  sarFragmentShader,
  COLORMAP_IDS,
  getColormapId,
  STRETCH_MODE_IDS,
  getStretchModeId,
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
  computeChannelStats,
  sampleViewportStats,
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

export {
  SAR_COMPOSITES,
  autoSelectComposite,
  getAvailableComposites,
  getRequiredDatasets,
  computeRGBBands,
  createRGBTexture,
} from './utils/sar-composites.js';

export { writeRGBAGeoTIFF, writeRGBGeoTIFF, downloadBuffer } from './utils/geotiff-writer.js';

export { exportFigure, downloadBlob } from './utils/figure-export.js';

export { STRETCH_MODES, applyStretch } from './utils/stretch.js';

// Import for default export
import { loadCOG } from './loaders/cog-loader.js';
import { loadNISARGCOV, listNISARDatasets, loadNISARRGBComposite } from './loaders/nisar-loader.js';
import { SARTileLayer } from './layers/SARTileLayer.js';
import { SARTiledCOGLayer } from './layers/SARTiledCOGLayer.js';
import { SARViewer } from './viewers/SARViewer.jsx';
import { ComparisonViewer, SwipeComparisonViewer } from './viewers/ComparisonViewer.jsx';
import { MapViewer } from './viewers/MapViewer.jsx';

// Default export
export default {
  loadCOG,
  loadNISARGCOV,
  listNISARDatasets,
  loadNISARRGBComposite,
  SARTileLayer,
  SARTiledCOGLayer,
  SARViewer,
  ComparisonViewer,
  SwipeComparisonViewer,
  MapViewer,
};
