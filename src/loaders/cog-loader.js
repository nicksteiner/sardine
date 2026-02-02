import GeoTIFF, { fromUrl } from 'geotiff';

/**
 * Convert S3 URI to HTTPS URL
 * @param {string} url - S3 URI (s3://bucket/key) or HTTPS URL
 * @returns {string} HTTPS URL
 */
function normalizeUrl(url) {
  if (!url) return url;
  
  // If it's an S3 URI, convert to HTTPS
  if (url.startsWith('s3://')) {
    const parts = url.slice(5).split('/');
    const bucket = parts[0];
    const key = parts.slice(1).join('/');
    return `https://${bucket}.s3.amazonaws.com/${key}`;
  }
  
  // Already an HTTPS URL or other format
  return url;
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

  const result = {
    getTile,
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

export async function loadMultipleCOGs(urls) {
  return Promise.all(urls.map(loadCOG));
}

export { normalizeUrl };
export default loadCOG;
