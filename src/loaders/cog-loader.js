import GeoTIFF, { fromUrl, fromArrayBuffer } from 'geotiff';
import { normalizeS3Url } from '../utils/s3-url.js';

/** @deprecated Use normalizeS3Url from utils/s3-url.js */
function normalizeUrl(url) {
  return normalizeS3Url(url);
}

/**
 * Load a Cloud Optimized GeoTIFF (COG) and return a tile fetcher for deck.gl
 * @param {string} url - URL of the COG file (supports S3 URIs like s3://bucket/key or HTTPS URLs)
 * @returns {Promise<{getTile: Function, bounds: Array, crs: string, width: number, height: number}>}
 */
export async function loadCOG(url) {
  console.log('[COG Loader] Loading COG from:', url);
  const normalizedUrl = normalizeUrl(url);
  console.log('[COG Loader] Normalized URL:', normalizedUrl);

  const tiff = await fromUrl(normalizedUrl);
  console.log('[COG Loader] GeoTIFF loaded, fetching first image...');

  const image = await tiff.getImage();
  console.log('[COG Loader] Image metadata retrieved');

  // Validate COG structure
  const imageCount = await tiff.getImageCount();
  const tileWidth = image.getTileWidth();
  const tileHeight = image.getTileHeight();
  const fileDirectory = image.getFileDirectory();

  console.log('[COG Loader] COG validation:', {
    imageCount,
    tileWidth,
    tileHeight,
    isTiled: !!tileWidth && !!tileHeight,
    hasOverviews: imageCount > 1,
  });

  // Check if this is a proper COG
  const isCOG = (tileWidth && tileHeight && imageCount > 1);
  if (!isCOG) {
    console.warn('[COG Loader] Warning: This may not be a Cloud Optimized GeoTIFF');
    if (!tileWidth || !tileHeight) {
      console.warn('[COG Loader] - Image is not internally tiled (not optimized for streaming)');
    }
    if (imageCount === 1) {
      console.warn('[COG Loader] - No overviews found (will be slow at lower zoom levels)');
    }
  } else {
    console.log('[COG Loader] ✓ Valid Cloud Optimized GeoTIFF detected');
  }

  // Extract metadata
  const width = image.getWidth();
  const height = image.getHeight();
  const origin = image.getOrigin();
  const resolution = image.getResolution();

  // Try to get bounding box, fall back to manual calculation if needed
  let bbox;
  try {
    bbox = image.getBoundingBox();
  } catch (e) {
    console.warn('[COG Loader] getBoundingBox() failed, calculating manually:', e.message);

    // Get file directory for debugging
    const fileDirectory = image.getFileDirectory();
    console.log('[COG Loader] Available GeoTIFF tags:', Object.keys(fileDirectory));

    // Try different methods to get georeferencing info
    const tiepoints = image.getTiePoints();
    const pixelScale = fileDirectory.ModelPixelScale;
    const modelTransformation = fileDirectory.ModelTransformation;

    console.log('[COG Loader] Tiepoints:', tiepoints);
    console.log('[COG Loader] ModelPixelScale:', pixelScale);
    console.log('[COG Loader] ModelTransformation:', modelTransformation);

    if (modelTransformation && modelTransformation.length === 16) {
      // Use model transformation matrix
      const a = modelTransformation[0];
      const b = modelTransformation[1];
      const c = modelTransformation[3];
      const d = modelTransformation[4];
      const e = modelTransformation[5];
      const f = modelTransformation[7];

      const minX = c;
      const maxY = f;
      const maxX = c + (width * a);
      const minY = f + (height * e);

      bbox = [minX, minY, maxX, maxY];
      console.log('[COG Loader] Calculated bounds from ModelTransformation:', bbox);
    } else if (tiepoints && tiepoints.length >= 6) {
      // Tiepoints can be stored as:
      // 1. Flat array: [i, j, k, x, y, z] (6 elements)
      // 2. Array of objects: [{i, j, k, x, y, z}]
      console.log('[COG Loader] Tiepoint array length:', tiepoints.length);

      let i, j, k, x, y, z;

      // Check if it's a flat array (6 elements) or array of objects
      if (tiepoints.length === 6 && typeof tiepoints[0] === 'number') {
        // Flat array format: [i, j, k, x, y, z]
        [i, j, k, x, y, z] = tiepoints;
        console.log('[COG Loader] Using flat tiepoint array:', { i, j, k, x, y, z });
      } else if (Array.isArray(tiepoints[0])) {
        // Array of tiepoint arrays
        [i, j, k, x, y, z] = tiepoints[0];
        console.log('[COG Loader] Using tiepoint from array:', { i, j, k, x, y, z });
      } else {
        // Object format
        const tiepoint = tiepoints[0];
        i = tiepoint.i;
        j = tiepoint.j;
        k = tiepoint.k;
        x = tiepoint.x;
        y = tiepoint.y;
        z = tiepoint.z;
        console.log('[COG Loader] Using tiepoint object:', { i, j, k, x, y, z });
      }

      // Try to get pixel scale - might be in different places
      let scaleX, scaleY;
      if (pixelScale && pixelScale.length >= 2) {
        scaleX = pixelScale[0];
        scaleY = pixelScale[1];
      } else if (resolution && resolution.length >= 2) {
        // Fallback to resolution from getResolution()
        scaleX = Math.abs(resolution[0]);
        scaleY = Math.abs(resolution[1]);
        console.log('[COG Loader] Using resolution as pixel scale:', { scaleX, scaleY });
      } else {
        throw new Error('ModelPixelScale not found - cannot calculate bounds');
      }

      // Calculate bounds: geo = tie + (pixel - tie_pixel) * scale
      const minX = x + (0 - i) * scaleX;
      const maxY = y + (0 - j) * (-scaleY); // Y is typically inverted
      const maxX = x + (width - i) * scaleX;
      const minY = y + (height - j) * (-scaleY);

      bbox = [minX, minY, maxX, maxY];
      console.log('[COG Loader] Calculated bounds from tiepoints:', bbox);
    } else {
      console.error('[COG Loader] No georeferencing information found');
      console.error('[COG Loader] Tiepoints available:', !!tiepoints);
      console.error('[COG Loader] PixelScale available:', !!pixelScale);
      console.error('[COG Loader] ModelTransformation available:', !!modelTransformation);
      throw new Error('Could not determine bounding box from GeoTIFF metadata');
    }

    // Fix inverted bounds (can happen with negative scale or wrong tiepoint)
    if (bbox[0] > bbox[2]) {
      console.warn('[COG Loader] Swapping inverted X bounds:', bbox[0], '>', bbox[2]);
      [bbox[0], bbox[2]] = [bbox[2], bbox[0]];
    }
    if (bbox[1] > bbox[3]) {
      console.warn('[COG Loader] Swapping inverted Y bounds:', bbox[1], '>', bbox[3]);
      [bbox[1], bbox[3]] = [bbox[3], bbox[1]];
    }
  }

  // Get CRS from GeoKeys
  const geoKeys = image.getGeoKeys();
  let crs = 'EPSG:4326'; // default
  if (geoKeys.ProjectedCSTypeGeoKey) {
    crs = `EPSG:${geoKeys.ProjectedCSTypeGeoKey}`;
  } else if (geoKeys.GeographicTypeGeoKey) {
    crs = `EPSG:${geoKeys.GeographicTypeGeoKey}`;
  }

  // bounds as [minX, minY, maxX, maxY]
  const bounds = [bbox[0], bbox[1], bbox[2], bbox[3]];

  // Check if bounds are in projected coordinates (typically > 180 or < -180)
  const isProjected = Math.abs(bounds[0]) > 180 || Math.abs(bounds[2]) > 180;
  console.log('[COG Loader] Coordinate system:', isProjected ? 'Projected' : 'Geographic', bounds);

  // tileWidth and tileHeight already retrieved during validation above

  /**
   * Get tile data for deck.gl TileLayer
   * @param {Object} params - Tile parameters
   * @param {number} params.x - Tile X coordinate
   * @param {number} params.y - Tile Y coordinate
   * @param {number} params.z - Zoom level
   * @returns {Promise<{data: Float32Array, width: number, height: number}>}
   */
  async function getTile({ x, y, z }) {
    try {
      console.log(`[COG Loader] Requesting tile x:${x}, y:${y}, z:${z}`);

      // Calculate which image (overview) to use based on zoom level
      const maxZoom = Math.ceil(Math.log2(Math.max(width, height) / 256));
      const targetZoom = Math.min(z, maxZoom);
      const overviewIndex = Math.max(0, Math.min(imageCount - 1, maxZoom - targetZoom));

      console.log(`[COG Loader] Using overview ${overviewIndex}, maxZoom: ${maxZoom}`);

      // Get the appropriate image (overview)
      const targetImage = await tiff.getImage(overviewIndex);
      const imgWidth = targetImage.getWidth();
      const imgHeight = targetImage.getHeight();

      // Calculate pixel coordinates for this tile
      const scale = Math.pow(2, z);
      const tileSize = 256;

      // Convert tile coordinates to pixel coordinates
      const pixelX = (x * tileSize * imgWidth) / (scale * 256);
      const pixelY = (y * tileSize * imgHeight) / (scale * 256);
      const pixelWidth = (tileSize * imgWidth) / (scale * 256);
      const pixelHeight = (tileSize * imgHeight) / (scale * 256);

      // Clamp to image bounds
      const left = Math.max(0, Math.floor(pixelX));
      const top = Math.max(0, Math.floor(pixelY));
      const right = Math.min(imgWidth, Math.ceil(pixelX + pixelWidth));
      const bottom = Math.min(imgHeight, Math.ceil(pixelY + pixelHeight));

      // Check if tile is out of bounds
      if (left >= imgWidth || top >= imgHeight || right <= 0 || bottom <= 0) {
        console.log(`[COG Loader] Tile x:${x}, y:${y}, z:${z} is out of bounds`);
        return null;
      }

      console.log(`[COG Loader] Reading tile window: [${left}, ${top}, ${right}, ${bottom}]`);

      // Read the tile data
      const rasters = await targetImage.readRasters({
        window: [left, top, right, bottom],
        width: tileSize,
        height: tileSize,
        resampleMethod: 'bilinear',
      });

      // Convert to Float32Array for consistent processing
      const data = new Float32Array(rasters[0]);

      console.log(`[COG Loader] Tile x:${x}, y:${y}, z:${z} loaded successfully (${data.length} pixels)`);

      return {
        data,
        width: tileSize,
        height: tileSize,
      };
    } catch (error) {
      console.error(`[COG Loader] Failed to load tile x:${x}, y:${y}, z:${z}:`, error);
      return null;
    }
  }

  /**
   * Read a rectangular region from the COG at full resolution.
   * Returns raw Float32 values (power, not dB).
   *
   * @param {Object} params
   * @param {number} params.startRow  - Start row in multilook grid
   * @param {number} params.numRows   - Number of output rows
   * @param {number} params.ml        - Multilook factor (box-average)
   * @param {number} params.exportWidth - Output width (unused, uses numCols)
   * @param {number} [params.startCol=0] - Start column in multilook grid
   * @param {number} [params.numCols]  - Number of output columns
   * @returns {Promise<{bands: Object}>}
   */
  async function getExportStripe({ startRow, numRows, ml, exportWidth, startCol = 0, numCols }) {
    const outCols = numCols || exportWidth;
    // Source pixel region
    const srcLeft = startCol * ml;
    const srcTop = startRow * ml;
    const srcRight = Math.min(width, (startCol + outCols) * ml);
    const srcBottom = Math.min(height, (startRow + numRows) * ml);
    const srcW = srcRight - srcLeft;
    const srcH = srcBottom - srcTop;

    if (srcW <= 0 || srcH <= 0) {
      return { bands: { band0: new Float32Array(outCols * numRows) } };
    }

    // Read at full resolution from the base image
    const rasters = await image.readRasters({
      window: [srcLeft, srcTop, srcRight, srcBottom],
    });
    const src = new Float32Array(rasters[0]);

    // Apply multilook box-averaging
    const out = new Float32Array(outCols * numRows);
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < outCols; c++) {
        let sum = 0, cnt = 0;
        const r0 = r * ml;
        const c0 = c * ml;
        for (let dr = 0; dr < ml && r0 + dr < srcH; dr++) {
          for (let dc = 0; dc < ml && c0 + dc < srcW; dc++) {
            const v = src[(r0 + dr) * srcW + (c0 + dc)];
            if (!isNaN(v) && v !== 0) { sum += v; cnt++; }
          }
        }
        out[r * outCols + c] = cnt > 0 ? sum / cnt : NaN;
      }
    }

    return { bands: { band0: out } };
  }

  /**
   * Read a single pixel value (or window-averaged value) from the COG.
   *
   * @param {number} row - Image row
   * @param {number} col - Image column
   * @param {number} [windowSize=1] - Averaging window (odd integer)
   * @returns {Promise<number>}
   */
  async function getPixelValue(row, col, windowSize = 1) {
    const half = Math.floor(windowSize / 2);
    const r0 = Math.max(0, row - half);
    const c0 = Math.max(0, col - half);
    const r1 = Math.min(height, row + half + 1);
    const c1 = Math.min(width, col + half + 1);

    if (r1 <= r0 || c1 <= c0) return NaN;

    const rasters = await image.readRasters({
      window: [c0, r0, c1, r1],
    });
    const data = new Float32Array(rasters[0]);

    if (windowSize <= 1) return data[0];

    let sum = 0, cnt = 0;
    for (let i = 0; i < data.length; i++) {
      if (!isNaN(data[i]) && data[i] !== 0) { sum += data[i]; cnt++; }
    }
    return cnt > 0 ? sum / cnt : NaN;
  }

  const result = {
    getTile,
    getExportStripe,
    getPixelValue,
    bounds,
    crs,
    width,
    height,
    tileWidth: tileWidth || 256,
    tileHeight: tileHeight || 256,
    origin,
    resolution,
    isCOG,
    imageCount,
  };

  console.log('[COG Loader] COG loaded successfully:', {
    width,
    height,
    bounds,
    crs,
    tileWidth: tileWidth || 256,
    tileHeight: tileHeight || 256,
    imageCount,
    isCOG,
  });

  return result;
}

/**
 * Load multiple COGs and return combined tile fetchers
 * @param {string[]} urls - Array of COG URLs
 * @returns {Promise<Array<{getTile: Function, bounds: Array, crs: string}>>}
 */
/**
 * Load full image data from COG (for BitmapLayer approach)
 * @param {string} url - URL of the COG file
 * @param {number} maxSize - Maximum dimension size (will downsample if larger)
 * @returns {Promise<{data: Float32Array, width: number, height: number, bounds: Array, crs: string}>}
 */
export async function loadCOGFullImage(url, maxSize = 2048) {
  console.log('[COG Loader] Loading full COG image from:', url);
  const normalizedUrl = normalizeUrl(url);
  const tiff = await fromUrl(normalizedUrl);

  // Get the main image for georeferencing
  const mainImage = await tiff.getImage(0);
  const mainWidth = mainImage.getWidth();
  const mainHeight = mainImage.getHeight();

  // Get the best overview that fits within maxSize
  const imageCount = await tiff.getImageCount();
  let selectedImage = mainImage;
  let selectedIndex = 0;

  for (let i = 0; i < imageCount; i++) {
    const img = await tiff.getImage(i);
    const w = img.getWidth();
    const h = img.getHeight();

    if (Math.max(w, h) <= maxSize) {
      selectedImage = img;
      selectedIndex = i;
      break;
    }
  }

  const width = selectedImage.getWidth();
  const height = selectedImage.getHeight();

  // Try to get bounding box from main image, fall back to manual calculation if needed
  // Note: Overview images often don't have their own georeferencing, so we use the main image
  let bbox;
  try {
    bbox = mainImage.getBoundingBox();
    console.log('[COG Loader] Got bounding box from main image');
  } catch (e) {
    console.warn('[COG Loader] getBoundingBox() failed, calculating manually:', e.message);

    // Get file directory for debugging - use main image for georeferencing
    const fileDirectory = mainImage.getFileDirectory();
    const resolution = mainImage.getResolution();
    console.log('[COG Loader] Available GeoTIFF tags:', Object.keys(fileDirectory));

    // Try different methods to get georeferencing info from main image
    const tiepoints = mainImage.getTiePoints();
    const pixelScale = fileDirectory.ModelPixelScale;
    const modelTransformation = fileDirectory.ModelTransformation;

    console.log('[COG Loader] Tiepoints:', tiepoints);
    console.log('[COG Loader] ModelPixelScale:', pixelScale);
    console.log('[COG Loader] ModelTransformation:', modelTransformation);

    if (modelTransformation && modelTransformation.length === 16) {
      // Use model transformation matrix - use main image dimensions
      const a = modelTransformation[0];
      const b = modelTransformation[1];
      const c = modelTransformation[3];
      const d = modelTransformation[4];
      const e = modelTransformation[5];
      const f = modelTransformation[7];

      const minX = c;
      const maxY = f;
      const maxX = c + (mainWidth * a);
      const minY = f + (mainHeight * e);

      bbox = [minX, minY, maxX, maxY];
      console.log('[COG Loader] Calculated bounds from ModelTransformation:', bbox);
    } else if (tiepoints && tiepoints.length >= 6) {
      // Tiepoints can be stored as:
      // 1. Flat array: [i, j, k, x, y, z] (6 elements)
      // 2. Array of objects: [{i, j, k, x, y, z}]
      console.log('[COG Loader] Tiepoint array length:', tiepoints.length);

      let i, j, k, x, y, z;

      // Check if it's a flat array (6 elements) or array of objects
      if (tiepoints.length === 6 && typeof tiepoints[0] === 'number') {
        // Flat array format: [i, j, k, x, y, z]
        [i, j, k, x, y, z] = tiepoints;
        console.log('[COG Loader] Using flat tiepoint array:', { i, j, k, x, y, z });
      } else if (Array.isArray(tiepoints[0])) {
        // Array of tiepoint arrays
        [i, j, k, x, y, z] = tiepoints[0];
        console.log('[COG Loader] Using tiepoint from array:', { i, j, k, x, y, z });
      } else {
        // Object format
        const tiepoint = tiepoints[0];
        i = tiepoint.i;
        j = tiepoint.j;
        k = tiepoint.k;
        x = tiepoint.x;
        y = tiepoint.y;
        z = tiepoint.z;
        console.log('[COG Loader] Using tiepoint object:', { i, j, k, x, y, z });
      }

      // Try to get pixel scale - might be in different places
      let scaleX, scaleY;
      if (pixelScale && pixelScale.length >= 2) {
        scaleX = pixelScale[0];
        scaleY = pixelScale[1];
      } else if (resolution && resolution.length >= 2) {
        // Fallback to resolution from getResolution()
        scaleX = Math.abs(resolution[0]);
        scaleY = Math.abs(resolution[1]);
        console.log('[COG Loader] Using resolution as pixel scale:', { scaleX, scaleY });
      } else {
        throw new Error('ModelPixelScale not found - cannot calculate bounds');
      }

      // Calculate bounds: geo = tie + (pixel - tie_pixel) * scale
      // Use main image dimensions for bounds calculation
      const minX = x + (0 - i) * scaleX;
      const maxY = y + (0 - j) * (-scaleY); // Y is typically inverted
      const maxX = x + (mainWidth - i) * scaleX;
      const minY = y + (mainHeight - j) * (-scaleY);

      bbox = [minX, minY, maxX, maxY];
      console.log('[COG Loader] Calculated bounds from tiepoints:', bbox);
    } else {
      console.error('[COG Loader] No georeferencing information found');
      console.error('[COG Loader] Tiepoints available:', !!tiepoints);
      console.error('[COG Loader] PixelScale available:', !!pixelScale);
      console.error('[COG Loader] ModelTransformation available:', !!modelTransformation);
      throw new Error('Could not determine bounding box from GeoTIFF metadata');
    }

    // Fix inverted bounds (can happen with negative scale or wrong tiepoint)
    if (bbox[0] > bbox[2]) {
      console.warn('[COG Loader] Swapping inverted X bounds:', bbox[0], '>', bbox[2]);
      [bbox[0], bbox[2]] = [bbox[2], bbox[0]];
    }
    if (bbox[1] > bbox[3]) {
      console.warn('[COG Loader] Swapping inverted Y bounds:', bbox[1], '>', bbox[3]);
      [bbox[1], bbox[3]] = [bbox[3], bbox[1]];
    }
  }

  const bounds = [bbox[0], bbox[1], bbox[2], bbox[3]];

  // Get CRS from main image
  const geoKeys = mainImage.getGeoKeys();
  let crs = 'EPSG:4326';
  if (geoKeys.ProjectedCSTypeGeoKey) {
    crs = `EPSG:${geoKeys.ProjectedCSTypeGeoKey}`;
  } else if (geoKeys.GeographicTypeGeoKey) {
    crs = `EPSG:${geoKeys.GeographicTypeGeoKey}`;
  }

  console.log(`[COG Loader] Loading overview ${selectedIndex}, size: ${width}x${height}`);

  // Read the full raster
  const rasters = await selectedImage.readRasters();
  const data = new Float32Array(rasters[0]);

  console.log('[COG Loader] Full image loaded:', {
    width,
    height,
    bounds,
    crs,
    dataSize: data.length,
  });

  return {
    data,
    width,
    height,
    bounds,
    crs,
  };
}

/**
 * Load a local GeoTIFF file (File object) into memory with mipmap overviews.
 * Works for both COGs and plain TIFs — reads the full file into an ArrayBuffer,
 * then builds a power-of-2 mipmap pyramid for tile serving.
 *
 * @param {File} file - Local File object (.tif / .tiff)
 * @param {Function} [onProgress] - Progress callback (0-100)
 * @returns {Promise<Object>} Same interface as loadCOG (getTile, bounds, crs, etc.)
 */
export async function loadLocalTIF(file, onProgress) {
  const progress = onProgress || (() => {});
  console.log('[COG Loader] Loading local TIF:', file.name, `(${(file.size / 1e6).toFixed(1)} MB)`);
  progress(5);

  const arrayBuffer = await file.arrayBuffer();
  progress(15);
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  progress(25);

  const width = image.getWidth();
  const height = image.getHeight();
  const imageCount = await tiff.getImageCount();
  const tileWidth = image.getTileWidth();
  const tileHeight = image.getTileHeight();
  const isCOG = !!(tileWidth && tileHeight && imageCount > 1);

  console.log('[COG Loader] Local TIF:', { width, height, imageCount, isCOG });

  // Extract georeferencing — same logic as loadCOG
  let bbox;
  try {
    bbox = image.getBoundingBox();
  } catch (e) {
    console.warn('[COG Loader] getBoundingBox() failed:', e.message);
    const fileDirectory = image.getFileDirectory();
    let resolution;
    try { resolution = image.getResolution(); } catch (_) { resolution = null; }
    let tiepoints;
    try { tiepoints = image.getTiePoints(); } catch (_) { tiepoints = null; }
    const pixelScale = fileDirectory.ModelPixelScale;
    const modelTransformation = fileDirectory.ModelTransformation;
    let geoKeys;
    try { geoKeys = image.getGeoKeys(); } catch (_) { geoKeys = null; }
    console.log('[COG Loader] Georef fallback:', {
      hasTiepoints: !!(tiepoints && tiepoints.length),
      hasPixelScale: !!(pixelScale && pixelScale.length),
      hasModelTransformation: !!(modelTransformation && modelTransformation.length),
      hasResolution: !!(resolution && resolution.length),
      geoTiffTags: Object.keys(fileDirectory).filter(k => k.startsWith('Model') || k.startsWith('Geo') || k === 'GDAL_METADATA' || k === 'GeoTransform'),
      allKeys: Object.keys(fileDirectory),
      tiepoints: tiepoints,
      pixelScale: pixelScale,
      geoKeys: geoKeys,
      GDAL_METADATA: fileDirectory.GDAL_METADATA ? fileDirectory.GDAL_METADATA.substring(0, 500) : null,
    });

    if (modelTransformation && modelTransformation.length === 16) {
      const a = modelTransformation[0], c = modelTransformation[3];
      const eVal = modelTransformation[5], f = modelTransformation[7];
      bbox = [c, f + (height * eVal), c + (width * a), f];
    } else if (tiepoints && tiepoints.length > 0) {
      // First check: many tiepoints (GCP grid, e.g. ICEYE) — derive bbox from
      // min/max of all geo coordinates directly.
      const isObjectTP = typeof tiepoints[0] !== 'number';
      const numTP = isObjectTP ? tiepoints.length : Math.floor(tiepoints.length / 6);

      if (numTP >= 4 && !pixelScale && !resolution) {
        // GCP grid — scan all tiepoints for bounding box
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let t = 0; t < numTP; t++) {
          let tx, ty;
          if (isObjectTP) {
            tx = tiepoints[t].x; ty = tiepoints[t].y;
          } else {
            tx = tiepoints[t * 6 + 3]; ty = tiepoints[t * 6 + 4];
          }
          if (tx < minX) minX = tx;
          if (tx > maxX) maxX = tx;
          if (ty < minY) minY = ty;
          if (ty > maxY) maxY = ty;
        }
        bbox = [minX, minY, maxX, maxY];
        console.log(`[COG Loader] Bounds from ${numTP} GCP tiepoints:`, bbox);
      } else {
        // Single tiepoint + pixel scale path
        let i, j, x, y;
        if (typeof tiepoints[0] === 'number') {
          [i, j, , x, y] = tiepoints;
        } else if (Array.isArray(tiepoints[0])) {
          [i, j, , x, y] = tiepoints[0];
        } else {
          ({ i, j, x, y } = tiepoints[0]);
        }
        let scaleX, scaleY;
        if (pixelScale && pixelScale.length >= 2) {
          scaleX = pixelScale[0]; scaleY = pixelScale[1];
        } else if (resolution && resolution.length >= 2) {
          scaleX = Math.abs(resolution[0]); scaleY = Math.abs(resolution[1]);
        } else if (fileDirectory.GeoTransform) {
          const gt = fileDirectory.GeoTransform.split(/\s+/).map(Number);
          scaleX = Math.abs(gt[1]); scaleY = Math.abs(gt[5]);
          x = gt[0]; y = gt[3]; i = 0; j = 0;
        } else if (fileDirectory.GDAL_METADATA) {
          const md = fileDirectory.GDAL_METADATA;
          const gtMatch = md.match(/GeoTransform[^>]*>([^<]+)/);
          if (gtMatch) {
            const gt = gtMatch[1].trim().split(/[\s,]+/).map(Number);
            if (gt.length >= 6 && !gt.some(isNaN)) {
              scaleX = Math.abs(gt[1]); scaleY = Math.abs(gt[5]);
              x = gt[0]; y = gt[3]; i = 0; j = 0;
              console.log('[COG Loader] Got scale from GDAL_METADATA GeoTransform:', { scaleX, scaleY, x, y });
            }
          }
          if (!scaleX || !scaleY) {
            console.warn('[COG Loader] No GeoTransform in GDAL_METADATA, using pixel coords');
            bbox = [0, 0, width, height];
          }
        } else {
          console.warn('[COG Loader] No pixel scale found, using pixel coordinates');
          bbox = [0, 0, width, height];
        }
        if (!bbox && scaleX && scaleY) {
          bbox = [
            x + (0 - i) * scaleX,
            y + (height - j) * (-scaleY),
            x + (width - i) * scaleX,
            y + (0 - j) * (-scaleY),
          ];
        }
      }
    } else {
      // No georeferencing — fall back to pixel-space bounds
      console.warn('[COG Loader] No georeferencing found, using pixel coordinates');
      bbox = [0, 0, width, height];
    }
    if (bbox[0] > bbox[2]) [bbox[0], bbox[2]] = [bbox[2], bbox[0]];
    if (bbox[1] > bbox[3]) [bbox[1], bbox[3]] = [bbox[3], bbox[1]];
  }

  const geoBounds = [bbox[0], bbox[1], bbox[2], bbox[3]];
  // OrthographicView needs pixel-space bounds; geographic coords are too small.
  // Store geo bounds separately for export/metadata.
  const bounds = [0, 0, width, height];
  progress(30);

  let crs = 'EPSG:4326';
  try {
    const geoKeys = image.getGeoKeys();
    if (geoKeys.ProjectedCSTypeGeoKey) crs = `EPSG:${geoKeys.ProjectedCSTypeGeoKey}`;
    else if (geoKeys.GeographicTypeGeoKey) crs = `EPSG:${geoKeys.GeographicTypeGeoKey}`;
  } catch (_) {
    // No GeoKeys — keep default CRS
  }

  // For plain TIFs: read full raster into memory → BitmapLayer renders it as
  // a single GPU texture (WebGL handles mipmapping natively). No CPU mipmap needed.
  // For COGs: leave data null → falls through to TileLayer with built-in overviews.
  let fullData = null;

  if (isCOG) {
    console.log('[COG Loader] COG detected — using built-in overviews');
    progress(85);
  } else {
    console.log('[COG Loader] Plain TIF — reading raster in Web Worker...');
    progress(35);

    fullData = await new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL('./tif-worker.js', import.meta.url),
        { type: 'module' }
      );
      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          progress(msg.value);
        } else if (msg.type === 'done') {
          worker.terminate();
          resolve(msg.data);
        } else if (msg.type === 'error') {
          worker.terminate();
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (err) => {
        worker.terminate();
        reject(new Error(err.message || 'Worker error'));
      };
      // Transfer the ArrayBuffer to the worker (zero-copy)
      worker.postMessage({ arrayBuffer }, [arrayBuffer]);
    });

    console.log(`[COG Loader] Raster decoded: ${width}×${height} (${(fullData.byteLength / 1e6).toFixed(1)} MB)`);
  }

  // getTile: only used for COG path (plain TIFs go through BitmapLayer via .data)
  async function getTile({ x, y, z }) {
    if (!isCOG) return null; // plain TIFs use BitmapLayer, not tiles
    try {
      const tileSize = 256;
      const maxZoom = Math.ceil(Math.log2(Math.max(width, height) / tileSize));
      const targetZoom = Math.min(z, maxZoom);
      const overviewIndex = Math.max(0, Math.min(imageCount - 1, maxZoom - targetZoom));
      const targetImage = await tiff.getImage(overviewIndex);
      const imgWidth = targetImage.getWidth();
      const imgHeight = targetImage.getHeight();

      const scale = Math.pow(2, z);
      const pixelX = (x * imgWidth) / scale;
      const pixelY = (y * imgHeight) / scale;
      const pixelW = imgWidth / scale;
      const pixelH = imgHeight / scale;

      const left = Math.max(0, Math.floor(pixelX));
      const top = Math.max(0, Math.floor(pixelY));
      const right = Math.min(imgWidth, Math.ceil(pixelX + pixelW));
      const bottom = Math.min(imgHeight, Math.ceil(pixelY + pixelH));

      if (left >= imgWidth || top >= imgHeight || right <= 0 || bottom <= 0) return null;

      const rasters = await targetImage.readRasters({
        window: [left, top, right, bottom],
        width: tileSize,
        height: tileSize,
        resampleMethod: 'bilinear',
      });

      return { data: new Float32Array(rasters[0]), width: tileSize, height: tileSize };
    } catch (error) {
      console.error(`[COG Loader] Local tile error x:${x}, y:${y}, z:${z}:`, error);
      return null;
    }
  }

  async function getExportStripe({ startRow, numRows, ml, exportWidth, startCol = 0, numCols }) {
    const outCols = numCols || exportWidth;

    if (isCOG) {
      // Read from the tiff directly
      const srcLeft = startCol * ml;
      const srcTop = startRow * ml;
      const srcRight = Math.min(width, (startCol + outCols) * ml);
      const srcBottom = Math.min(height, (startRow + numRows) * ml);
      if (srcRight <= srcLeft || srcBottom <= srcTop) {
        return { bands: { band0: new Float32Array(outCols * numRows) } };
      }
      const rasters = await image.readRasters({
        window: [srcLeft, srcTop, srcRight, srcBottom],
      });
      const src = new Float32Array(rasters[0]);
      const srcW = srcRight - srcLeft;
      const out = new Float32Array(outCols * numRows);
      for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < outCols; c++) {
          let sum = 0, cnt = 0;
          const r0 = r * ml, c0 = c * ml;
          for (let dr = 0; dr < ml && r0 + dr < (srcBottom - srcTop); dr++) {
            for (let dc = 0; dc < ml && c0 + dc < srcW; dc++) {
              const v = src[(r0 + dr) * srcW + (c0 + dc)];
              if (!isNaN(v) && v !== 0) { sum += v; cnt++; }
            }
          }
          out[r * outCols + c] = cnt > 0 ? sum / cnt : NaN;
        }
      }
      return { bands: { band0: out } };
    }

    // Plain TIF: use in-memory fullData
    const out = new Float32Array(outCols * numRows);
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < outCols; c++) {
        let sum = 0, cnt = 0;
        const r0 = (startRow + r) * ml;
        const c0 = (startCol + c) * ml;
        for (let dr = 0; dr < ml && r0 + dr < height; dr++) {
          for (let dc = 0; dc < ml && c0 + dc < width; dc++) {
            const v = fullData[(r0 + dr) * width + (c0 + dc)];
            if (!isNaN(v) && v !== 0) { sum += v; cnt++; }
          }
        }
        out[r * outCols + c] = cnt > 0 ? sum / cnt : NaN;
      }
    }
    return { bands: { band0: out } };
  }

  async function getPixelValue(row, col, windowSize = 1) {
    const half = Math.floor(windowSize / 2);
    const r0 = Math.max(0, row - half), c0 = Math.max(0, col - half);
    const r1 = Math.min(height, row + half + 1), c1 = Math.min(width, col + half + 1);
    if (r1 <= r0 || c1 <= c0) return NaN;

    if (isCOG) {
      const rasters = await image.readRasters({ window: [c0, r0, c1, r1] });
      const data = new Float32Array(rasters[0]);
      if (windowSize <= 1) return data[0];
      let sum = 0, cnt = 0;
      for (let i = 0; i < data.length; i++) {
        if (!isNaN(data[i]) && data[i] !== 0) { sum += data[i]; cnt++; }
      }
      return cnt > 0 ? sum / cnt : NaN;
    }

    if (windowSize <= 1) return fullData[row * width + col];
    let sum = 0, cnt = 0;
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const v = fullData[r * width + c];
        if (!isNaN(v) && v !== 0) { sum += v; cnt++; }
      }
    }
    return cnt > 0 ? sum / cnt : NaN;
  }

  const result = {
    // For plain TIFs, expose fullData so SARViewer uses the fast BitmapLayer
    // path (single GPU texture) instead of the slow TileLayer path.
    // For COGs, leave data undefined so it falls through to tiled loading.
    ...(fullData ? { data: fullData } : {}),
    getTile,
    getExportStripe,
    getPixelValue,
    bounds,
    geoBounds,
    worldBounds: geoBounds,
    crs,
    width,
    height,
    sourceWidth: width,
    sourceHeight: height,
    tileWidth: tileWidth || 256,
    tileHeight: tileHeight || 256,
    origin: (() => { try { return image.getOrigin(); } catch (_) { return null; } })(),
    resolution: (() => { try { return image.getResolution(); } catch (_) { return null; } })(),
    isCOG,
    imageCount,
  };

  console.log('[COG Loader] Local TIF loaded:', {
    width, height, bounds, geoBounds, crs, isCOG,
  });

  return result;
}

/**
 * Load multiple local TIF files as a multi-band dataset.
 * Reuses loadLocalTIF for each file, then wraps results in a multi-band structure
 * compatible with the existing multi-band rendering pipeline.
 * @param {File[]} files - Array of File objects
 * @param {Function} [onProgress] - Progress callback (0-100)
 * @returns {Promise<Object>} Multi-band dataset
 */
export async function loadLocalTIFs(files, onProgress) {
  const progress = onProgress || (() => {});

  if (!files || files.length === 0) throw new Error('No files provided');
  if (files.length === 1) return loadLocalTIF(files[0], onProgress);

  // Detect band names from filenames
  const bandNames = detectBandNamesFromFiles(files);
  console.log(`[COG Loader] Loading ${files.length} local TIFs as multi-band:`, bandNames);

  // Load all files in parallel
  const perFileWeight = 90 / files.length;
  const bandResults = await Promise.all(
    files.map((file, idx) =>
      loadLocalTIF(file, (pct) => {
        // Aggregate per-file progress into overall progress
        progress(Math.round(idx * perFileWeight + (pct / 100) * perFileWeight));
      })
    )
  );

  progress(92);

  // Use first file as reference for dimensions
  const ref = bandResults[0];

  // Build bands metadata array (compatible with loadMultiBandCOG output)
  const bands = bandResults.map((result, idx) => ({
    name: bandNames[idx],
    file: files[idx].name,
    ...result,
  }));

  // Create composite getTile that returns all bands
  async function getTile(tileCoord) {
    const tiles = await Promise.all(bandResults.map(r => r.getTile(tileCoord)));
    return tiles[0]; // Primary band for single-band display
  }

  // Create composite getExportStripe that returns all bands
  async function getExportStripe(params) {
    const stripes = await Promise.all(bandResults.map(r => r.getExportStripe(params)));
    const result = { bands: {} };
    stripes.forEach((stripe, idx) => {
      const key = stripe.bands ? Object.keys(stripe.bands)[0] : `band${idx}`;
      result.bands[bandNames[idx]] = stripe.bands[key] || stripe.bands.band0;
    });
    return result;
  }

  progress(95);

  const result = {
    type: 'multi-band',
    bandCount: bandNames.length,
    bands,
    bandNames,
    // Use reference band for common properties
    ...(ref.data ? { data: ref.data } : {}),
    getTile,
    getExportStripe,
    getPixelValue: ref.getPixelValue,
    width: ref.width,
    height: ref.height,
    sourceWidth: ref.sourceWidth,
    sourceHeight: ref.sourceHeight,
    bounds: ref.bounds,
    geoBounds: ref.geoBounds,
    worldBounds: ref.worldBounds,
    crs: ref.crs,
    imageCount: ref.imageCount,
    isCOG: ref.isCOG,
    tileWidth: ref.tileWidth,
    tileHeight: ref.tileHeight,
    // Keep individual band loaders for per-band access
    bandLoaders: bandResults,
  };

  progress(100);
  console.log('[COG Loader] Multi-band local TIFs loaded:', {
    bands: bandNames, width: ref.width, height: ref.height,
  });

  return result;
}

/**
 * Detect band names from local File objects using filename patterns.
 */
function detectBandNamesFromFiles(files) {
  const patterns = [
    { regex: /[_-]VV[_.-]/i, name: 'VV' },
    { regex: /[_-]VH[_.-]/i, name: 'VH' },
    { regex: /[_-]HH[_.-]/i, name: 'HH' },
    { regex: /[_-]HV[_.-]/i, name: 'HV' },
    { regex: /[_-]pre[_.-]/i, name: 'pre' },
    { regex: /[_-]post[_.-]/i, name: 'post' },
    { regex: /[_-]before[_.-]/i, name: 'before' },
    { regex: /[_-]after[_.-]/i, name: 'after' },
    { regex: /[_-]coh[_.-]/i, name: 'coherence' },
    { regex: /[_-]phase[_.-]/i, name: 'phase' },
    { regex: /[_-]amp[_.-]/i, name: 'amplitude' },
  ];

  const names = [];
  const usedNames = new Set();

  for (const file of files) {
    let detected = false;
    for (const { regex, name } of patterns) {
      if (regex.test(file.name)) {
        let bandName = name;
        let suffix = 1;
        while (usedNames.has(bandName)) {
          suffix++;
          bandName = `${name}_${suffix}`;
        }
        usedNames.add(bandName);
        names.push(bandName);
        detected = true;
        break;
      }
    }
    if (!detected) {
      // Use filename stem without extension
      const stem = file.name.replace(/\.[^.]+$/, '');
      let bandName = stem;
      let suffix = 1;
      while (usedNames.has(bandName)) {
        suffix++;
        bandName = `${stem}_${suffix}`;
      }
      usedNames.add(bandName);
      names.push(bandName);
    }
  }

  return names;
}

export async function loadMultipleCOGs(urls) {
  return Promise.all(urls.map(loadCOG));
}

/**
 * Load multiple COGs as a multi-band dataset
 * @param {Object} config - Configuration object
 * @param {Object} config.bands - Object mapping band names to URLs
 *   Example: { VV: 'url1.tif', VH: 'url2.tif' }
 * @param {Array<string>} config.urls - Alternative: array of URLs with auto-detection
 * @param {Object} config.metadata - Optional metadata override
 * @returns {Promise<Object>} Multi-band dataset info
 */
export async function loadMultiBandCOG(config) {
  const { bands, urls, metadata = {} } = config;

  // If bands object provided, use it directly
  let bandMapping = bands;

  // If urls array provided, try to detect band names from filenames
  if (!bandMapping && urls) {
    // Validate URLs first
    const validUrls = urls.filter(url => {
      if (!url || typeof url !== 'string' || url.trim() === '') {
        console.warn('[loadMultiBandCOG] Skipping empty or invalid URL');
        return false;
      }
      return true;
    });

    if (validUrls.length === 0) {
      throw new Error('No valid URLs provided');
    }

    bandMapping = detectBandNames(validUrls);
  }

  if (!bandMapping || Object.keys(bandMapping).length === 0) {
    throw new Error('No valid bands or URLs provided');
  }

  // Load metadata from all bands
  const bandNames = Object.keys(bandMapping);
  const bandUrls = bandNames.map(name => bandMapping[name]);

  console.log(`[loadMultiBandCOG] Loading ${bandNames.length} bands:`, bandNames);
  console.log(`[loadMultiBandCOG] URLs:`, bandUrls);

  // Load metadata from first band as reference
  let referenceBand;
  try {
    referenceBand = await loadCOG(bandUrls[0]);
  } catch (error) {
    throw new Error(`Failed to load reference band "${bandNames[0]}" from ${bandUrls[0]}: ${error.message}`);
  }

  // Verify all bands have compatible dimensions and bounds
  const bandMetadata = await Promise.all(
    bandUrls.map(async (url, idx) => {
      try {
        const meta = await loadCOG(url);

        // Check compatibility with reference
        if (meta.width !== referenceBand.width || meta.height !== referenceBand.height) {
          console.warn(`[loadMultiBandCOG] Band ${bandNames[idx]} has different dimensions. Expected ${referenceBand.width}x${referenceBand.height}, got ${meta.width}x${meta.height}`);
        }

        return {
          name: bandNames[idx],
          url,
          ...meta,
        };
      } catch (error) {
        throw new Error(`Failed to load band "${bandNames[idx]}" from ${url}: ${error.message}`);
      }
    })
  );

  return {
    type: 'multi-band',
    bandCount: bandNames.length,
    bands: bandMetadata,
    bandNames,
    bandMapping,
    // Use reference band for common properties
    width: referenceBand.width,
    height: referenceBand.height,
    bounds: referenceBand.bounds,
    imageCount: referenceBand.imageCount,
    isCOG: referenceBand.isCOG,
    tileWidth: referenceBand.tileWidth,
    tileHeight: referenceBand.tileHeight,
    ...metadata,
  };
}

/**
 * Detect band names from URLs based on common SAR naming conventions
 * @param {Array<string>} urls - Array of URLs
 * @returns {Object} Object mapping detected band names to URLs
 */
function detectBandNames(urls) {
  const bandMapping = {};

  // Common SAR band patterns
  const patterns = [
    { regex: /[_-]VV[_.-]/i, name: 'VV' },
    { regex: /[_-]VH[_.-]/i, name: 'VH' },
    { regex: /[_-]HH[_.-]/i, name: 'HH' },
    { regex: /[_-]HV[_.-]/i, name: 'HV' },
    { regex: /[_-]pre[_.-]/i, name: 'pre' },
    { regex: /[_-]post[_.-]/i, name: 'post' },
    { regex: /[_-]during[_.-]/i, name: 'during' },
    { regex: /[_-]before[_.-]/i, name: 'before' },
    { regex: /[_-]after[_.-]/i, name: 'after' },
    { regex: /[_-]coh[_.-]/i, name: 'coherence' },
    { regex: /[_-]phase[_.-]/i, name: 'phase' },
    { regex: /[_-]amp[_.-]/i, name: 'amplitude' },
    { regex: /[_-]int[_.-]/i, name: 'intensity' },
  ];

  urls.forEach((url, idx) => {
    let detected = false;

    // Try to match known patterns
    for (const { regex, name } of patterns) {
      if (regex.test(url)) {
        // Handle multiple files with same band (add suffix)
        let bandName = name;
        let suffix = 1;
        while (bandMapping[bandName]) {
          suffix++;
          bandName = `${name}_${suffix}`;
        }
        bandMapping[bandName] = url;
        detected = true;
        break;
      }
    }

    // If no pattern matched, use generic name
    if (!detected) {
      bandMapping[`band_${idx + 1}`] = url;
    }
  });

  console.log('[detectBandNames] Detected bands:', Object.keys(bandMapping));

  return bandMapping;
}

/**
 * Load temporal stack of COGs (multiple acquisitions)
 * @param {Array<Object>} acquisitions - Array of {date, url, label} objects
 * @returns {Promise<Object>} Temporal dataset info
 */
export async function loadTemporalCOGs(acquisitions) {
  if (!Array.isArray(acquisitions) || acquisitions.length === 0) {
    throw new Error('No acquisitions provided');
  }

  // Validate acquisitions
  const validAcquisitions = acquisitions.filter(acq => {
    if (!acq || !acq.url || typeof acq.url !== 'string' || acq.url.trim() === '') {
      console.warn('[loadTemporalCOGs] Skipping invalid acquisition:', acq);
      return false;
    }
    return true;
  });

  if (validAcquisitions.length === 0) {
    throw new Error('No valid acquisitions with URLs provided');
  }

  console.log(`[loadTemporalCOGs] Loading ${validAcquisitions.length} acquisitions`);

  // Sort by date
  const sorted = [...validAcquisitions].sort((a, b) => {
    const dateA = a.date ? new Date(a.date) : new Date(0);
    const dateB = b.date ? new Date(b.date) : new Date(0);
    return dateA - dateB;
  });

  // Load metadata for all acquisitions
  const acqMetadata = await Promise.all(
    sorted.map(async (acq, idx) => {
      try {
        const meta = await loadCOG(acq.url);
        return {
          index: idx,
          date: acq.date,
          label: acq.label || `T${idx + 1}`,
          url: acq.url,
          ...meta,
        };
      } catch (error) {
        throw new Error(`Failed to load acquisition "${acq.label || acq.date || idx}" from ${acq.url}: ${error.message}`);
      }
    })
  );

  // Use first acquisition as reference
  const reference = acqMetadata[0];

  return {
    type: 'temporal',
    acquisitionCount: acqMetadata.length,
    acquisitions: acqMetadata,
    dateRange: {
      start: sorted[0].date,
      end: sorted[sorted.length - 1].date,
    },
    // Use reference for common properties
    width: reference.width,
    height: reference.height,
    bounds: reference.bounds,
    imageCount: reference.imageCount,
    isCOG: reference.isCOG,
  };
}

export { normalizeUrl };
export default loadCOG;
