/**
 * view-frame.js — one coordinate contract for the markup overlays and the
 * figure exporter, independent of which viewer is on screen.
 *
 * The native viewer (SARViewer) is a deck.gl OrthographicView over the scene's
 * `bounds` ("scene world": pixel space for COGs, the image CRS for NISAR RGB
 * composites).  Basemap mode (MapViewer) is a Web Mercator MapView in lon/lat.
 * ROI, transect and annotations persist in scene-world / image-pixel units in
 * both, so every overlay only needs two functions — scene world → screen and
 * screen → scene world — and a frame supplies them for the active view.
 *
 *   makeOrthoFrame()            — the historical OrthographicView math
 *   makeMapFrame({...})         — Web Mercator (pitch 0, bearing 0) through the
 *                                 image CRS via proj4
 *
 * Frame function signatures mirror geo-overlays.js so call sites can swap
 * `frame.worldToPixel` for `worldToPixel` one-for-one:
 *   worldToPixel(wx, wy, viewState, canvasW, canvasH) → [sx, sy]
 *   pixelToWorld(sx, sy, viewState, canvasW, canvasH) → [wx, wy]
 *
 * Screen projection goes through @math.gl/web-mercator's WebMercatorViewport —
 * the same math deck.gl's MapView uses — so bearing and pitch (Ctrl-drag /
 * right-drag rotate the map) are honoured exactly and marks stay on the map
 * plane. It is pure math and runs in Node tests. The small helpers below keep
 * the zoom-0 Mercator formulas for scale-bar arithmetic.
 */

import proj4 from 'proj4';
import { WebMercatorViewport } from '@math.gl/web-mercator';
import { getProj4Def } from '../loaders/overture-loader.js';
import { worldToPixel as orthoWorldToPixel, pixelToWorld as orthoPixelToWorld } from './geo-overlays.js';

const TILE_SIZE = 512;                 // deck.gl MapView world size at zoom 0
const EARTH_CIRCUMFERENCE_M = 40075016.686;
const MAX_LAT = 85.051129;

/** lon/lat → Web Mercator "world pixels" at zoom 0 (TILE_SIZE wide). */
export function lonLatToMercator(lon, lat) {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const x = (lon + 180) / 360 * TILE_SIZE;
  const sinLat = Math.sin(clamped * Math.PI / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * TILE_SIZE;
  return [x, y];
}

/** Web Mercator world pixels (zoom 0) → lon/lat. */
export function mercatorToLonLat(x, y) {
  const lon = x / TILE_SIZE * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / TILE_SIZE;
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lon, lat];
}

/** Ground metres per screen pixel at a latitude and MapView zoom. */
export function mercatorMetersPerPixel(lat, zoom) {
  return EARTH_CIRCUMFERENCE_M * Math.cos(lat * Math.PI / 180) / (TILE_SIZE * Math.pow(2, zoom));
}

/** The native OrthographicView frame (identity wrappers, kind 'ortho'). */
export function makeOrthoFrame() {
  return {
    kind: 'ortho',
    worldToPixel: orthoWorldToPixel,
    pixelToWorld: orthoPixelToWorld,
  };
}

/**
 * Build the basemap-mode frame.
 *
 * @param {object} o
 * @param {number[]} o.bounds       scene-world bounds the overlays store against
 *                                  ([0,0,w,h] pixel space or the image CRS)
 * @param {number}   o.imageWidth   source image width (px)
 * @param {number}   o.imageHeight  source image height (px)
 * @param {number[]} o.worldBounds  image extent in the image CRS
 * @param {string}   o.crs          'EPSG:xxxx'
 */
export function makeMapFrame({ bounds, imageWidth, imageHeight, worldBounds, crs }) {
  if (!bounds || !worldBounds || !imageWidth || !imageHeight) return null;
  const [bMinX, bMinY, bMaxX, bMaxY] = bounds;
  const [wMinX, wMinY, wMaxX, wMaxY] = worldBounds;
  const def = getProj4Def(crs);
  const conv = def ? proj4('WGS84', def) : null;
  const toLonLat = conv ? (x, y) => conv.inverse([x, y]) : (x, y) => [x, y];
  const toCrs = conv ? (lon, lat) => conv.forward([lon, lat]) : (lon, lat) => [lon, lat];

  // scene world ↔ image pixel (row 0 = north = maxY)
  const worldToImg = (wx, wy) => [
    (wx - bMinX) / (bMaxX - bMinX) * imageWidth,
    (bMaxY - wy) / (bMaxY - bMinY) * imageHeight,
  ];
  const imgToWorld = (px, py) => [
    bMinX + px / imageWidth * (bMaxX - bMinX),
    bMaxY - py / imageHeight * (bMaxY - bMinY),
  ];
  // image pixel ↔ image CRS
  const imgToCrs = (px, py) => [
    wMinX + px / imageWidth * (wMaxX - wMinX),
    wMaxY - py / imageHeight * (wMaxY - wMinY),
  ];
  const crsToImg = (x, y) => [
    (x - wMinX) / (wMaxX - wMinX) * imageWidth,
    (wMaxY - y) / (wMaxY - wMinY) * imageHeight,
  ];

  // One viewport per (viewState, canvas size); overlays call this per vertex.
  let vpKey = null, vp = null;
  const viewport = (vs, w, h) => {
    const key = `${vs.longitude}|${vs.latitude}|${vs.zoom}|${vs.bearing || 0}|${vs.pitch || 0}|${w}|${h}`;
    if (key !== vpKey) {
      vp = new WebMercatorViewport({
        width: Math.max(1, w), height: Math.max(1, h),
        longitude: vs.longitude || 0, latitude: vs.latitude || 0, zoom: vs.zoom || 0,
        bearing: vs.bearing || 0, pitch: vs.pitch || 0,
      });
      vpKey = key;
    }
    return vp;
  };
  const lonLatToPixel = (lon, lat, vs, w, h) => {
    const [x, y] = viewport(vs, w, h).project([lon, lat]);
    return [x, y];
  };
  const pixelToLonLat = (sx, sy, vs, w, h) => {
    const [lon, lat] = viewport(vs, w, h).unproject([sx, sy]);
    return [lon, lat];
  };

  return {
    kind: 'map',
    crs,
    worldToPixel(wx, wy, vs, w, h) {
      const [px, py] = worldToImg(wx, wy);
      const [X, Y] = imgToCrs(px, py);
      const [lon, lat] = toLonLat(X, Y);
      return lonLatToPixel(lon, lat, vs, w, h);
    },
    pixelToWorld(sx, sy, vs, w, h) {
      const [lon, lat] = pixelToLonLat(sx, sy, vs, w, h);
      const [X, Y] = toCrs(lon, lat);
      const [px, py] = crsToImg(X, Y);
      return imgToWorld(px, py);
    },
    imgToLonLat(px, py) {
      const [X, Y] = imgToCrs(px, py);
      return toLonLat(X, Y);
    },
    lonLatToPixel,
    pixelToLonLat,
    /** Ground metres per screen pixel at the viewport centre. */
    metersPerPixel(vs) {
      return mercatorMetersPerPixel(vs.latitude || 0, vs.zoom || 0);
    },
  };
}

/**
 * Re-express a frame for a canvas whose pixel size is `k` × the CSS size the
 * viewState was interacted at (figure export captures device pixels).
 */
export function scaleFrame(frame, k) {
  if (!frame || k === 1) return frame;
  const wrap = (fn) => (x, y, vs, w, h) => {
    const r = fn(x, y, vs, w / k, h / k);
    return [r[0] * k, r[1] * k];
  };
  const unwrap = (fn) => (sx, sy, vs, w, h) => fn(sx / k, sy / k, vs, w / k, h / k);
  return {
    ...frame,
    worldToPixel: wrap(frame.worldToPixel),
    pixelToWorld: unwrap(frame.pixelToWorld),
    lonLatToPixel: frame.lonLatToPixel ? wrap(frame.lonLatToPixel) : undefined,
    pixelToLonLat: frame.pixelToLonLat ? unwrap(frame.pixelToLonLat) : undefined,
    metersPerPixel: frame.metersPerPixel ? (vs) => frame.metersPerPixel(vs) / k : undefined,
  };
}
