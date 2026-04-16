import GeoTIFF, { fromUrl, fromArrayBuffer } from 'geotiff';
import { normalizeS3Url } from '../utils/s3-url.js';

/**
 * Load a Cloud Optimized GeoTIFF (COG) and return a tile fetcher for deck.gl
 * @param {string} url - URL of the COG file (supports S3 URIs like s3://bucket/key or HTTPS URLs)
 * @returns {Promise<{getTile: Function, bounds: Array, crs: string, width: number, height: number}>}
 */
export async function loadCOG(url) {
  console.log('[COG Loader] Loading COG from:', url);
  const normalizedUrl = normalizeS3Url(url);
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

  // Pre-cache overview hierarchy at load time to avoid repeated async
  // tiff.getImage() calls on every tile request.
  const maxZoom = Math.ceil(Math.log2(Math.max(width, height) / 256));
  const overviewCache = new Map(); // overviewIndex → {image, width, height}
  for (let i = 0; i < imageCount; i++) {
    const img = await tiff.getImage(i);
    overviewCache.set(i, { image: img, width: img.getWidth(), height: img.getHeight() });
  }
  console.log(`[COG Loader] Cached ${overviewCache.size} overview levels, maxZoom: ${maxZoom}`);

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
      // Use pre-cached overview lookup
      const targetZoom = Math.min(z, maxZoom);
      const overviewIndex = Math.max(0, Math.min(imageCount - 1, maxZoom - targetZoom));

      const cached = overviewCache.get(overviewIndex);
      const targetImage = cached.image;
      const imgWidth = cached.width;
      const imgHeight = cached.height;

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

      // Reuse raster directly if already Float32Array, otherwise convert
      const data = rasters[0] instanceof Float32Array ? rasters[0] : new Float32Array(rasters[0]);

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
  const normalizedUrl = normalizeS3Url(url);
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
 * Load a local GeoTIFF file (File object).
 * - COGs (tiled + overviews): metadata-only load, tiles served on demand
 * - Plain TIFs: full raster read into memory
 * Both paths use world (geo) coordinates as bounds.
 *
 * @param {File} file - Local File object (.tif / .tiff)
 * @param {Function} [onProgress] - Progress callback (0-100)
 * @returns {Promise<Object>} Same interface as loadCOG
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

  // Extract georeferencing
  let bbox;
  try {
    bbox = image.getBoundingBox();
  } catch (e) {
    console.warn('[COG Loader] getBoundingBox() failed, using pixel coords');
    bbox = [0, 0, width, height];
  }
  if (bbox[0] > bbox[2]) [bbox[0], bbox[2]] = [bbox[2], bbox[0]];
  if (bbox[1] > bbox[3]) [bbox[1], bbox[3]] = [bbox[3], bbox[1]];
  const geoBounds = [bbox[0], bbox[1], bbox[2], bbox[3]];

  let crs = 'EPSG:4326';
  try {
    const geoKeys = image.getGeoKeys();
    if (geoKeys.ProjectedCSTypeGeoKey) crs = `EPSG:${geoKeys.ProjectedCSTypeGeoKey}`;
    else if (geoKeys.GeographicTypeGeoKey) crs = `EPSG:${geoKeys.GeographicTypeGeoKey}`;
  } catch (_) {}

  let resolution = null;
  try { resolution = image.getResolution(); } catch (_) {}

  // --- Data loading: COGs skip full read, plain TIFs read everything ---
  let fullData = null;

  if (isCOG) {
    console.log(`[COG Loader] COG detected: ${imageCount} overviews, tiles ${tileWidth}x${tileHeight}`);
    progress(85);
  } else {
    console.log('[COG Loader] Plain TIF — reading full raster...');
    progress(30);
    const rasters = await image.readRasters();
    fullData = new Float32Array(rasters[0]);
    progress(85);
    console.log(`[COG Loader] Raster read: ${width}x${height} (${(fullData.byteLength / 1e6).toFixed(1)} MB)`);
  }

  // --- getTile: for COGs, read from overviews on demand ---
  // Uses bbox from deck.gl TileLayer which gives the exact world rectangle.
  // OrthographicView: Y=0 is bottom, Y=height is top.
  // Image raster:     row 0 is top, row height-1 is bottom.
  // So world Y maps to pixel row = height - Y.
  async function getTile({ x, y, z, bbox }) {
    if (!isCOG) return null;
    try {
      const tileSize = 256;

      // Get world rectangle from bbox (OrthographicView provides left/right/top/bottom)
      let wxMin, wxMax, wyMin, wyMax;
      if (bbox && bbox.left !== undefined) {
        wxMin = Math.min(bbox.left, bbox.right);
        wxMax = Math.max(bbox.left, bbox.right);
        wyMin = Math.min(bbox.top, bbox.bottom);
        wyMax = Math.max(bbox.top, bbox.bottom);
      } else {
        // Fallback: compute from x,y,z
        const worldSize = tileSize / Math.pow(2, z);
        wxMin = x * worldSize;
        wxMax = wxMin + worldSize;
        wyMin = y * worldSize;
        wyMax = wyMin + worldSize;
      }

      // Map world coords to full-res pixel coords (flip Y)
      const pxLeft = Math.max(0, Math.floor(wxMin));
      const pxRight = Math.min(width, Math.ceil(wxMax));
      const pxTop = Math.max(0, Math.floor(height - wyMax));   // world top → pixel top (low row)
      const pxBottom = Math.min(height, Math.ceil(height - wyMin)); // world bottom → pixel bottom (high row)

      if (pxLeft >= pxRight || pxTop >= pxBottom) return null;

      // Pick best overview for this resolution
      const neededRes = Math.max(pxRight - pxLeft, pxBottom - pxTop) / tileSize;
      let bestIdx = 0;
      for (let i = 0; i < imageCount; i++) {
        const ovImg = await tiff.getImage(i);
        const ovRes = width / ovImg.getWidth();
        if (ovRes <= neededRes * 1.5) bestIdx = i;
      }

      const ovImg = await tiff.getImage(bestIdx);
      const ovW = ovImg.getWidth();
      const ovH = ovImg.getHeight();
      const scaleX = ovW / width;
      const scaleY = ovH / height;

      // Map full-res pixel window to overview pixel window
      const ovLeft = Math.max(0, Math.floor(pxLeft * scaleX));
      const ovTop = Math.max(0, Math.floor(pxTop * scaleY));
      const ovRight = Math.min(ovW, Math.ceil(pxRight * scaleX));
      const ovBottom = Math.min(ovH, Math.ceil(pxBottom * scaleY));

      if (ovLeft >= ovRight || ovTop >= ovBottom) return null;

      const rasters = await ovImg.readRasters({
        window: [ovLeft, ovTop, ovRight, ovBottom],
        width: tileSize,
        height: tileSize,
        resampleMethod: 'bilinear',
      });
      return { data: new Float32Array(rasters[0]), width: tileSize, height: tileSize };
    } catch (error) {
      console.error(`[COG Loader] Tile error x:${x} y:${y} z:${z}:`, error);
      return null;
    }
  }

  async function getExportStripe({ startRow, numRows, ml, exportWidth, startCol = 0, numCols }) {
    const outCols = numCols || exportWidth;
    const srcData = fullData || (await image.readRasters()).then(r => new Float32Array(r[0]));
    const out = new Float32Array(outCols * numRows);
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < outCols; c++) {
        let sum = 0, cnt = 0;
        const r0 = (startRow + r) * ml;
        const c0 = (startCol + c) * ml;
        for (let dr = 0; dr < ml && r0 + dr < height; dr++) {
          for (let dc = 0; dc < ml && c0 + dc < width; dc++) {
            const v = srcData[(r0 + dr) * width + (c0 + dc)];
            if (!isNaN(v) && v !== 0) { sum += v; cnt++; }
          }
        }
        out[r * outCols + c] = cnt > 0 ? sum / cnt : NaN;
      }
    }
    return { bands: { band0: out } };
  }

  async function getPixelValue(row, col) {
    if (row < 0 || row >= height || col < 0 || col >= width) return NaN;
    if (fullData) return fullData[row * width + col];
    // COG: read single pixel window
    const rasters = await image.readRasters({ window: [col, row, col + 1, row + 1] });
    return new Float32Array(rasters[0])[0];
  }

  /**
   * Force-read full raster into memory (used by mosaic).
   * No-op if already loaded (plain TIF path).
   */
  async function readFullData() {
    if (fullData) return fullData;
    console.log(`[COG Loader] Reading full raster for ${file.name}...`);
    const rasters = await image.readRasters();
    fullData = new Float32Array(rasters[0]);
    return fullData;
  }

  progress(100);

  console.log(`[COG Loader] Local TIF ready: ${width}x${height}, isCOG=${isCOG}, crs=${crs}`);

  return {
    ...(fullData ? { data: fullData } : {}),
    getTile,
    getExportStripe,
    getPixelValue,
    readFullData,
    bounds: [0, 0, width, height],  // pixel space for rendering/tile indexing
    geoBounds,
    worldBounds: geoBounds,
    crs,
    width,
    height,
    sourceWidth: width,
    sourceHeight: height,
    tileWidth: tileWidth || 256,
    tileHeight: tileHeight || 256,
    resolution,
    isCOG,
    imageCount,
  };
}

/**
 * Load multiple local TIF files and mosaic them into a single raster.
 * Each file is placed at its georeferenced position within the union bounding box.
 * Output uses world coordinates as bounds.
 *
 * @param {File[]} files - Array of File objects
 * @param {Function} [onProgress] - Progress callback (0-100)
 * @returns {Promise<Object>} Mosaicked dataset
 */
export async function loadLocalTIFs(files, onProgress) {
  const progress = onProgress || (() => {});

  if (!files || files.length === 0) throw new Error('No files provided');
  if (files.length === 1) return loadLocalTIF(files[0], onProgress);

  console.log(`[COG Loader] Loading ${files.length} local TIFs for mosaic`);

  // Load all files in parallel
  const perFileWeight = 80 / files.length;
  const slices = await Promise.all(
    files.map((file, idx) =>
      loadLocalTIF(file, (pct) => {
        progress(Math.round(idx * perFileWeight + (pct / 100) * perFileWeight));
      })
    )
  );

  progress(82);

  // Compute union geoBounds across all slices
  let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
  for (const s of slices) {
    const gb = s.geoBounds;
    if (gb[0] < gMinX) gMinX = gb[0];
    if (gb[1] < gMinY) gMinY = gb[1];
    if (gb[2] > gMaxX) gMaxX = gb[2];
    if (gb[3] > gMaxY) gMaxY = gb[3];
  }
  const unionGeoBounds = [gMinX, gMinY, gMaxX, gMaxY];
  console.log('[COG Loader] Union geoBounds:', unionGeoBounds);

  // Determine output resolution from the finest-resolution slice
  let bestResX = Infinity, bestResY = Infinity;
  for (const s of slices) {
    const gb = s.geoBounds;
    const rx = (gb[2] - gb[0]) / s.width;
    const ry = (gb[3] - gb[1]) / s.height;
    if (rx < bestResX) bestResX = rx;
    if (ry < bestResY) bestResY = ry;
  }

  // Cap mosaic at ~64 MP (~256 MB Float32) to stay within browser memory.
  const MAX_PIXELS = 64 * 1024 * 1024;
  let mosaicWidth = Math.round((gMaxX - gMinX) / bestResX);
  let mosaicHeight = Math.round((gMaxY - gMinY) / bestResY);

  if (mosaicWidth * mosaicHeight > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / (mosaicWidth * mosaicHeight));
    bestResX /= scale;
    bestResY /= scale;
    mosaicWidth = Math.round((gMaxX - gMinX) / bestResX);
    mosaicHeight = Math.round((gMaxY - gMinY) / bestResY);
    console.log(`[COG Loader] Mosaic downsampled to fit memory: ${mosaicWidth}x${mosaicHeight}`);
  }

  console.log(`[COG Loader] Mosaic: ${mosaicWidth}x${mosaicHeight} (res: ${bestResX.toExponential(3)}, ${bestResY.toExponential(3)})`);

  progress(85);

  // Create mosaic — fill with NaN (nodata)
  const mosaic = new Float32Array(mosaicWidth * mosaicHeight);
  mosaic.fill(NaN);

  // Ensure all slices have full raster data (COGs read on demand by default)
  for (let si = 0; si < slices.length; si++) {
    if (!slices[si].data) {
      await slices[si].readFullData();
      slices[si].data = await slices[si].readFullData();
    }
  }

  progress(88);

  // Place each slice at its georeferenced position.
  // Mosaic row 0 = north (gMaxY), rows increase southward.
  for (let si = 0; si < slices.length; si++) {
    const s = slices[si];
    const gb = s.geoBounds;
    const srcData = s.data;

    // Detect Y-flip: positive Y resolution means row 0 = south
    const res = s.resolution;
    const yFlip = res && res[1] > 0;

    const dstCol0 = Math.round((gb[0] - gMinX) / bestResX);
    const dstRow0 = Math.round((gMaxY - gb[3]) / bestResY);

    const srcW = s.width;
    const srcH = s.height;
    const dstW = Math.round((gb[2] - gb[0]) / bestResX);
    const dstH = Math.round((gb[3] - gb[1]) / bestResY);

    for (let r = 0; r < dstH; r++) {
      const dstR = dstRow0 + r;
      if (dstR < 0 || dstR >= mosaicHeight) continue;
      const srcR = yFlip
        ? Math.min(srcH - 1, Math.floor((dstH - 1 - r) * srcH / dstH))
        : Math.min(srcH - 1, Math.floor(r * srcH / dstH));
      for (let c = 0; c < dstW; c++) {
        const dc = dstCol0 + c;
        if (dc < 0 || dc >= mosaicWidth) continue;
        const srcC = Math.min(srcW - 1, Math.floor(c * srcW / dstW));
        const v = srcData[srcR * srcW + srcC];
        if (!isNaN(v) && v !== 0) {
          mosaic[dstR * mosaicWidth + dc] = v;
        }
      }
    }

    console.log(`[COG Loader] Placed slice ${si} (${files[si].name}): dst (${dstCol0}, ${dstRow0}) ${dstW}x${dstH}, yFlip=${yFlip}`);
  }

  progress(95);

  const crs = slices[0].crs || 'EPSG:4326';

  async function getTile() { return null; }

  async function getExportStripe({ startRow, numRows, ml, exportWidth, startCol = 0, numCols }) {
    const outCols = numCols || exportWidth;
    const out = new Float32Array(outCols * numRows);
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < outCols; c++) {
        let sum = 0, cnt = 0;
        const r0 = (startRow + r) * ml;
        const c0 = (startCol + c) * ml;
        for (let dr = 0; dr < ml && r0 + dr < mosaicHeight; dr++) {
          for (let dc = 0; dc < ml && c0 + dc < mosaicWidth; dc++) {
            const v = mosaic[(r0 + dr) * mosaicWidth + (c0 + dc)];
            if (!isNaN(v) && v !== 0) { sum += v; cnt++; }
          }
        }
        out[r * outCols + c] = cnt > 0 ? sum / cnt : NaN;
      }
    }
    return { bands: { band0: out } };
  }

  async function getPixelValue(row, col) {
    if (row < 0 || row >= mosaicHeight || col < 0 || col >= mosaicWidth) return NaN;
    return mosaic[row * mosaicWidth + col];
  }

  progress(100);

  const result = {
    data: mosaic,
    getTile,
    getExportStripe,
    getPixelValue,
    bounds: [0, 0, mosaicWidth, mosaicHeight],  // pixel space for rendering
    geoBounds: unionGeoBounds,
    worldBounds: unionGeoBounds,
    crs,
    width: mosaicWidth,
    height: mosaicHeight,
    sourceWidth: mosaicWidth,
    sourceHeight: mosaicHeight,
    tileWidth: 256,
    tileHeight: 256,
    isCOG: false,
    imageCount: 1,
    sliceCount: slices.length,
    sliceNames: files.map(f => f.name),
  };

  console.log('[COG Loader] Mosaic complete:', {
    slices: files.length, width: mosaicWidth, height: mosaicHeight,
    geoBounds: unionGeoBounds, crs,
  });

  return result;
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

export default loadCOG;
