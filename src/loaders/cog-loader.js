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
  const normalizedUrl = normalizeUrl(url);
  const tiff = await fromUrl(normalizedUrl);
  const image = await tiff.getImage();

  // Extract metadata
  const width = image.getWidth();
  const height = image.getHeight();
  const origin = image.getOrigin();
  const resolution = image.getResolution();
  const bbox = image.getBoundingBox();

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

  // Calculate tile size (typically 256 or 512)
  const tileWidth = image.getTileWidth() || 256;
  const tileHeight = image.getTileHeight() || 256;

  // Number of overview levels
  const imageCount = await tiff.getImageCount();

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
      // Calculate which image (overview) to use based on zoom level
      const maxZoom = Math.ceil(Math.log2(Math.max(width, height) / 256));
      const targetZoom = Math.min(z, maxZoom);
      const overviewIndex = Math.max(0, Math.min(imageCount - 1, maxZoom - targetZoom));

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
        return null;
      }

      // Read the tile data
      const rasters = await targetImage.readRasters({
        window: [left, top, right, bottom],
        width: tileSize,
        height: tileSize,
        resampleMethod: 'bilinear',
      });

      // Convert to Float32Array for consistent processing
      const data = new Float32Array(rasters[0]);

      return {
        data,
        width: tileSize,
        height: tileSize,
      };
    } catch (error) {
      console.warn(`Failed to load tile x:${x}, y:${y}, z:${z}:`, error);
      return null;
    }
  }

  return {
    getTile,
    bounds,
    crs,
    width,
    height,
    tileWidth,
    tileHeight,
    origin,
    resolution,
  };
}

/**
 * Load multiple COGs and return combined tile fetchers
 * @param {string[]} urls - Array of COG URLs
 * @returns {Promise<Array<{getTile: Function, bounds: Array, crs: string}>>}
 */
export async function loadMultipleCOGs(urls) {
  return Promise.all(urls.map(loadCOG));
}

export { normalizeUrl };
export default loadCOG;
