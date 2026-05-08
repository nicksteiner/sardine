/**
 * Unified loader types for SARdine.
 *
 * Every loader (HDF5/NISAR, NITF/SICD, COG/GeoTIFF) exposes the same
 * two-step API:
 *
 *   1. listDatasets(file) → Dataset[]
 *      Cheap metadata-only enumeration. Each Dataset is a single
 *      visualizable channel — one polarization, one band, one image
 *      segment, etc. Format-specific extras live in `meta`.
 *
 *   2. loadDataset(file, datasetId, options?) → LoadedSource
 *      Full streaming load of one Dataset. Returns getTile + bounds +
 *      width/height + (optional) getExportStripe / getPixelValue.
 *
 * Files with a single channel (most COGs, single-image NITFs) return a
 * one-element list and the UI auto-loads without showing a picker.
 * Multi-channel files (NISAR GCOV, multi-band COG, multi-image NITF)
 * surface the list to the DatasetPicker.
 */

/**
 * @typedef {'h5' | 'cog' | 'nitf'} DatasetFormat
 */

/**
 * @typedef {Object} DatasetStats
 * @property {number} [mean_value]      Linear-power mean (for dB auto-contrast).
 * @property {number} [sample_stddev]   Linear-power std deviation.
 */

/**
 * A single visualizable channel in a file. Cheap to construct (metadata
 * only). The `id` is opaque and round-tripped back into loadDataset().
 *
 * @typedef {Object} Dataset
 * @property {string}        id           Stable per-file id. e.g. "freqA/HHHH" or "image/0" or "ifd/0".
 * @property {string}        label        Human-readable label for the picker.
 * @property {DatasetFormat} format       Source format.
 * @property {[number,number]} shape      [height, width] in pixels.
 * @property {string}        [dtype]      'float32' | 'float64' | 'int16' | 'complex64' | …
 * @property {boolean}       [isComplex]  True if pixels are complex (I/Q) — viewer renders amplitude.
 * @property {string}        [polarization] HH/HV/VH/VV/HHHH/HVHV/… when known.
 * @property {string}        [frequency]    'A' | 'B' (NISAR only).
 * @property {string}        [band]         'LSAR' | 'SSAR' (NISAR only).
 * @property {string}        [layer]        GUNW layer group when applicable.
 * @property {string}        [dataset]      GUNW dataset name within layer.
 * @property {[number,number,number,number]} [bounds]  [west, south, east, north] in CRS units.
 * @property {string}        [crs]        CRS authority string.
 * @property {DatasetStats}  [stats]      Optional precomputed stats for auto-contrast.
 * @property {Object}        [meta]       Format-specific extras (sicd, nitfInfo, ifdIndex, …).
 */

/**
 * The runtime artifact returned by loadDataset(). All loaders converge
 * on this shape so downstream rendering, export, and probe code can be
 * format-agnostic.
 *
 * @typedef {Object} LoadedSource
 * @property {DatasetFormat} format
 * @property {Function}      getTile          ({x,y,z,bbox?}) → {data, width, height} | null
 * @property {Function}      [getRGBTile]     Multi-band tile fetch (composite mode).
 * @property {Function}      [getExportStripe] Stripe-based export reader.
 * @property {Function}      [getPixelValue]  Single-pixel readout.
 * @property {[number,number,number,number]} bounds  Pixel-space bounds for tile indexing.
 * @property {[number,number,number,number]} [geoBounds] Geographic bbox [W,S,E,N].
 * @property {string}        crs
 * @property {number}        width
 * @property {number}        height
 * @property {number}        [tileWidth]
 * @property {number}        [tileHeight]
 * @property {string}        [dtype]
 * @property {boolean}       [isComplex]
 * @property {Object}        [meta]           Format-specific (sicd, nitfInfo, nisar, …).
 */

// ─── Format detection ──────────────────────────────────────────────────

const H5_RE = /\.(h5|hdf5|he5)$/i;
const TIF_RE = /\.(tif|tiff)$/i;
const NITF_RE = /\.(nitf|ntf)$/i;

/**
 * Identify the loader format for a File or filename. Returns null if
 * the extension is unrecognized.
 *
 * @param {File|string} fileOrName
 * @returns {DatasetFormat | null}
 */
export function detectFormat(fileOrName) {
  const name = typeof fileOrName === 'string' ? fileOrName : fileOrName?.name || '';
  if (H5_RE.test(name)) return 'h5';
  if (TIF_RE.test(name)) return 'cog';
  if (NITF_RE.test(name)) return 'nitf';
  return null;
}

/**
 * Group a heterogeneous file list by detected format. Files with no
 * known format land in `unknown`.
 *
 * @param {File[]} files
 * @returns {{h5: File[], cog: File[], nitf: File[], unknown: File[]}}
 */
export function bucketByFormat(files) {
  const out = { h5: [], cog: [], nitf: [], unknown: [] };
  for (const f of files || []) {
    const fmt = detectFormat(f);
    if (fmt) out[fmt].push(f);
    else out.unknown.push(f);
  }
  return out;
}
