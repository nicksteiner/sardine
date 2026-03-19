/**
 * WebGPU compute module — hybrid GPU compute alongside WebGL2 rendering.
 */

export { hasWebGPU, getDevice, destroyDevice, getDeviceLimits } from './webgpu-device.js';
export { computeHistogramGPU } from './histogram-compute.js';
export { computeChannelStatsAuto, canUseGPUStats } from './gpu-stats.js';
export { applySpeckleFilter, getFilterTypes, estimateENL } from './spatial-filter.js';
export { applyWebGLFilter, canUseWebGLFilter, FILTER_TYPE_IDS } from './webgl-spatial-filter.js';
export {
  runTimeSeriesPipeline,
  sbasInversion,
  estimateVelocity,
  computeTemporalCoherence,
  buildDesignMatrix,
  computePseudoInverse,
} from './insar-timeseries.js';
