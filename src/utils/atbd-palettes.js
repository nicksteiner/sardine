/**
 * Palettes and Uint8 → RGBA rasterization for NISAR ecosystem ATBD outputs.
 *
 * Classification rasters produced by src/algorithms/*.js carry integer class
 * codes. For on-screen overlay and GeoTIFF export we turn those into RGBA
 * bitmaps with the palettes below. Palettes ship as [r, g, b, a] per entry;
 * a==0 means "not drawn / no-data".
 *
 * Inundation palette tracks the notebook's 6-class ordering
 * (see src/algorithms/inundation.js :: INUNDATION_CLASS_NAMES). Anything at or
 * above `INUNDATION_MASKED_VALUE` renders transparent.
 *
 * Binary palette is shared by Crop CV (cropland mask) and Disturbance CUSUM
 * (disturbed mask): 0 → transparent, 1 → highlight.
 */

export const INUNDATION_PALETTE = Object.freeze([
  [ 93,  63, 211, 220], // 0 inundated_vegetation_1 — violet
  [138,  43, 226, 220], // 1 inundated_vegetation_2 — blue-violet
  [ 30, 144, 255, 220], // 2 open_water_1 — dodger blue
  [ 65, 105, 225, 220], // 3 open_water_2 — royal blue
  [139,  69,  19, 200], // 4 not_inundated — saddle brown
  [128, 128, 128, 160], // 5 not_classified — gray
]);

export const INUNDATION_CLASS_LABELS = Object.freeze([
  'Inundated veg 1',
  'Inundated veg 2',
  'Open water 1',
  'Open water 2',
  'Not inundated',
  'Not classified',
]);

export const CROP_PALETTE = Object.freeze([
  [  0,   0,   0,   0], // 0 non-cropland
  [231,  76,  60, 210], // 1 cropland — red
]);

export const CROP_CLASS_LABELS = Object.freeze(['Non-crop', 'Cropland']);

export const DISTURBANCE_PALETTE = Object.freeze([
  [  0,   0,   0,   0], // 0 stable
  [255, 140,   0, 210], // 1 disturbed — orange
]);

export const DISTURBANCE_CLASS_LABELS = Object.freeze(['Stable', 'Disturbed']);

/**
 * Paint a Uint8Array classification raster into an RGBA Uint8ClampedArray
 * using the given palette. Values out of range (including INUNDATION_MASKED_VALUE)
 * render transparent.
 *
 * @param {Uint8Array} classMap - per-pixel class index
 * @param {number} width
 * @param {number} height
 * @param {ReadonlyArray<ReadonlyArray<number>>} palette - [r,g,b,a] per class idx
 * @returns {Uint8ClampedArray}
 */
export function classifiedToRGBA(classMap, width, height, palette) {
  if (classMap.length !== width * height) {
    throw new Error(
      `classifiedToRGBA: classMap length ${classMap.length} != ${width}*${height}`
    );
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < classMap.length; i++) {
    const cls = classMap[i];
    const entry = palette[cls];
    if (!entry) continue; // out-of-range → transparent (alpha stays 0)
    const o = i * 4;
    out[o]     = entry[0];
    out[o + 1] = entry[1];
    out[o + 2] = entry[2];
    out[o + 3] = entry[3];
  }
  return out;
}

/**
 * Convert a palette into the hex+alpha format ClassificationOverlay uses for
 * class regions, so the overlay can reuse its existing LUT path.
 * Returns [{name, color}] — alpha is baked into color as 8-digit hex.
 */
export function paletteToClassRegions(palette, labels) {
  return palette.map((rgba, idx) => {
    const [r, g, b] = rgba;
    const hex =
      '#' +
      r.toString(16).padStart(2, '0') +
      g.toString(16).padStart(2, '0') +
      b.toString(16).padStart(2, '0');
    return { name: labels?.[idx] || `class${idx}`, color: hex };
  });
}

export const ATBD_PALETTES = Object.freeze({
  inundation:  { palette: INUNDATION_PALETTE,  labels: INUNDATION_CLASS_LABELS },
  crop:        { palette: CROP_PALETTE,        labels: CROP_CLASS_LABELS },
  disturbance: { palette: DISTURBANCE_PALETTE, labels: DISTURBANCE_CLASS_LABELS },
});
