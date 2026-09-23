/**
 * GDAL Virtual Raster (.vrt) loader.
 *
 * Streams a VRT lazily: nothing is read at load time except the XML (and
 * the headers of any source whose rectangles the XML leaves implicit).
 * Each tile / export stripe / pixel read finds the sources overlapping the
 * requested window, reads just that window from each (picking the source's
 * own overview for the output resolution), and composites them in document
 * order — later sources paint over earlier ones, skipping nodata, which is
 * GDAL's VRT semantics.
 *
 * Single band: returns the same shape as loadLocalTIF (pixel-space bounds,
 * bbox-driven getTile), so rendering, export, ROI and profile code need no
 * changes. Band stack (`gdalbuildvrt -separate hh.tif hv.tif`) with
 * { composite }: returns loadCOGRGBComposite's shape (getRGBTile tiles
 * carrying {bands: {POL: Float32Array}}, per-band bandStats).
 *
 * Sampling is nearest-neighbour from the chosen overview level, matching
 * GDAL's default VRT resampling; at 1:1 (exports) it is exact.
 */

import { fromUrl, fromBlob } from 'geotiff';
import { normalizeS3Url } from '../utils/s3-url.js';
import { debugLog } from '../utils/debug-log.js';
import { powerBandStats } from '../utils/stats.js';
import { autoSelectComposite, getRequiredDatasets } from '../utils/sar-composites.js';
import { parseVRT, resolveVrtSourcePath } from './vrt-parser.js';

const TILE_SIZE = 256;

const POL_PAIRS = { HH: 'HHHH', HV: 'HVHV', VH: 'VHVH', VV: 'VVVV' };

/**
 * Covariance-term name ('HHHH', 'HVHV', 'VHVH', 'VVVV') from a band
 * description or a source filename: "HH", "hv", "HHHH", "scene_VV.tif",
 * "pacaya_full_hh.tif". The last polarization token wins (product names put
 * it at the end). Off-diagonal terms like "HHVV" return null.
 *
 * @param {string|null} text
 * @returns {string|null}
 */
export function polarizationFromName(text) {
  if (!text) return null;
  const base = String(text).split(/[?#]/)[0].split(/[/\\]/).pop().replace(/\.[a-z0-9]+$/i, '');
  const re = /(?:^|[^A-Za-z])(HH|HV|VH|VV)(HH|HV|VH|VV)?(?![A-Za-z])/gi;
  let last = null, m;
  while ((m = re.exec(base)) !== null) last = m;
  if (!last) return null;
  const a = last[1].toUpperCase();
  const b = last[2]?.toUpperCase();
  if (b && b !== a) return null;
  return POL_PAIRS[a];
}

/** A band's polarization: its <Description>, else its sources' filenames if they agree. */
function bandPolarization(band) {
  const fromDesc = polarizationFromName(band.description);
  if (fromDesc) return fromDesc;
  const pols = new Set(band.sources.map(s => polarizationFromName(s.filename)));
  return pols.size === 1 ? [...pols][0] : null;
}

/**
 * @param {string|File} input  Un-proxied VRT URL, or a local VRT File.
 * @param {Object} [options]
 * @param {File[]} [options.files]  Companion source files for a local VRT,
 *   matched to SourceFilename by basename.
 * @param {(url: string) => string} [options.resolveUrl]  Rewrites every
 *   fetched URL (the VRT and each source) — pass the CORS/auth proxy here.
 *   Relative sources resolve against the raw VRT URL BEFORE this runs.
 * @param {number} [options.band=1]  1-based VRT band to serve (single-band mode).
 * @param {string|null} [options.composite=null]  'auto' to open a band stack
 *   as an RGB composite when its band polarizations support one (falls back
 *   to single-band otherwise), or a SAR_COMPOSITES id to require one.
 * @param {number} [options.maxSourcesPerTile=256]  A map tile overlapping
 *   more sources than this renders blank rather than issuing hundreds of
 *   requests (a zoomed-out view of a big mosaic). Exports are not capped.
 * @param {number} [options.maxOpenSources=64]  LRU size for open source files.
 * @param {number} [options.concurrency=6]  Parallel source reads per window.
 * @param {Function} [options.onProgress]  (0–100)
 * @returns {Promise<Object>} loadLocalTIF-shaped source, or
 *   loadCOGRGBComposite-shaped when a composite was opened (`.composite` set)
 */
export async function loadVRT(input, options = {}) {
  const {
    files = [],
    resolveUrl = (u) => u,
    band: bandNumber = 1,
    composite = null,
    maxSourcesPerTile = 256,
    maxOpenSources = 64,
    concurrency = 6,
    onProgress,
  } = options;
  const progress = onProgress || (() => {});

  const isUrl = typeof input === 'string';
  // s3:// → https first: it is both what we fetch and what relative sources resolve against
  const baseUrl = isUrl ? normalizeS3Url(input) : null;
  const displayName = isUrl ? input.split(/[?#]/)[0].split('/').pop() || input : input.name;

  progress(5);
  let xml;
  if (isUrl) {
    const resp = await fetch(resolveUrl(baseUrl));
    if (!resp.ok) throw new Error(`VRT fetch failed: HTTP ${resp.status} ${resp.statusText}`);
    xml = await resp.text();
  } else {
    xml = await input.text();
  }
  const vrt = parseVRT(xml);
  progress(20);

  const { width, height } = vrt;
  const bandByNumber = (n) => vrt.bands.find(b => b.band === n) || vrt.bands[n - 1];
  const bandPolarizations = vrt.bands.map(bandPolarization);

  // ── Source opening (lazy, LRU, shared by all bands) ─────────────────
  const byName = new Map();
  for (const f of files) {
    byName.set(f.name, f);
    if (!byName.has(f.name.toLowerCase())) byName.set(f.name.toLowerCase(), f);
  }

  function locate(src) {
    const loc = resolveVrtSourcePath(src.filename, src.relativeToVRT, baseUrl);
    if (loc.kind === 'url') return { key: loc.url, url: loc.url };
    const file = byName.get(loc.name) || byName.get(loc.name.toLowerCase());
    if (!file) {
      throw new Error(`VRT source "${loc.path}" not found — drop it together with ${displayName}`);
    }
    return { key: `file:${loc.name}`, file };
  }

  const open = new Map(); // key → Promise<{images: [{img, w, h}]}>
  async function openSource(loc) {
    let p = open.get(loc.key);
    if (p) {
      open.delete(loc.key); // refresh LRU position
      open.set(loc.key, p);
      return p;
    }
    p = (async () => {
      const tiff = loc.file
        ? await fromBlob(loc.file)
        : await fromUrl(resolveUrl(normalizeS3Url(loc.url)));
      const n = await tiff.getImageCount();
      const images = [];
      for (let i = 0; i < n; i++) {
        const img = await tiff.getImage(i);
        // GDAL COGs interleave internal mask IFDs (NewSubfileType bit 2)
        if ((img.getFileDirectory().NewSubfileType || 0) & 4) continue;
        images.push({ img, w: img.getWidth(), h: img.getHeight() });
      }
      return { images };
    })();
    open.set(loc.key, p);
    p.catch(() => open.delete(loc.key)); // let a transient failure retry
    while (open.size > maxOpenSources) open.delete(open.keys().next().value);
    return p;
  }

  async function mapLimit(items, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return out;
  }

  // ── Per-band reader ─────────────────────────────────────────────────

  async function makeBandReader(band) {
    if (!band) throw new Error(`VRT has no such band (has ${vrt.bands.length})`);
    if (band.sources.length === 0) throw new Error(`VRT band ${band.band} has no sources`);

    // Resolve every source's location up front so a missing companion file
    // or unsupported path fails the load, not the first tile.
    const sources = band.sources.map(s => ({ ...s, loc: locate(s) }));

    // SrcRect/DstRect are optional in the format; when absent they default
    // to the source's full extent placed at the origin. Needs the header.
    for (const s of sources) {
      if (s.srcRect && s.dstRect) continue;
      const { images } = await openSource(s.loc);
      const full = { x: 0, y: 0, w: images[0].w, h: images[0].h };
      s.srcRect = s.srcRect || full;
      s.dstRect = s.dstRect || { x: 0, y: 0, w: s.srcRect.w, h: s.srcRect.h };
    }

    function intersecting(x0, y0, x1, y1) {
      return sources.filter(s => {
        const d = s.dstRect;
        return d.x < x1 && d.x + d.w > x0 && d.y < y1 && d.y + d.h > y0;
      });
    }

    /**
     * Read the VRT-pixel window [x0,x1)×[y0,y1) resampled to outW×outH.
     * Output pixel (ox, oy) samples the VRT at its centre. Uncovered pixels
     * and nodata are NaN.
     */
    async function readWindow(x0, y0, x1, y1, outW, outH, { srcList } = {}) {
      const out = new Float32Array(outW * outH).fill(NaN);
      const sx = (x1 - x0) / outW;
      const sy = (y1 - y0) / outH;
      const list = srcList || intersecting(x0, y0, x1, y1);

      const reads = await mapLimit(list, async (s) => {
        const d = s.dstRect, r = s.srcRect;
        // Output pixels whose centres fall inside this source's DstRect
        const ox0 = Math.max(0, Math.ceil((d.x - x0) / sx - 0.5));
        const ox1 = Math.min(outW, Math.ceil((d.x + d.w - x0) / sx - 0.5));
        const oy0 = Math.max(0, Math.ceil((d.y - y0) / sy - 0.5));
        const oy1 = Math.min(outH, Math.ceil((d.y + d.h - y0) / sy - 0.5));
        if (ox0 >= ox1 || oy0 >= oy1) return null;

        const kx = r.w / d.w, ky = r.h / d.h;
        const srcX = (ox) => r.x + (x0 + (ox + 0.5) * sx - d.x) * kx;
        const srcY = (oy) => r.y + (y0 + (oy + 0.5) * sy - d.y) * ky;

        // Coarsest overview that still has ≥1 pixel per output pixel
        const { images } = await openSource(s.loc);
        const fullW = images[0].w, fullH = images[0].h;
        const stepX = sx * kx, stepY = sy * ky;
        let level = images[0];
        for (const im of images) {
          if (fullW / im.w <= stepX * 1.0001 && fullH / im.h <= stepY * 1.0001) level = im;
        }
        const fx = fullW / level.w, fy = fullH / level.h;
        const clampX = (v) => Math.min(level.w - 1, Math.max(0, v));
        const clampY = (v) => Math.min(level.h - 1, Math.max(0, v));
        const wx0 = clampX(Math.floor(srcX(ox0) / fx));
        const wx1 = clampX(Math.floor(srcX(ox1 - 1) / fx)) + 1;
        const wy0 = clampY(Math.floor(srcY(oy0) / fy));
        const wy1 = clampY(Math.floor(srcY(oy1 - 1) / fy)) + 1;

        const rasters = await level.img.readRasters({
          window: [wx0, wy0, wx1, wy1],
          samples: [s.sourceBand - 1],
        });
        return { s, data: rasters[0], ww: wx1 - wx0, wx0, wy0, fx, fy, ox0, ox1, oy0, oy1, srcX, srcY, clampX, clampY };
      });

      // Paint in document order: later sources win, nodata is transparent
      for (const rd of reads) {
        if (!rd) continue;
        const { s, data, ww, wx0, wy0, fx, fy, srcX, srcY, clampX, clampY } = rd;
        const nd = s.nodata; // NaN nodata needs no test — NaN is always skipped
        const ratio = s.scaleRatio, offset = s.scaleOffset;
        const cols = new Int32Array(rd.ox1 - rd.ox0);
        for (let ox = rd.ox0; ox < rd.ox1; ox++) cols[ox - rd.ox0] = clampX(Math.floor(srcX(ox) / fx)) - wx0;
        for (let oy = rd.oy0; oy < rd.oy1; oy++) {
          const row = (clampY(Math.floor(srcY(oy) / fy)) - wy0) * ww;
          const o = oy * outW;
          for (let i = 0; i < cols.length; i++) {
            const v = data[row + cols[i]];
            if (Number.isNaN(v) || v === nd) continue;
            out[o + rd.ox0 + i] = v * ratio + offset;
          }
        }
      }

      const bnd = band.nodata;
      if (bnd !== null && !Number.isNaN(bnd)) {
        for (let i = 0; i < out.length; i++) if (out[i] === bnd) out[i] = NaN;
      }
      return out;
    }

    /** Whole-scene read at ≤maxSize on the long side — for auto-contrast. */
    async function readPreview(maxSize = 512) {
      const scale = Math.min(1, maxSize / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      return { data: await readWindow(0, 0, width, height, w, h), width: w, height: h };
    }

    return { band, sources, intersecting, readWindow, readPreview };
  }

  // ── Shared accessor helpers ─────────────────────────────────────────

  // OrthographicView: world Y=0 is the bottom of the image, pixel row 0 the
  // top — same mapping as loadLocalTIF's getTile.
  function tileWindow({ x, y, z, bbox }) {
    let wxMin, wxMax, wyMin, wyMax;
    if (bbox && bbox.left !== undefined) {
      wxMin = Math.min(bbox.left, bbox.right);
      wxMax = Math.max(bbox.left, bbox.right);
      wyMin = Math.min(bbox.top, bbox.bottom);
      wyMax = Math.max(bbox.top, bbox.bottom);
    } else {
      const worldSize = TILE_SIZE / Math.pow(2, z);
      wxMin = x * worldSize; wxMax = wxMin + worldSize;
      wyMin = y * worldSize; wyMax = wyMin + worldSize;
    }
    const pxLeft = Math.max(0, Math.floor(wxMin));
    const pxRight = Math.min(width, Math.ceil(wxMax));
    const pxTop = Math.max(0, Math.floor(height - wyMax));
    const pxBottom = Math.min(height, Math.ceil(height - wyMin));
    if (pxLeft >= pxRight || pxTop >= pxBottom) return null;
    return [pxLeft, pxTop, pxRight, pxBottom];
  }

  let warnedTileCap = false;
  function overTileCap(n) {
    if (n <= maxSourcesPerTile) return false;
    if (!warnedTileCap) {
      console.warn(`[VRT] A tile overlaps ${n} sources (cap ${maxSourcesPerTile}) — zoom in to render this area`);
      warnedTileCap = true;
    }
    return true;
  }

  /** Full-res read of an export window, ml×ml box-averaged (NaN/0 excluded). */
  async function readExportStripe(reader, { startRow, numRows, ml, exportWidth, startCol = 0, numCols }) {
    const outCols = numCols || exportWidth;
    const out = new Float32Array(outCols * numRows).fill(NaN);
    const c0 = startCol * ml, r0 = startRow * ml;
    const c1 = Math.min(width, (startCol + outCols) * ml);
    const r1 = Math.min(height, (startRow + numRows) * ml);
    const srcW = c1 - c0, srcH = r1 - r0;
    if (srcW <= 0 || srcH <= 0) return out;

    const src = await reader.readWindow(c0, r0, c1, r1, srcW, srcH);
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < outCols; c++) {
        let sum = 0, cnt = 0;
        for (let dr = 0; dr < ml && r * ml + dr < srcH; dr++) {
          const rowOff = (r * ml + dr) * srcW;
          for (let dc = 0; dc < ml && c * ml + dc < srcW; dc++) {
            const v = src[rowOff + c * ml + dc];
            if (!Number.isNaN(v) && v !== 0) { sum += v; cnt++; }
          }
        }
        if (cnt > 0) out[r * outCols + c] = sum / cnt;
      }
    }
    return out;
  }

  // ── Georeferencing ──────────────────────────────────────────────────
  let geoBounds = [0, 0, width, height];
  let resolution = null;
  let pixelSpacing = null;
  const gt = vrt.geoTransform;
  if (gt) {
    if (gt[2] !== 0 || gt[4] !== 0) {
      console.warn('[VRT] Rotated GeoTransform — rotation terms ignored');
    }
    const xa = gt[0], xb = gt[0] + width * gt[1];
    const ya = gt[3], yb = gt[3] + height * gt[5];
    geoBounds = [Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb)];
    resolution = [gt[1], gt[5]];
    pixelSpacing = { x: Math.abs(gt[1]), y: Math.abs(gt[5]) };
  }
  const crs = vrt.crs || 'EPSG:4326';
  if (!vrt.crs && vrt.srs) console.warn('[VRT] Could not find an EPSG code in the VRT SRS; assuming EPSG:4326');

  // ── Composite selection ─────────────────────────────────────────────
  let compositeId = null;
  let polBands = null; // [{pol, band}] in the composite's required order
  if (composite) {
    const firstBandFor = (pol) => vrt.bands[bandPolarizations.indexOf(pol)];
    const available = [...new Set(bandPolarizations.filter(Boolean))].map(p => ({ polarization: p }));
    const id = composite === 'auto' ? autoSelectComposite(available) : composite;
    if (id) {
      const required = getRequiredDatasets(id);
      const missing = required.filter(p => !bandPolarizations.includes(p));
      if (required.length === 0 || missing.length > 0) {
        if (composite !== 'auto') {
          throw new Error(`VRT cannot form composite '${id}': no band for ${missing.join(', ') || 'its inputs'}`
            + ` (band polarizations: ${bandPolarizations.map(p => p || '?').join(', ')})`);
        }
      } else {
        compositeId = id;
        polBands = required.map(pol => ({ pol, band: firstBandFor(pol) }));
      }
    }
  }

  const common = {
    format: 'vrt',
    bounds: [0, 0, width, height],
    geoBounds,
    worldBounds: geoBounds,
    crs,
    width,
    height,
    sourceWidth: width,
    sourceHeight: height,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    resolution,
    pixelSpacing,
    isCOG: true, // tiles stream on demand, like a COG
    imageCount: 1,
    colorTable: null,
    classNames: null,
    isCategorical: false,
  };
  const vrtMeta = (extra) => ({
    name: displayName,
    bandCount: vrt.bands.length,
    bandDescriptions: vrt.bands.map(b => b.description),
    bandPolarizations,
    ...extra,
  });

  // ── Composite (band stack) ──────────────────────────────────────────
  if (compositeId) {
    const readers = await Promise.all(polBands.map(({ band }) => makeBandReader(band)));
    const polNames = polBands.map(p => p.pol);
    progress(60);

    async function getRGBTile(req = {}) {
      try {
        const win = tileWindow(req);
        if (!win) return null;
        const lists = readers.map(r => r.intersecting(...win));
        if (lists.every(l => l.length === 0)) return null;
        if (overTileCap(Math.max(...lists.map(l => l.length)))) return null;
        const datas = await Promise.all(readers.map((r, i) =>
          r.readWindow(...win, TILE_SIZE, TILE_SIZE, { srcList: lists[i] })));
        const bands = {};
        polNames.forEach((pol, i) => { bands[pol] = datas[i]; });
        return { bands, width: TILE_SIZE, height: TILE_SIZE, compositeId };
      } catch (error) {
        console.error(`[VRT] RGB tile error x:${req.x} y:${req.y} z:${req.z}:`, error);
        return null;
      }
    }

    async function getExportStripe(params) {
      const outCols = params.numCols || params.exportWidth;
      const outs = await Promise.all(readers.map(r => readExportStripe(r, params)));
      const bands = {};
      polNames.forEach((pol, i) => { bands[pol] = outs[i]; });
      return { bands, width: outCols, height: params.numRows };
    }

    async function getPixelValue(row, col) {
      if (row < 0 || row >= height || col < 0 || col >= width) return NaN;
      return (await readers[0].readWindow(col, row, col + 1, row + 1, 1, 1))[0];
    }

    // Per-band stats from one decimated whole-scene read each — enough for
    // the app's mean±2σ initial per-channel contrast. Skipped for mosaics
    // past the tile cap (that read would touch every source).
    const bandStats = {};
    await Promise.all(readers.map(async (r, i) => {
      if (r.sources.length > maxSourcesPerTile) return;
      try {
        const stats = powerBandStats((await r.readPreview(512)).data);
        if (stats) bandStats[polNames[i]] = stats;
      } catch (e) {
        console.warn(`[VRT] stats sample failed for ${polNames[i]}:`, e.message);
      }
    }));

    progress(100);
    debugLog(`[VRT] ${displayName}: ${width}x${height} composite ${compositeId} from bands `
      + polBands.map(p => `${p.pol}=${p.band.band}`).join(', ') + `, crs=${crs}`);

    return {
      ...common,
      getRGBTile,
      getTile: getRGBTile,
      getExportStripe,
      getPixelValue,
      nodata: null,
      composite: compositeId,
      requiredPols: polNames,
      bandStats,
      mode: 'streaming',
      vrt: vrtMeta({
        bandMap: Object.fromEntries(polBands.map(p => [p.pol, p.band.band])),
        sourceCount: readers.reduce((n, r) => n + r.sources.length, 0),
      }),
    };
  }

  // ── Single band ─────────────────────────────────────────────────────
  const reader = await makeBandReader(bandByNumber(bandNumber));
  const { band } = reader;
  progress(60);

  async function getTile(req) {
    try {
      const win = tileWindow(req);
      if (!win) return null;
      const srcList = reader.intersecting(...win);
      if (srcList.length === 0 || overTileCap(srcList.length)) return null;
      const data = await reader.readWindow(...win, TILE_SIZE, TILE_SIZE, { srcList });
      return { data, width: TILE_SIZE, height: TILE_SIZE };
    } catch (error) {
      console.error(`[VRT] Tile error x:${req.x} y:${req.y} z:${req.z}:`, error);
      return null;
    }
  }

  async function getExportStripe(params) {
    return { bands: { band0: await readExportStripe(reader, params) } };
  }

  async function getPixelValue(row, col) {
    if (row < 0 || row >= height || col < 0 || col >= width) return NaN;
    return (await reader.readWindow(col, row, col + 1, row + 1, 1, 1))[0];
  }

  progress(100);
  debugLog(`[VRT] ${displayName}: ${width}x${height}, ${vrt.bands.length} band(s), `
    + `${reader.sources.length} source(s) in band ${band.band}, crs=${crs}`);

  return {
    ...common,
    getTile,
    getExportStripe,
    getPixelValue,
    readWindow: reader.readWindow,
    readPreview: reader.readPreview,
    nodata: band.nodata !== null && !Number.isNaN(band.nodata) ? band.nodata : null,
    vrt: vrtMeta({ band: band.band, sourceCount: reader.sources.length }),
  };
}

/** True for a URL or filename ending in .vrt (query/fragment ignored). */
export function isVRTPath(nameOrUrl) {
  return /\.vrt$/i.test(String(nameOrUrl || '').split(/[?#]/)[0]);
}
