/**
 * reproject-tiles.js — draw a projected raster on a Web Mercator map (W033).
 *
 * The map's TileLayer hands us tiles in lon/lat. For each one we project a
 * small grid of its vertices into the image CRS (proj4), find the image pixel
 * window those vertices cover, read that window as a 256² texture through the
 * scene's existing `getTile` (pixel-space bbox, Y up), and return the texture
 * together with a mesh: the grid vertices as positions in lon/lat and the
 * per-vertex image position as texCoords. SARGPULayer draws the texture
 * through the mesh, so the GPU does the warp and the source pixels are never
 * resampled on the CPU — the same idea as deck.gl-raster's reprojection, done
 * inversely per map tile rather than forward over the whole image.
 */
import proj4 from 'proj4';
import { getProj4Def, projectedToWGS84 } from '../loaders/overture-loader.js';
import { debugLog } from './debug-log.js';

/**
 * @param {Object} opts
 * @param {Function} opts.getTile - scene getTile({ bbox: {left,right,top,bottom} })
 *   in pixel-world coords (Y up: world Y = height − row), returning
 *   {data,width,height} or {bands,width,height,compositeId}.
 * @param {number} opts.width - image width in pixels
 * @param {number} opts.height - image height in pixels
 * @param {number[]} opts.worldBounds - [minX, minY, maxX, maxY] in the image CRS
 * @param {string} opts.crs - 'EPSG:xxxx'
 * @param {number} [opts.segments=8] - mesh grid segments per tile side
 * @param {'pixel'|'world'} [opts.bboxSpace='pixel'] - coordinate space the
 *   scene's getTile expects in `bbox`: pixel-world (COG, streamed GCOV) or the
 *   image CRS itself (NISAR RGB composites, whose `bounds` are worldBounds).
 * @returns {{ extent: number[], getTileData: Function }} lon/lat extent for the
 *   TileLayer and a getTileData(tile) for deck.gl's TileLayer in a MapView.
 */
export function createReprojectedTileFetcher({ getTile, width, height, worldBounds, crs, segments = 8, bboxSpace = 'pixel' }) {
  const projDef = getProj4Def(crs);
  const forward = projDef
    ? proj4('WGS84', projDef).forward
    : ([lon, lat]) => [lon, lat];

  const [minX, minY, maxX, maxY] = worldBounds;
  const sx = width / (maxX - minX);
  const sy = height / (maxY - minY);
  const extent = projectedToWGS84(worldBounds, crs);

  const n = segments + 1;
  // Index buffer is identical for every tile.
  const indices = new Uint16Array(segments * segments * 6);
  for (let j = 0, k = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      indices[k++] = a; indices[k++] = b; indices[k++] = c;
      indices[k++] = b; indices[k++] = d; indices[k++] = c;
    }
  }

  async function getTileData(tile) {
    const { west, south, east, north } = tile.bbox;
    const positions = new Float32Array(n * n * 3);
    const cols = new Float64Array(n * n);
    const rows = new Float64Array(n * n);
    let cMin = Infinity, cMax = -Infinity, rMin = Infinity, rMax = -Infinity;
    for (let j = 0; j < n; j++) {
      const lat = north + (south - north) * (j / segments); // row 0 = north (texture top)
      for (let i = 0; i < n; i++) {
        const lon = west + (east - west) * (i / segments);
        const v = j * n + i;
        positions[v * 3] = lon;
        positions[v * 3 + 1] = lat;
        const [x, y] = forward([lon, lat]);
        const col = (x - minX) * sx;
        const row = (maxY - y) * sy;
        cols[v] = col; rows[v] = row;
        if (Number.isFinite(col) && Number.isFinite(row)) {
          if (col < cMin) cMin = col; if (col > cMax) cMax = col;
          if (row < rMin) rMin = row; if (row > rMax) rMax = row;
        }
      }
    }
    if (!Number.isFinite(cMin) || !Number.isFinite(rMin)) return null;

    // Integer pixel window, clamped to the image; the loaders floor/ceil the
    // bbox themselves, so integers keep our texCoords exact.
    const pl = Math.max(0, Math.floor(cMin));
    const pr = Math.min(width, Math.ceil(cMax));
    const pt = Math.max(0, Math.floor(rMin));
    const pb = Math.min(height, Math.ceil(rMax));
    if (pr <= pl || pb <= pt) return null;

    // deck's OrthographicView hands loaders bboxes with top < bottom
    // numerically (screen-down Y); the NISAR loaders rely on that ordering
    // (pxTop comes from bbox.bottom) while the COG loaders min/max it. Keep
    // the same ordering here.
    const bbox = bboxSpace === 'world'
      ? { left: minX + pl / sx, right: minX + pr / sx, top: maxY - pb / sy, bottom: maxY - pt / sy }
      : { left: pl, right: pr, top: height - pb, bottom: height - pt };
    // x/y/z ride along so loaders that key their tile caches by index
    // (streamed GCOV) see one key per map tile.
    const { x, y, z } = tile.index || {};
    let tileData;
    try {
      tileData = await getTile({ x, y, z, bbox });
    } catch (e) {
      console.warn(`[reproject-tiles] tile ${z}/${x}/${y} failed:`, e?.message || e);
      throw e;
    }
    debugLog(`[reproject-tiles] ${z}/${x}/${y} px[${pl},${pt},${pr},${pb}] → ${tileData ? `${tileData.width}x${tileData.height}` : 'null'}`);
    if (!tileData) return null;

    const texCoords = new Float32Array(n * n * 2);
    for (let v = 0; v < n * n; v++) {
      texCoords[v * 2] = (cols[v] - pl) / (pr - pl);
      texCoords[v * 2 + 1] = (rows[v] - pt) / (pb - pt);
    }
    tileData._mesh = { positions, texCoords, indices };
    return tileData;
  }

  return { extent, getTileData };
}
