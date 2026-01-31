/**
 * Configuration options for SARdine viewer
 */
export interface SARdineOptions {
  /** Container element ID or HTMLElement */
  container: string | HTMLElement;
  /** Initial viewport state */
  initialViewState?: ViewState;
  /** Optional deck.gl controller options */
  controller?: boolean | object;
  /** Custom styling options */
  style?: {
    width?: string;
    height?: string;
  };
}

/**
 * Viewport state for the map view
 */
export interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
}

/**
 * GeoTIFF image metadata
 */
export interface GeoTIFFMetadata {
  width: number;
  height: number;
  bounds: [number, number, number, number]; // [minX, minY, maxX, maxY]
  origin: [number, number];
  resolution: [number, number];
  noDataValue?: number;
  description?: string;
}

/**
 * SAR image layer options
 */
export interface SARImageLayerOptions {
  id: string;
  data: ArrayBuffer | string;
  opacity?: number;
  colormap?: ColorMap;
  bounds?: [number, number, number, number];
  visible?: boolean;
}

/**
 * Color mapping configuration
 */
export interface ColorMap {
  /** Color mapping type */
  type: 'linear' | 'log' | 'custom';
  /** Min value for color scale */
  min?: number;
  /** Max value for color scale */
  max?: number;
  /** Color palette */
  colors?: string[];
  /** Custom mapping function */
  mapFunction?: (value: number) => [number, number, number, number];
}

/**
 * Image data interface
 */
export interface ImageData {
  data: TypedArray;
  width: number;
  height: number;
  bounds: [number, number, number, number];
}

/**
 * Supported typed arrays
 */
export type TypedArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;
