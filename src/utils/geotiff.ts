import { fromArrayBuffer, fromUrl, GeoTIFF as GeoTIFFType } from 'geotiff';
import { GeoTIFFMetadata, ImageData } from '../types';

/**
 * Load a GeoTIFF from a URL or ArrayBuffer
 */
export async function loadGeoTIFF(
  source: string | ArrayBuffer
): Promise<GeoTIFFType> {
  if (typeof source === 'string') {
    return await fromUrl(source);
  }
  return await fromArrayBuffer(source);
}

/**
 * Extract metadata from a GeoTIFF image
 */
export async function getGeoTIFFMetadata(
  tiff: GeoTIFFType
): Promise<GeoTIFFMetadata> {
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bbox = image.getBoundingBox();
  const origin = image.getOrigin();
  const resolution = image.getResolution();
  const fileDirectory = image.fileDirectory;

  return {
    width,
    height,
    bounds: [bbox[0], bbox[1], bbox[2], bbox[3]],
    origin: [origin[0], origin[1]],
    resolution: [resolution[0], resolution[1]],
    noDataValue: fileDirectory.GDAL_NODATA
      ? parseFloat(fileDirectory.GDAL_NODATA)
      : undefined,
    description: fileDirectory.ImageDescription,
  };
}

/**
 * Read raster data from a GeoTIFF image
 */
export async function readGeoTIFFData(
  tiff: GeoTIFFType,
  options?: {
    window?: [number, number, number, number];
    samples?: number[];
  }
): Promise<ImageData> {
  const image = await tiff.getImage();
  const rasters = await image.readRasters({
    window: options?.window,
    samples: options?.samples,
  });

  const width = options?.window
    ? options.window[2] - options.window[0]
    : image.getWidth();
  const height = options?.window
    ? options.window[3] - options.window[1]
    : image.getHeight();

  const bbox = image.getBoundingBox();

  // For SAR imagery, typically we work with the first band
  const data = rasters[0] as any;

  return {
    data,
    width,
    height,
    bounds: [bbox[0], bbox[1], bbox[2], bbox[3]],
  };
}

/**
 * Normalize raster data to 0-255 range for visualization
 */
export function normalizeData(
  data: Float32Array | Uint16Array | any,
  min?: number,
  max?: number
): Uint8Array {
  const normalized = new Uint8Array(data.length);
  
  // Calculate min/max if not provided
  let dataMin = min ?? Infinity;
  let dataMax = max ?? -Infinity;
  
  if (min === undefined || max === undefined) {
    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      if (isFinite(val)) {
        if (val < dataMin) dataMin = val;
        if (val > dataMax) dataMax = val;
      }
    }
  }

  const range = dataMax - dataMin;
  
  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    if (!isFinite(val)) {
      normalized[i] = 0;
    } else {
      normalized[i] = Math.round(((val - dataMin) / range) * 255);
    }
  }

  return normalized;
}

/**
 * Apply a colormap to normalized data
 */
export function applyColorMap(
  data: Uint8Array
): Uint8ClampedArray {
  const rgbaData = new Uint8ClampedArray(data.length * 4);
  
  // Simple grayscale by default
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    rgbaData[i * 4] = value;     // R
    rgbaData[i * 4 + 1] = value; // G
    rgbaData[i * 4 + 2] = value; // B
    rgbaData[i * 4 + 3] = 255;   // A
  }

  return rgbaData;
}
