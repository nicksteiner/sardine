/**
 * raster-overlay.js — any georeferenced COG as a map-mode overlay (W033).
 *
 * Wraps a cog-tile-reader in the scene contract the reprojected tile fetcher
 * expects ({ getTile, width, height, worldBounds, crs, bboxSpace }), so a
 * context raster such as GHS-POP population density can be drawn through
 * the same warped-tile path as the SAR scene — and sampled by the same
 * exposure code. Values pass through untouched; render them with
 * useDecibels=false and a linear contrast range in the data's units.
 */
import { getCOGReader } from '../loaders/cog-tile-reader.js';

/**
 * @param {string} url - COG URL (CORS + Range)
 * @param {Object} [opts]
 * @param {string} [opts.resample='bilinear'] - 'nearest' for categorical rasters
 * @returns {Promise<Object>} overlay scene
 */
export async function openCOGOverlay(url, { resample = 'bilinear' } = {}) {
  const reader = await getCOGReader(url);
  const { width, height } = reader;
  async function getTile({ bbox }) {
    if (!bbox) return null;
    const left = Math.max(0, Math.floor(Math.min(bbox.left, bbox.right)));
    const right = Math.min(width, Math.ceil(Math.max(bbox.left, bbox.right)));
    const yMax = Math.max(bbox.top, bbox.bottom);
    const yMin = Math.min(bbox.top, bbox.bottom);
    const top = Math.max(0, Math.floor(height - yMax));
    const bottom = Math.min(height, Math.ceil(height - yMin));
    if (right <= left || bottom <= top) return null;
    const data = await reader.readTile([left, top, right, bottom], 256, resample);
    return data ? { data, width: 256, height: 256 } : null;
  }
  return {
    getTile,
    reader,
    url,
    width,
    height,
    bounds: [0, 0, width, height],
    worldBounds: [...reader.bbox],
    crs: reader.crs || 'EPSG:4326',
    bboxSpace: 'pixel',
  };
}

/** GHS-POP 100 m (JRC, CC BY), people per km² — see exposure.js. */
export const GHS_POP_OVERLAY = {
  id: 'ghs-pop',
  label: 'Population density (GHS-POP 2021)',
  url: 'https://s3.openlandmap.org/arco/pop.count_ghs.jrc_m_100m_s_20210101_20211231_go_epsg.4326_v20230620.tif',
  // Linear people/km²: 0 → transparent-ish, 5,000+ saturates (dense city).
  contrastLimits: [0, 5000],
  colormap: 'inferno',
  stretchMode: 'sqrt',
  opacity: 0.65,
};
