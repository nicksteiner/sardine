/**
 * SARdine - SAR Data INspection and Exploration
 * Browser-native SAR viewer built on deck.gl, geotiff.js, and h5chunk
 *
 * @module sardine
 */

// Loaders
export {
  loadCOG,
  loadLocalTIF,
  loadLocalTIFs,
  loadMultipleCOGs,
  loadCOGFullImage,
  loadMultiBandCOG,
  loadTemporalCOGs
} from './loaders/cog-loader.js';
export { loadNISARGCOV, listNISARDatasets, loadNISARGCOVFullImage, loadNISARRGBComposite, loadNISARGCOVFromUrl, listNISARDatasetsFromUrl, wktToROI, loadNISARTimeSeriesROI } from './loaders/nisar-loader.js';
export { listNISARGUNWDatasets, loadNISARGUNW, GUNW_LAYER_LABELS, GUNW_DATASET_LABELS } from './loaders/nisar-gunw-loader.js';
export { detectNISARProduct, openNISARReader, getRenderMode, RENDER_MODES } from './loaders/nisar-product.js';

// WKT / ROI utilities
export { parseWKT, wktToBbox, bboxToWKT, validateWKT, wktToGeoJSON } from './utils/wkt.js';
export { bboxToPixelRange, reprojectBbox, computeSubsetBounds, roiIntersectsFile } from './utils/roi-subset.js';

// S3 URL utilities
export { normalizeS3Url, isS3Url } from './utils/s3-url.js';

// Persistent chunk cache
export { clearChunkCache } from './utils/chunk-cache.js';

// Layers
export { SARTileLayer } from './layers/SARTileLayer.js';
export { SARBitmapLayer } from './layers/SARBitmapLayer.js';
export { SARTiledCOGLayer } from './layers/SARTiledCOGLayer.js';
export { SARGPUBitmapLayer } from './layers/SARGPUBitmapLayer.js';
export { SARGPULayer } from './layers/SARGPULayer.js';
export {
  sarVertexShader,
  sarFragmentShader,
  glslColormaps,
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
  twilight,
  sardine,
  flood,
  diverging,
  polarimetric,
  label,
  rdbu,
  romaO,
  getColormap,
  generateColorbar,
  createColorbarCanvas,
  buildColormapLUT,
  applyColormap,
} from './utils/colormap.js';

export {
  SAR_COMPOSITES,
  autoSelectComposite,
  getAvailableComposites,
  getRequiredDatasets,
  getRequiredComplexDatasets,
  computeRGBBands,
  createRGBTexture,
  COLORBLIND_MATRICES,
} from './utils/sar-composites.js';

export { writeRGBAGeoTIFF, writeRGBGeoTIFF, writeFloat32GeoTIFF, downloadBuffer } from './utils/geotiff-writer.js';

export { exportFigure, downloadBlob } from './utils/figure-export.js';

export { STRETCH_MODES, applyStretch, createStretchFn } from './utils/stretch.js';

export {
  adaptiveLogScale,
  percentileGammaStretch,
  localContrastEnhance,
  analyzeScene,
  smartToneMap,
  applyColorRamp,
  COLOR_RAMPS,
} from './utils/tone-mapping.js';

// WebGPU compute
export {
  hasWebGPU,
  getDevice,
  destroyDevice,
  getDeviceLimits,
  computeHistogramGPU,
  computeChannelStatsAuto,
  canUseGPUStats,
  applySpeckleFilter,
  getFilterTypes,
  estimateENL,
  applyWebGLFilter,
  canUseWebGLFilter,
  FILTER_TYPE_IDS,
} from './gpu/index.js';

// Overture Maps integration
export {
  fetchAllOvertureThemes,
  fetchOvertureTile,
  fetchWorldCoastlines,
  fetchSceneContext,
  clearOvertureCache,
  getOvertureUrl,
  OVERTURE_THEMES,
} from './loaders/overture-loader.js';

export { createOvertureLayers } from './layers/OvertureLayer.js';

// Metadata Cube
export { MetadataCube, loadMetadataCube } from './utils/metadata-cube.js';

// Phase Corrections
export { loadAllCorrections, fitPlanarRamp, buildCombinedCorrection, CORRECTION_TYPES } from './utils/phase-corrections.js';

// S3 Pre-signed URL generation
export {
  presignS3Url,
  presignMultiple,
  presignGeoJSON,
  parseS3Uri,
} from './utils/s3-presign.js';

// Lite report graphics (no heavy deps)
export {
  drawDbBarChart,
  drawChangeDetectionPlot,
  drawFootprintMap,
  drawRegionEstimates,
  drawTimelinePlot,
  drawHorizontalBars,
  renderReportDashboard,
  REPORT_COLORS,
} from './lite/index.js';

// Components
export { MetadataPanel } from './components/MetadataPanel.jsx';
export { OverviewMap } from './components/OverviewMap.jsx';
export { StatusWindow } from './components/StatusWindow.jsx';
export { SceneCatalog } from './components/SceneCatalog.jsx';
export { STACSearch } from './components/STACSearch.jsx';

// STAC Catalog
export {
  STAC_ENDPOINTS,
  fetchCatalog,
  listCollections,
  getCollection,
  searchItems,
  resolveAsset,
  listAssets,
  itemToScene,
  extractItemFilters,
  formatDatetime,
  itemBbox,
} from './loaders/stac-client.js';

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
