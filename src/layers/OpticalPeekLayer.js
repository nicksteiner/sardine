import { Layer, project32, picking } from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/core';
import proj4 from 'proj4';

/**
 * OpticalPeekLayer — Optical raster overlay rendered in the image CRS.
 *
 * Reuses the texture-with-UV-remap pattern from SARGPULayer's full-extent
 * phase corrections (uTexCorTropo / uTexCorSET / uTexCorRamp). Those work
 * because the correction is sampled at the tile's geographic position, not
 * its local UV — so the same shader machinery handles a raster that lives
 * in a different sampling space than the SAR tile.
 *
 * Pipeline:
 *   1. CPU: lay an N×N grid over imageBounds (in image CRS). For each node,
 *      proj4 image-CRS → WGS84 → Web Mercator. Compute which WMTS tiles to
 *      fetch, build an atlas RGB texture, build a UV-offset texture
 *      (RG, N×N) that maps grid-node geo position → atlas UV.
 *   2. GPU: vertex shader emits the image-CRS quad. Fragment shader takes
 *      its local UV, maps to geo via uImageBounds, samples the UV-offset
 *      grid bilinearly, then samples the atlas at the resulting UV.
 *
 * The grid resolves arbitrary CRSes without per-CRS shader code: the warp
 * lives in the UV-offset texture, baked once on CPU per viewport.
 *
 * @example
 * new OpticalPeekLayer({
 *   id: 'optical-peek',
 *   bounds: imageBounds,           // [minX, minY, maxX, maxY] in image CRS
 *   crs: 'EPSG:32610',             // image CRS for inverse projection
 *   tileUrlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
 *   gridSize: 64,
 *   opticalZoom: 12,
 *   opacity: 0.6,
 * });
 */

const GRID_SIZE_DEFAULT = 64;
const TILE_PX = 256;

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

uniform sampler2D uAtlas;       // optical RGB atlas (Web Mercator tiles stitched)
uniform sampler2D uWarp;        // RG32F, N×N, baked image-CRS→atlas-UV mapping
uniform vec4 uImageBounds;      // [minX, minY, maxX, maxY] in image CRS
uniform float uOpacity;

in vec2 vTexCoord;
out vec4 fragColor;

void main() {
  // vTexCoord is the layer-local UV (0..1) over the image bounds.
  // The warp texture is sampled at the *same* UV — GPU bilinear interpolation
  // between the precomputed grid nodes gives a smooth atlas-UV per fragment.
  vec2 atlasUV = texture(uWarp, vTexCoord).rg;

  // Out-of-atlas marker: CPU encodes "no data" as negative UV.
  if (atlasUV.x < 0.0 || atlasUV.y < 0.0) {
    fragColor = vec4(0.0);
    return;
  }

  vec3 rgb = texture(uAtlas, atlasUV).rgb;
  fragColor = vec4(rgb, uOpacity);
}
`;

// ── proj4 defs for the CRSes SARdine actually loads ───────────────────────
// Mirrors getProj4Def() in overture-loader.js. Kept inline so this layer is
// self-contained and importable without touching the loader.
function proj4DefFor(crs) {
  const m = crs?.match(/EPSG:(\d+)/);
  if (!m) return null;
  const epsg = parseInt(m[1]);
  if (epsg === 4326) return null;
  if (epsg >= 32601 && epsg <= 32660) return `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
  if (epsg >= 32701 && epsg <= 32760) return `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`;
  if (epsg === 3413) return '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs';
  if (epsg === 3031) return '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs';
  return null;
}

// ── lon/lat ↔ Web Mercator tile (Slippy Map) ─────────────────────────────
function lonLatToTilePx(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { tileX: Math.floor(x), tileY: Math.floor(y), pxX: (x - Math.floor(x)) * TILE_PX, pxY: (y - Math.floor(y)) * TILE_PX };
}

/**
 * Build the warp + atlas for the current image bounds.
 *
 * Returns { warp: Float32Array(N*N*2), atlas: ImageBitmap-or-canvas,
 *           atlasWidth, atlasHeight }.
 *
 * The warp encodes each grid node's atlas-UV. Nodes whose geographic
 * position falls outside the fetched tile set are flagged with (-1, -1).
 */
async function buildPeek({ bounds, crs, tileUrlTemplate, gridSize, opticalZoom, signal }) {
  const def = proj4DefFor(crs);

  const [minX, minY, maxX, maxY] = bounds;

  // 1. Walk the grid in image CRS, inverse-project each node to lon/lat.
  // gridSize+1 nodes per axis so the grid spans 0..1 inclusive in layer UV.
  const N = gridSize + 1;
  const lonLat = new Float64Array(N * N * 2);
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
      if (lon < lonMin) lonMin = lon;
      if (lon > lonMax) lonMax = lon;
      if (lat < latMin) latMin = lat;
      if (lat > latMax) latMax = lat;
    }
  }

  // 2. Pick optical zoom from approximate pixels-per-degree if not provided.
  // Defaults aim for ~1 atlas pixel per ~SAR pixel at typical viewport sizes.
  const z = opticalZoom ?? Math.min(18, Math.max(1, Math.floor(Math.log2(360 / Math.max(lonMax - lonMin, 0.0001)) + 1)));

  // 3. Determine the tile range and fetch all tiles into an atlas canvas.
  const tlNW = lonLatToTilePx(lonMin, latMax, z);
  const tlSE = lonLatToTilePx(lonMax, latMin, z);
  const txMin = Math.min(tlNW.tileX, tlSE.tileX);
  const txMax = Math.max(tlNW.tileX, tlSE.tileX);
  const tyMin = Math.min(tlNW.tileY, tlSE.tileY);
  const tyMax = Math.max(tlNW.tileY, tlSE.tileY);

  const cols = txMax - txMin + 1;
  const rows = tyMax - tyMin + 1;
  const atlasW = cols * TILE_PX;
  const atlasH = rows * TILE_PX;

  // Bail if the atlas would be absurdly large. Caller should pick a coarser zoom.
  if (cols * rows > 256) {
    throw new Error(`OpticalPeek: too many tiles (${cols}x${rows}) at z=${z}; lower opticalZoom`);
  }

  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(atlasW, atlasH)
    : Object.assign(document.createElement('canvas'), { width: atlasW, height: atlasH });
  const ctx = canvas.getContext('2d');

  const fetches = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const url = tileUrlTemplate
        .replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
      fetches.push(
        fetch(url, { signal }).then(r => r.ok ? r.blob() : null)
          .then(blob => blob ? createImageBitmap(blob) : null)
          .then(bmp => {
            if (!bmp) return;
            ctx.drawImage(bmp, (tx - txMin) * TILE_PX, (ty - tyMin) * TILE_PX);
            bmp.close?.();
          })
          .catch(err => { if (err.name !== 'AbortError') console.warn('[OpticalPeek] tile fetch failed', err); })
      );
    }
  }
  await Promise.all(fetches);

  // 4. For each grid node, compute its UV inside the atlas.
  // UV = (pixel_in_atlas) / (atlas_size). A node outside the fetched range
  // (shouldn't happen, but guard) gets (-1,-1) sentinel.
  const warp = new Float32Array(N * N * 2);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const lon = lonLat[(j * N + i) * 2];
      const lat = lonLat[(j * N + i) * 2 + 1];
      const t = lonLatToTilePx(lon, lat, z);
      const atlasPxX = (t.tileX - txMin) * TILE_PX + t.pxX;
      const atlasPxY = (t.tileY - tyMin) * TILE_PX + t.pxY;
      const outOfRange = t.tileX < txMin || t.tileX > txMax || t.tileY < tyMin || t.tileY > tyMax;
      warp[(j * N + i) * 2] = outOfRange ? -1 : atlasPxX / atlasW;
      warp[(j * N + i) * 2 + 1] = outOfRange ? -1 : atlasPxY / atlasH;
    }
  }

  return { warp, warpSize: N, atlas: canvas, atlasW, atlasH, z, tilesFetched: cols * rows };
}

export class OpticalPeekLayer extends Layer {
  getShaders() {
    return { vs, fs, modules: [project32, picking] };
  }

  initializeState() {
    this.setState({ needsGeometryUpdate: true, buildToken: 0 });
  }

  getNumInstances() { return 0; }

  updateState({ props, oldProps, changeFlags }) {
    const { gl } = this.context;
    const { bounds, crs, tileUrlTemplate, gridSize = GRID_SIZE_DEFAULT, opticalZoom } = props;

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
      crs !== oldProps.crs ||
      tileUrlTemplate !== oldProps.tileUrlTemplate ||
      gridSize !== oldProps.gridSize ||
      opticalZoom !== oldProps.opticalZoom;

    if (triggersChanged && bounds && tileUrlTemplate) {
      this._rebuild();
    }
  }

  async _rebuild() {
    const { gl } = this.context;
    const { bounds, crs, tileUrlTemplate, gridSize = GRID_SIZE_DEFAULT, opticalZoom } = this.props;

    // Cancel any in-flight build by bumping a token. Stale results check
    // their token against state.buildToken before committing.
    const token = (this.state.buildToken || 0) + 1;
    this.setState({ buildToken: token });
    if (this.state.abortCtrl) this.state.abortCtrl.abort();
    const abortCtrl = new AbortController();
    this.setState({ abortCtrl });

    try {
      const result = await buildPeek({
        bounds, crs, tileUrlTemplate, gridSize, opticalZoom,
        signal: abortCtrl.signal,
      });
      if (token !== this.state.buildToken) return; // stale

      // Upload atlas as RGBA8 (canvas → texImage2D).
      const atlasTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, result.atlas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Upload warp as RG32F (raw WebGL2 API — luma.gl wrapper is shaky for
      // float internal formats, same reason SARGPULayer does it by hand).
      const warpTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, warpTex);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RG32F,
        result.warpSize, result.warpSize, 0,
        gl.RG, gl.FLOAT, result.warp,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);

      if (this.state.atlasTex) gl.deleteTexture(this.state.atlasTex);
      if (this.state.warpTex) gl.deleteTexture(this.state.warpTex);
      this.setState({ atlasTex, warpTex });
      console.log(`[OpticalPeek] built atlas: ${result.atlasW}×${result.atlasH} (z=${result.z}, ${result.tilesFetched} tiles), warp ${result.warpSize}²`);
      this.setNeedsRedraw('optical-peek rebuilt');
    } catch (err) {
      if (err.name !== 'AbortError') console.error('[OpticalPeek] build failed', err);
    }
  }

  draw({ uniforms }) {
    const { model, atlasTex, warpTex } = this.state;
    if (!model || !atlasTex || !warpTex) return;

    const { gl } = this.context;
    const { bounds, opacity = 0.7 } = this.props;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, warpTex);

    model.setUniforms({
      ...uniforms,
      uAtlas: 0,
      uWarp: 1,
      uImageBounds: bounds,
      uOpacity: opacity,
    });
    model.draw();

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  finalizeState() {
    super.finalizeState();
    const { gl } = this.context;
    if (this.state.abortCtrl) this.state.abortCtrl.abort();
    if (this.state.model) this.state.model.delete();
    if (gl) {
      if (this.state.atlasTex) gl.deleteTexture(this.state.atlasTex);
      if (this.state.warpTex) gl.deleteTexture(this.state.warpTex);
    }
  }
}

OpticalPeekLayer.layerName = 'OpticalPeekLayer';
OpticalPeekLayer.defaultProps = {
  bounds: { type: 'array', value: null, compare: true },
  crs: { type: 'string', value: 'EPSG:4326', compare: true },
  tileUrlTemplate: { type: 'string', value: '', compare: true },
  gridSize: { type: 'number', value: GRID_SIZE_DEFAULT, min: 8, max: 256, compare: true },
  opticalZoom: { type: 'number', value: null, compare: true },
  opacity: { type: 'number', value: 0.7, min: 0, max: 1, compare: true },
};
