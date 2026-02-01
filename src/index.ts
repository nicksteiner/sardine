/**
 * SARdine - A lightweight SAR imagery viewer library
 * Built on deck.gl and geotiff.js
 * 
 * (SAR + sardine — small, lightweight, packed tight)
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
