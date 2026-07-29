/**
 * export-sidecar.js — Export provenance sidecar (W005)
 *
 * SARdine reads 40+ NISAR identification fields but historically wrote none of
 * them on export. This module builds a JSON provenance sidecar written next to
 * every GeoTIFF export so products carry identification, render state, and
 * lineage out of the browser.
 *
 * NAMING — collision warning:
 *   Sidecars are `{output}.tif.json` (export_HHHH_ml4.tif → export_HHHH_ml4.tif.json).
 *   Do NOT use `{file}.sardine.json` — that name is already taken by the
 *   sardine-agent NITF scene-geometry sidecar (version/jigger/demSource/mode).
 *
 * Rule: `identification` is an OPAQUE pass-through of whatever object the
 * loader read (imageData.identification). Fields are never hand-picked here —
 * hand-picking is how metadata gets dropped.
 */

export const EXPORT_SIDECAR_VERSION = 1;

// Kept in sync with package.json "version" — enforced by
// test/unit/export-sidecar.test.mjs, which fails on drift.
// (A literal is used because JSON import attributes are not portable
// across Vite 4 builds and Node >= 22 test runs.)
export const SARDINE_VERSION = '1.0.0-beta.11';

/**
 * Infer the product type when the caller didn't supply one.
 * Prefers the loader-read identification.productType (GCOV/GSLC/GUNW/...),
 * then falls back to the source filename/URL extension.
 */
function inferProductType(identification, file) {
  if (identification && typeof identification.productType === 'string' && identification.productType) {
    return identification.productType;
  }
  if (typeof file === 'string') {
    const f = file.toLowerCase().split(/[?#]/)[0];
    if (f.endsWith('.tif') || f.endsWith('.tiff')) return 'COG';
    if (f.endsWith('.ntf') || f.endsWith('.nitf')) return 'NITF';
  }
  return null;
}

/**
 * Build an export provenance sidecar object.
 *
 * @param {Object}      opts
 * @param {Object}      [opts.scene]        Source scene info:
 *   {string|null}  file            source filename or URL
 *   {string|null}  productType     'GCOV' | 'GUNW' | 'COG' | 'NITF' | ... (inferred if omitted)
 *   {Object|null}  identification  loader-read identification object, passed through OPAQUELY
 * @param {Object}      [opts.renderState]  Render state:
 *   {string}       mode            'raw' | 'rendered'
 *   For 'rendered' only: useDecibels, contrastLimits ([min,max] or {R,G,B}),
 *   colormap, stretchMode, gamma, compositeId. Ignored for 'raw' exports —
 *   a raw sidecar's render block carries only { mode: 'raw' }.
 * @param {Object}      [opts.exportParams] Georeferencing of the written GeoTIFF:
 *   {string|number} crs            'EPSG:32610' or bare EPSG code number
 *   {number[]}      bounds         [west, south, east, north] pixel-edge bounds
 *   {number}        width          export width in pixels
 *   {number}        height         export height in pixels
 *   {number}        multilook      multilook factor applied on export
 * @returns {Object} sidecar object (serialize with serializeSidecar / downloadSidecar)
 */
export function buildExportSidecar({ scene = {}, renderState = {}, exportParams = {} } = {}) {
  const identification = scene.identification ?? null;
  const mode = renderState.mode === 'rendered' ? 'rendered' : 'raw';

  // Raw exports carry no render parameters beyond the mode itself
  // (multilook lives in georeference).
  const render = mode === 'rendered'
    ? {
        mode,
        useDecibels: renderState.useDecibels ?? null,
        contrastLimits: renderState.contrastLimits ?? null,
        colormap: renderState.colormap ?? null,
        stretchMode: renderState.stretchMode ?? null,
        gamma: renderState.gamma ?? null,
        compositeId: renderState.compositeId ?? null,
      }
    : { mode };

  const crs = typeof exportParams.crs === 'number'
    ? `EPSG:${exportParams.crs}`
    : (exportParams.crs ?? null);

  return {
    'sardine:export': EXPORT_SIDECAR_VERSION,
    created: new Date().toISOString(),
    software: `SARdine ${SARDINE_VERSION}`,
    derived_from: {
      file: scene.file ?? null,
      productType: scene.productType ?? inferProductType(identification, scene.file),
    },
    // Opaque pass-through — every field the loader read, verbatim.
    identification,
    georeference: {
      crs,
      bounds: exportParams.bounds ? Array.from(exportParams.bounds) : null,
      width: exportParams.width ?? 0,
      height: exportParams.height ?? 0,
      multilook: exportParams.multilook ?? 1,
    },
    render,
  };
}

/**
 * JSON replacer that keeps arbitrary loader metadata serializable:
 * BigInt → number (or string when unsafe), typed arrays → plain arrays,
 * NaN/Infinity → null.
 */
function jsonSafeReplacer(key, value) {
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

/**
 * Serialize a sidecar object to pretty-printed JSON.
 * @param {Object} sidecar - object from buildExportSidecar()
 * @returns {string} JSON text
 */
export function serializeSidecar(sidecar) {
  return JSON.stringify(sidecar, jsonSafeReplacer, 2);
}

/**
 * Trigger a browser download of the sidecar as `{tifFilename}.json`
 * (e.g. export_HHHH_ml4.tif → export_HHHH_ml4.tif.json).
 * @param {Object} sidecar     - object from buildExportSidecar()
 * @param {string} tifFilename - the GeoTIFF filename the sidecar accompanies
 */
export function downloadSidecar(sidecar, tifFilename) {
  const blob = new Blob([serializeSidecar(sidecar)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${tifFilename}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
