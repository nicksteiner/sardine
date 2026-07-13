import { Layer, project32 } from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/core';
import proj4 from 'proj4';
import {
  TILE_PX,
  proj4DefFor,
  isMercatorMappable,
  clampMercatorLat,
  lonLatToTilePx,
  tileRangeForLonLat,
  fitZoomToCaps,
  metersPerWorldUnit,
  detailZoomForView,
  worldRectToUV,
  uvRectToGeoBounds,
  padRect,
  wrapTileX,
} from '../utils/optical-peek-math.js';

/**
 * OpticalPeekLayer — Optical raster overlay rendered in the image CRS.
 *
 * Reuses the texture-with-UV-remap pattern from SARGPULayer's full-extent
 * phase corrections (uTexCorTropo / uTexCorSET / uTexCorRamp). Those work
 * because the correction is sampled at the tile's geographic position, not
 * its local UV — so the same shader machinery handles a raster that lives
 * in a different sampling space than the SAR tile.
 *
 * Two-level atlas (W026):
 *   BASE   — one scene-wide atlas at a zoom fitted to the tile caps. Built
 *            once per scene/provider. Guarantees coverage: panning never
 *            shows holes.
 *   DETAIL — a viewport-tracking atlas rebuilt on debounced viewport change
 *            at a zoom matched to screen pixel density (up to the provider's
 *            maxZoom, ~0.3 m/px at z19). A 1080p viewport is ~9×6 tiles, so
 *            provider max resolution costs ~10s of MB, not the ~10⁵ tiles a
 *            scene-wide atlas would need.
 *
 * Pipeline per level:
 *   1. CPU: lay an N×N grid over the geo bounds (image CRS). For each node,
 *      proj4 image-CRS → WGS84 → Web Mercator. Fetch the covering WMTS tiles
 *      (LRU-cached, overzoom parent-fill on 404) into an atlas canvas, bake
 *      a warp texture (RG32F, N×N) mapping grid-node geo position → atlas UV.
 *   2. GPU: fragment shader takes the layer-local UV, bilinearly interpolates
 *      the warp grid MANUALLY via texelFetch (float32 LINEAR filtering is an
 *      optional WebGL2 extension, and hardware filtering would blend the
 *      invalid-node sentinel into garbage UVs), then samples the atlas.
 *      Detail is tried first; base is the fallback.
 *
 * The grid resolves arbitrary CRSes without per-CRS shader code: the warp
 * lives in the UV-offset texture, baked on CPU per build.
 *
 * @example
 * new OpticalPeekLayer({
 *   id: 'optical-peek',
 *   bounds: imageBounds,           // [minX, minY, maxX, maxY] in image CRS
 *   crs: 'EPSG:32610',             // image CRS for inverse projection
 *   tileUrlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
 *   maxZoom: 19,
 *   opacity: 0.6,
 * });
 */

const GRID_SIZE_DEFAULT = 64;
const DETAIL_GRID_SIZE = 16;     // warp nodes over the (small) detail rect
const DETAIL_DEBOUNCE_MS = 250;  // settle time after viewport motion
const DETAIL_PAD = 0.25;         // pan headroom, fraction of span per side
const FETCH_CONCURRENCY = 12;    // parallel tile fetches (OSM policy friendly)
const OVERZOOM_LEVELS = 3;       // parent-tile fill depth on missing tiles
const TILE_CACHE_MAX = 384;      // LRU ImageBitmap entries (~100 MB ceiling)
const MAX_ZOOM_DEFAULT = 19;

const vs = `#version 300 es
#define SHADER_NAME optical-peek-vertex
in vec3 positions;
in vec2 texCoords;
out vec2 vTexCoord;
void main() {
  vec3 position64Low = vec3(0.0);
  vec3 offset = vec3(0.0);
  vec4 commonPosition;
  gl_Position = project_position_to_clipspace(positions, position64Low, offset, commonPosition);
  vTexCoord = texCoords;
}
`;

const fs = `#version 300 es
#define SHADER_NAME optical-peek-fragment
precision highp float;

uniform sampler2D uAtlas;        // base optical RGB atlas
uniform sampler2D uWarp;         // base warp: RG32F, N×N, geo → atlas UV
uniform sampler2D uAtlasDetail;  // viewport detail atlas (base when absent)
uniform sampler2D uWarpDetail;   // viewport detail warp  (base when absent)
uniform float uOpacity;
uniform float uGridSpan;         // base warp cell count (warpSize - 1)
uniform float uDetailGridSpan;
uniform vec4 uDetailRect;        // detail extent in layer UV [u0,v0,u1,v1]
uniform float uHasDetail;

in vec2 vTexCoord;
out vec4 fragColor;

// Manual bilinear over a VERTEX-aligned warp grid: node i holds the atlas-UV
// for local-UV i/gridSpan. texelFetch (not texture()) for two reasons:
//   1. RG32F LINEAR filtering needs OES_texture_float_linear — optional.
//   2. Hardware filtering would blend the (-1,-1) invalid-node sentinel
//      into neighbouring cells, producing positive-but-wrong UVs.
// Any cell touching an invalid node is rejected instead.
bool sampleWarp(sampler2D warpTex, vec2 uv, float gridSpan, out vec2 atlasUV) {
  vec2 g = clamp(uv, 0.0, 1.0) * gridSpan;
  vec2 g0 = min(floor(g), vec2(gridSpan - 1.0));
  vec2 f = g - g0;
  ivec2 i0 = ivec2(g0);
  vec2 w00 = texelFetch(warpTex, i0, 0).rg;
  vec2 w10 = texelFetch(warpTex, i0 + ivec2(1, 0), 0).rg;
  vec2 w01 = texelFetch(warpTex, i0 + ivec2(0, 1), 0).rg;
  vec2 w11 = texelFetch(warpTex, i0 + ivec2(1, 1), 0).rg;
  if (min(min(w00.x, w10.x), min(w01.x, w11.x)) < 0.0) return false;
  atlasUV = mix(mix(w00, w10, f.x), mix(w01, w11, f.x), f.y);
  return true;
}

void main() {
  vec2 atlasUV;
  if (uHasDetail > 0.5
      && all(greaterThanEqual(vTexCoord, uDetailRect.xy))
      && all(lessThanEqual(vTexCoord, uDetailRect.zw))) {
    vec2 duv = (vTexCoord - uDetailRect.xy) / (uDetailRect.zw - uDetailRect.xy);
    if (sampleWarp(uWarpDetail, duv, uDetailGridSpan, atlasUV)) {
      fragColor = vec4(texture(uAtlasDetail, atlasUV).rgb, uOpacity);
      return;
    }
  }
  if (!sampleWarp(uWarp, vTexCoord, uGridSpan, atlasUV)) {
    fragColor = vec4(0.0);
    return;
  }
  fragColor = vec4(texture(uAtlas, atlasUV).rgb, uOpacity);
}
`;

// ── Tile fetch: module-level LRU cache + in-flight dedupe ──────────────────
// Cache holds resolved ImageBitmaps (null = known-missing, so 404s at
// overzoom aren't re-hammered). Map iteration order gives LRU: refresh on
// hit, evict from the front. Eviction closes the bitmap — safe because a
// just-awaited bitmap is always at the tail.
const tileCache = new Map();     // url → ImageBitmap | null
const tilePending = new Map();   // url → Promise<ImageBitmap | null>

function tileUrl(template, z, x, y) {
  return template
    .replace('{z}', z)
    .replace('{x}', wrapTileX(x, z))
    .replace('{y}', y);
}

async function getTileBitmap(template, z, x, y, signal) {
  const n = 2 ** z;
  if (y < 0 || y >= n) return null;
  const url = tileUrl(template, z, x, y);

  if (tileCache.has(url)) {
    const bmp = tileCache.get(url);
    tileCache.delete(url);
    tileCache.set(url, bmp); // LRU refresh
    return bmp;
  }
  // Another build already fetching this tile: piggyback, but swallow its
  // abort — only the initiating build's signal may cancel a build.
  if (tilePending.has(url)) return tilePending.get(url).catch(() => null);

  const p = (async () => {
    const r = await fetch(url, { signal });
    const bmp = r.ok ? await createImageBitmap(await r.blob()) : null;
    tileCache.set(url, bmp);
    while (tileCache.size > TILE_CACHE_MAX) {
      const [oldUrl, oldBmp] = tileCache.entries().next().value;
      tileCache.delete(oldUrl);
      oldBmp?.close?.();
    }
    return bmp;
  })();
  tilePending.set(url, p);
  try {
    return await p;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return null; // network error: uncached, retried next build
  } finally {
    tilePending.delete(url);
  }
}

/**
 * Draw one z-level tile slot, falling back to an upscaled crop of a parent
 * tile (up to OVERZOOM_LEVELS) when the requested tile is missing. This is
 * what "max resolution" means where provider coverage varies: the finest
 * imagery that actually exists at that location, never a blank square.
 */
async function drawTileWithOverzoom(ctx, template, z, tx, ty, dx, dy, signal) {
  const maxUp = Math.min(OVERZOOM_LEVELS, z - 1);
  for (let up = 0; up <= maxUp; up++) {
    const bmp = await getTileBitmap(template, z - up, tx >> up, ty >> up, signal);
    if (!bmp) continue;
    const s = TILE_PX >> up;
    try {
      ctx.drawImage(bmp, (tx - ((tx >> up) << up)) * s, (ty - ((ty >> up) << up)) * s, s, s, dx, dy, TILE_PX, TILE_PX);
      return true;
    } catch {
      continue; // bitmap raced an eviction close — try the next level up
    }
  }
  return false;
}

/** Run fn over items with bounded concurrency. Rejects on first throw
 *  (used to propagate AbortError and stop the pool). */
async function mapPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/**
 * Build the warp + atlas for a geo-bounds rect at a given (or auto) zoom.
 *
 * Returns { warp: Float32Array(N*N*2), warpSize, atlas: canvas,
 *           atlasW, atlasH, z, tilesFetched }.
 *
 * The warp encodes each grid node's atlas-UV. Nodes that can't be mapped
 * onto Web Mercator (|lat| > 85.05°, polar-stereo scenes near the pole) or
 * that fall outside the fetched tile set are flagged with (-1, -1) — the
 * shader rejects any cell touching one, so no filtering ever mixes them in.
 */
async function buildPeek({ bounds, crs, tileUrlTemplate, gridSize, zoom, maxZoom = MAX_ZOOM_DEFAULT, signal }) {
  const def = proj4DefFor(crs);
  const [minX, minY, maxX, maxY] = bounds;

  // 1. Walk the grid in image CRS, inverse-project each node to lon/lat.
  // gridSize+1 nodes per axis so the grid spans 0..1 inclusive in layer UV.
  const N = gridSize + 1;
  const lonLat = new Float64Array(N * N * 2);
  const nodeOk = new Uint8Array(N * N);
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;

  for (let j = 0; j < N; j++) {
    // Layer UV.y = 0 is north (maxY), 1 is south (minY) — matches the
    // texCoord winding in SARGPULayer's full-extent correction sampling.
    const v = j / gridSize;
    const y = maxY - v * (maxY - minY);
    for (let i = 0; i < N; i++) {
      const u = i / gridSize;
      const x = minX + u * (maxX - minX);
      const [lon, lat] = def ? proj4(def, 'WGS84', [x, y]) : [x, y];
      const idx = (j * N + i) * 2;
      lonLat[idx] = lon;
      lonLat[idx + 1] = lat;
      const ok = isMercatorMappable(lon, lat);
      nodeOk[j * N + i] = ok ? 1 : 0;
      if (!ok) continue;
      const cl = clampMercatorLat(lat);
      if (lon < lonMin) lonMin = lon;
      if (lon > lonMax) lonMax = lon;
      if (cl < latMin) latMin = cl;
      if (cl > latMax) latMax = cl;
    }
  }
  if (!Number.isFinite(lonMin)) {
    throw new Error('OpticalPeek: scene has no Web Mercator coverage (beyond ±85.05° latitude)');
  }

  // 2. Pick the zoom. Auto (base) path: coarse "one tile covers the scene"
  // estimate + 4 levels (256× finer). Explicit (detail) path: the caller
  // computed it from screen density. Both are clamped to the provider's
  // maxZoom, then stepped DOWN until the tile range fits the atlas caps
  // (total-tile GPU backstop AND per-axis canvas-dimension limit) instead
  // of failing — a long-thin scene degrades gracefully.
  const ZOOM_BOOST = 4;
  const zAuto = Math.max(1, Math.floor(Math.log2(360 / Math.max(lonMax - lonMin, 0.0001)) + 1) + ZOOM_BOOST);
  const zWanted = Math.min(zoom ?? zAuto, maxZoom);
  const { zoom: z, range } = fitZoomToCaps({ lonMin, lonMax, latMin, latMax, zoom: zWanted });
  const { txMin, txMax, tyMin, tyMax, cols, rows } = range;

  const atlasW = cols * TILE_PX;
  const atlasH = rows * TILE_PX;

  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(atlasW, atlasH)
    : Object.assign(document.createElement('canvas'), { width: atlasW, height: atlasH });
  const ctx = canvas.getContext('2d');

  // 3. Fetch tiles through the LRU cache with a bounded worker pool.
  const jobs = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) jobs.push({ tx, ty });
  }
  await mapPool(jobs, FETCH_CONCURRENCY, ({ tx, ty }) =>
    drawTileWithOverzoom(ctx, tileUrlTemplate, z, tx, ty, (tx - txMin) * TILE_PX, (ty - tyMin) * TILE_PX, signal)
  );

  // 4. For each grid node, compute its UV inside the atlas.
  // UV = (pixel_in_atlas) / (atlas_size). Unmappable or out-of-range nodes
  // get the (-1,-1) sentinel (rejected per-cell in the shader).
  const warp = new Float32Array(N * N * 2);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const lon = lonLat[(j * N + i) * 2];
      const lat = lonLat[(j * N + i) * 2 + 1];
      const t = nodeOk[j * N + i] ? lonLatToTilePx(lon, lat, z) : null;
      const bad = !t || t.tileX < txMin || t.tileX > txMax || t.tileY < tyMin || t.tileY > tyMax;
      warp[(j * N + i) * 2] = bad ? -1 : ((t.tileX - txMin) * TILE_PX + t.pxX) / atlasW;
      warp[(j * N + i) * 2 + 1] = bad ? -1 : ((t.tileY - tyMin) * TILE_PX + t.pxY) / atlasH;
    }
  }

  return { warp, warpSize: N, atlas: canvas, atlasW, atlasH, z, tilesFetched: cols * rows };
}

export class OpticalPeekLayer extends Layer {
  getShaders() {
    return { vs, fs, modules: [project32] };
  }

  initializeState() {
    this.setState({ needsGeometryUpdate: true, buildToken: 0, detailToken: 0 });
  }

  getNumInstances() { return 0; }

  shouldUpdateState({ changeFlags }) {
    // somethingChanged includes viewportChanged — the detail atlas tracks
    // the viewport, so viewport-only updates must reach updateState.
    return changeFlags.somethingChanged;
  }

  updateState({ props, oldProps, changeFlags }) {
    const { gl } = this.context;
    const { bounds, crs, tileUrlTemplate, gridSize = GRID_SIZE_DEFAULT, opticalZoom, maxZoom } = props;

    // Build the quad geometry from bounds (same pattern as SARGPULayer).
    if (this.state.needsGeometryUpdate || bounds !== oldProps.bounds) {
      if (!bounds || bounds.length !== 4) return;
      const [minX, minY, maxX, maxY] = bounds;
      const positions = new Float32Array([
        minX, minY, 0,  maxX, minY, 0,  maxX, maxY, 0,
        minX, minY, 0,  maxX, maxY, 0,  minX, maxY, 0,
      ]);
      const texCoords = new Float32Array([
        0, 1,  1, 1,  1, 0,
        0, 1,  1, 0,  0, 0,
      ]);
      const geometry = new Geometry({
        topology: 'triangle-list',
        attributes: {
          positions: { size: 3, value: positions },
          texCoords: { size: 2, value: texCoords },
        },
      });

      if (this.state.model && !this.state.needsGeometryUpdate) {
        this.state.model.setGeometry(geometry);
      } else {
        if (this.state.model) this.state.model.delete();
        const model = new Model(gl, {
          ...this.getShaders(),
          geometry,
          parameters: {
            blend: true,
            blendFunc: [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA],
            depthTest: false,
          },
        });
        this.setState({ model, needsGeometryUpdate: false });
      }
    }

    // Rebuild atlas + warp when bounds/CRS/url/grid/zoom change.
    const triggersChanged =
      bounds !== oldProps.bounds ||
      props.geoBounds !== oldProps.geoBounds ||
      crs !== oldProps.crs ||
      tileUrlTemplate !== oldProps.tileUrlTemplate ||
      gridSize !== oldProps.gridSize ||
      opticalZoom !== oldProps.opticalZoom ||
      maxZoom !== oldProps.maxZoom;

    if (triggersChanged && bounds && tileUrlTemplate) {
      this._rebuild();
    } else if (changeFlags.viewportChanged) {
      this._scheduleDetail();
    }
  }

  /** Upload an atlas canvas (RGBA8) + warp array (RG32F) as GL textures. */
  _uploadTextures(result) {
    const { gl } = this.context;

    // CRITICAL: force UNPACK_FLIP_Y_WEBGL off. deck.gl/luma upload image
    // textures with FLIP_Y *on* by default and leave that state set on the
    // shared GL context. FLIP_Y is honoured for DOM/canvas sources (the
    // atlas) but IGNORED for ArrayBufferView sources (the warp, a
    // Float32Array). If we inherit a stale FLIP_Y=true, the atlas canvas
    // gets mirrored vertically while the warp does not — north ends up at
    // atlas v=1 but the warp still points at v=0, and the optical overlay
    // is mis-registered (sheared/offset against the SAR). Pinning it false
    // makes "memory row 0 == v==0" hold for both textures, matching how
    // buildPeek bakes atlasPxY (north → 0).
    const prevFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    const atlasTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, result.atlas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Warp as RG32F via raw WebGL2 (luma.gl wrapper is shaky for float
    // internal formats, same reason SARGPULayer does it by hand). NEAREST:
    // the shader texelFetches and interpolates manually — see fs comment.
    const warpTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, warpTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RG32F,
      result.warpSize, result.warpSize, 0,
      gl.RG, gl.FLOAT, result.warp,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Restore the context's FLIP_Y so later luma texture uploads behave.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, prevFlipY);

    return { atlasTex, warpTex };
  }

  _status(level, message) {
    if (typeof this.props.onStatus === 'function') this.props.onStatus(level, message);
  }

  async _rebuild() {
    const { gl } = this.context;
    const { bounds, geoBounds, crs, tileUrlTemplate, gridSize = GRID_SIZE_DEFAULT, opticalZoom, maxZoom = MAX_ZOOM_DEFAULT } = this.props;
    // `bounds` is the quad-geometry input (must match the SAR layer's coord
    // space — pixel-space for COG/NITF, geographic for NISAR GCOV).
    // `geoBounds` is the projection-math input — always the geographic
    // extent. They diverge for COG/NITF (loadLocalTIF puts pixel-space in
    // bounds, UTM in worldBounds); for NISAR they coincide and the caller
    // can omit geoBounds.
    const projBounds = geoBounds || bounds;

    // Cancel any in-flight build by bumping a token. Stale results check
    // their token against state.buildToken before committing.
    const token = (this.state.buildToken || 0) + 1;
    this.setState({ buildToken: token });
    if (this.state.abortCtrl) this.state.abortCtrl.abort();
    const abortCtrl = new AbortController();
    this.setState({ abortCtrl });

    // Scene/provider changed: whatever detail we have is stale.
    this._clearDetail();

    try {
      const result = await buildPeek({
        bounds: projBounds, crs, tileUrlTemplate, gridSize, zoom: opticalZoom, maxZoom,
        signal: abortCtrl.signal,
      });
      if (token !== this.state.buildToken) return; // stale

      const { atlasTex, warpTex } = this._uploadTextures(result);
      if (this.state.atlasTex) gl.deleteTexture(this.state.atlasTex);
      if (this.state.warpTex) gl.deleteTexture(this.state.warpTex);
      this.setState({ atlasTex, warpTex, warpSize: result.warpSize, baseZ: result.z });
      console.log(`[OpticalPeek] built base atlas: ${result.atlasW}×${result.atlasH} (z=${result.z}, ${result.tilesFetched} tiles), warp ${result.warpSize}²`);
      this._status('info', `Optical base z${result.z} (${result.tilesFetched} tiles)`);
      this.setNeedsRedraw('optical-peek rebuilt');

      // Refine immediately if the current view already out-resolves the base.
      this._scheduleDetail();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[OpticalPeek] build failed', err);
        this._status('error', `Optical peek failed: ${err.message}`);
      }
    }
  }

  // ── Detail (viewport-tracking) atlas ─────────────────────────────────────

  _scheduleDetail() {
    if (!this.props.tileUrlTemplate) return;
    // Direct state write (no setState): this runs on every pan/zoom frame.
    clearTimeout(this.state.detailTimer);
    this.state.detailTimer = setTimeout(() => this._rebuildDetail(), DETAIL_DEBOUNCE_MS);
  }

  _clearDetail() {
    const { gl } = this.context;
    clearTimeout(this.state.detailTimer);
    if (this.state.detailAbort) this.state.detailAbort.abort();
    const had = this.state.detailAtlasTex || this.state.detailWarpTex;
    if (this.state.detailAtlasTex) gl.deleteTexture(this.state.detailAtlasTex);
    if (this.state.detailWarpTex) gl.deleteTexture(this.state.detailWarpTex);
    this.setState({ detailAtlasTex: null, detailWarpTex: null, detailRect: null, detailKey: null });
    if (had) this.setNeedsRedraw('optical-peek detail cleared');
  }

  async _rebuildDetail() {
    const { gl, viewport } = this.context;
    const { bounds, geoBounds, crs, tileUrlTemplate, maxZoom = MAX_ZOOM_DEFAULT } = this.props;
    if (!bounds || !viewport || !this.state.atlasTex) return; // base first
    const projBounds = geoBounds || bounds;

    // Visible world rect ∩ scene bounds, padded for pan headroom.
    const vb = viewport.getBounds();
    const rect = [
      Math.max(vb[0], bounds[0]), Math.max(vb[1], bounds[1]),
      Math.min(vb[2], bounds[2]), Math.min(vb[3], bounds[3]),
    ];
    if (rect[0] >= rect[2] || rect[1] >= rect[3]) { this._clearDetail(); return; }
    const padded = padRect(rect, DETAIL_PAD, bounds);
    const uvRect = worldRectToUV(padded, bounds);
    const subGeo = uvRectToGeoBounds(uvRect, projBounds);

    // Zoom from screen density: OrthographicView screen px per world unit
    // is 2^viewport.zoom; convert world → ground meters via the geo/world
    // span ratio, then match Web Mercator resolution at the scene latitude.
    const def = proj4DefFor(crs);
    const cx = (subGeo[0] + subGeo[2]) / 2;
    const cy = (subGeo[1] + subGeo[3]) / 2;
    const [, latCenter] = def ? proj4(def, 'WGS84', [cx, cy]) : [cx, cy];
    if (!Number.isFinite(latCenter)) { this._clearDetail(); return; }
    const vzoom = Array.isArray(viewport.zoom) ? viewport.zoom[0] : viewport.zoom;
    const mpw = metersPerWorldUnit({ bounds, geoBounds: projBounds, isProjected: !!def, latCenterDeg: latCenter });
    const zDetail = detailZoomForView({ viewZoom: vzoom, metersPerWorld: mpw, latCenterDeg: latCenter, maxZoom });

    // Base already at or above screen resolution: no detail needed.
    if (zDetail <= (this.state.baseZ ?? 0)) { this._clearDetail(); return; }

    // Skip a rebuild that would reproduce what's already on screen.
    const key = `${zDetail}|${uvRect.map((v) => v.toFixed(4)).join(',')}|${tileUrlTemplate}`;
    if (key === this.state.detailKey) return;

    const detailToken = (this.state.detailToken || 0) + 1;
    const baseToken = this.state.buildToken;
    if (this.state.detailAbort) this.state.detailAbort.abort();
    const detailAbort = new AbortController();
    this.state.detailToken = detailToken;
    this.state.detailAbort = detailAbort;

    try {
      const result = await buildPeek({
        bounds: subGeo, crs, tileUrlTemplate, gridSize: DETAIL_GRID_SIZE,
        zoom: zDetail, maxZoom, signal: detailAbort.signal,
      });
      // Stale if another detail build started OR the base scene changed.
      if (detailToken !== this.state.detailToken || baseToken !== this.state.buildToken) return;

      const { atlasTex, warpTex } = this._uploadTextures(result);
      if (this.state.detailAtlasTex) gl.deleteTexture(this.state.detailAtlasTex);
      if (this.state.detailWarpTex) gl.deleteTexture(this.state.detailWarpTex);
      this.setState({
        detailAtlasTex: atlasTex,
        detailWarpTex: warpTex,
        detailWarpSize: result.warpSize,
        detailRect: uvRect,
        detailKey: key,
      });
      console.log(`[OpticalPeek] built detail atlas: ${result.atlasW}×${result.atlasH} (z=${result.z}, ${result.tilesFetched} tiles)`);
      this._status('info', `Optical detail z${result.z} (${result.tilesFetched} tiles)`);
      this.setNeedsRedraw('optical-peek detail rebuilt');
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[OpticalPeek] detail build failed', err);
        this._status('error', `Optical detail failed: ${err.message}`);
      }
    }
  }

  draw({ uniforms }) {
    const { model, atlasTex, warpTex, warpSize, detailAtlasTex, detailWarpTex, detailWarpSize, detailRect } = this.state;
    if (!model || !atlasTex || !warpTex) return;

    const { gl } = this.context;
    const { opacity = 0.7 } = this.props;
    const hasDetail = !!(detailAtlasTex && detailWarpTex && detailRect);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, warpTex);
    // Samplers must always have a bound texture; fall back to base units.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, hasDetail ? detailAtlasTex : atlasTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, hasDetail ? detailWarpTex : warpTex);

    model.setUniforms({
      ...uniforms,
      uAtlas: 0,
      uWarp: 1,
      uAtlasDetail: 2,
      uWarpDetail: 3,
      uOpacity: opacity,
      uGridSpan: warpSize - 1,
      uDetailGridSpan: hasDetail ? detailWarpSize - 1 : 1,
      uDetailRect: hasDetail ? detailRect : [0, 0, 0, 0],
      uHasDetail: hasDetail ? 1 : 0,
    });
    model.draw();

    for (let unit = 3; unit >= 0; unit--) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  finalizeState() {
    super.finalizeState();
    const { gl } = this.context;
    clearTimeout(this.state.detailTimer);
    if (this.state.abortCtrl) this.state.abortCtrl.abort();
    if (this.state.detailAbort) this.state.detailAbort.abort();
    if (this.state.model) this.state.model.delete();
    if (gl) {
      if (this.state.atlasTex) gl.deleteTexture(this.state.atlasTex);
      if (this.state.warpTex) gl.deleteTexture(this.state.warpTex);
      if (this.state.detailAtlasTex) gl.deleteTexture(this.state.detailAtlasTex);
      if (this.state.detailWarpTex) gl.deleteTexture(this.state.detailWarpTex);
    }
  }
}

OpticalPeekLayer.layerName = 'OpticalPeekLayer';
OpticalPeekLayer.defaultProps = {
  bounds: { type: 'array', value: null, compare: true },
  geoBounds: { type: 'array', value: null, compare: true },
  crs: { type: 'string', value: 'EPSG:4326', compare: true },
  tileUrlTemplate: { type: 'string', value: '', compare: true },
  gridSize: { type: 'number', value: GRID_SIZE_DEFAULT, min: 8, max: 256, compare: true },
  opticalZoom: { type: 'number', value: null, compare: true },
  maxZoom: { type: 'number', value: MAX_ZOOM_DEFAULT, min: 1, max: 23, compare: true },
  opacity: { type: 'number', value: 0.7, min: 0, max: 1, compare: true },
  onStatus: { type: 'function', value: null, compare: false, optional: true },
};
