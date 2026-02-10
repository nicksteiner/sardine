/**
 * SARdine - SAR Data INspection and Exploration
 * Browser-native SAR viewer built on deck.gl, geotiff.js, and h5chunk
 */

export { SARdine } from './SARdine';
export { SARImageLayer } from './layers/SARImageLayer';

export type {
  SARdineOptions,
  ViewState,
  GeoTIFFMetadata,
  SARImageLayerOptions,
  ColorMap,
  ImageData,
  TypedArray,
} from './types';

export {
  loadGeoTIFF,
  getGeoTIFFMetadata,
  readGeoTIFFData,
  normalizeData,
  applyColorMap,
} from './utils/geotiff';
