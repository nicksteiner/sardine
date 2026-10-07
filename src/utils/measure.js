/**
 * measure.js — ground distances and areas for marks drawn in image pixels.
 *
 * Emergency and field users read an ROI as "1.2 km × 0.8 km, 0.96 km²" and a
 * transect as "3.4 km", never as pixel counts.  Everything here goes through
 * lon/lat (proj4 inverse for projected scenes, identity for EPSG:4326) and a
 * haversine on the WGS84 sphere, so it is independent of the CRS's units and
 * of the display frame.
 */

import proj4 from 'proj4';
import { getProj4Def } from '../loaders/overture-loader.js';

const R_EARTH_M = 6371008.8;

/** Great-circle distance in metres between two lon/lat points. */
export function haversineM([lon1, lat1], [lon2, lat2]) {
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * @param {object} o
 * @param {number[]} o.worldBounds  image extent in the image CRS
 * @param {string}   o.crs          'EPSG:xxxx'
 * @param {number}   o.imageWidth   source width (px)
 * @param {number}   o.imageHeight  source height (px)
 * @returns {object|null} measure helper, or null when the scene has no georeferencing
 */
export function makeGroundMeasure({ worldBounds, crs, imageWidth, imageHeight }) {
  if (!worldBounds || !imageWidth || !imageHeight) return null;
  const [minX, minY, maxX, maxY] = worldBounds;
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX === minX || maxY === minY) return null;
  const def = getProj4Def(crs);
  const inv = def ? proj4('WGS84', def).inverse : null;

  const pxToLonLat = (px, py) => {
    const X = minX + px / imageWidth * (maxX - minX);
    const Y = maxY - py / imageHeight * (maxY - minY);
    return inv ? inv([X, Y]) : [X, Y];
  };

  const distanceM = (x0, y0, x1, y1) => haversineM(pxToLonLat(x0, y0), pxToLonLat(x1, y1));

  /** Width/height along the ROI's mid-lines plus their product. */
  const roiGround = (roi) => {
    if (!roi) return null;
    const { left, top, width, height } = roi;
    const midY = top + height / 2;
    const midX = left + width / 2;
    const widthM = distanceM(left, midY, left + width, midY);
    const heightM = distanceM(midX, top, midX, top + height);
    return { widthM, heightM, areaM2: widthM * heightM };
  };

  // Representative ground sample distance at the scene centre.
  const cx = imageWidth / 2, cy = imageHeight / 2;
  const metersPerPixel = {
    x: distanceM(cx - 0.5, cy, cx + 0.5, cy),
    y: distanceM(cx, cy - 0.5, cx, cy + 0.5),
  };

  return { pxToLonLat, distanceM, roiGround, metersPerPixel };
}

/** "850 m" / "3.4 km" / "120 km" */
export function formatDistance(m) {
  if (!Number.isFinite(m)) return '';
  if (m < 1000) return `${m < 10 ? m.toFixed(1) : Math.round(m)} m`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(2) : km < 100 ? km.toFixed(1) : Math.round(km)} km`;
}

/** "4.2 ha" below 1 km², else "0.96 km²" / "1 240 km²" */
export function formatArea(m2) {
  if (!Number.isFinite(m2)) return '';
  if (m2 < 1e4) return `${Math.round(m2)} m²`;
  if (m2 < 1e6) return `${(m2 / 1e4).toFixed(1)} ha`;
  const km2 = m2 / 1e6;
  if (km2 < 10) return `${km2.toFixed(2)} km²`;
  if (km2 < 100) return `${km2.toFixed(1)} km²`;
  return `${Math.round(km2).toLocaleString('en-US').replace(/,/g, ' ')} km²`;
}

/** One-line ROI readout: "1.24 km × 0.80 km · 0.99 km²" */
export function formatRoiGround(g) {
  if (!g) return '';
  return `${formatDistance(g.widthM)} × ${formatDistance(g.heightM)} · ${formatArea(g.areaM2)}`;
}
