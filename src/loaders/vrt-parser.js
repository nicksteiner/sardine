/**
 * GDAL Virtual Raster (.vrt) parser — pure JS, no DOM.
 *
 * A VRT is an XML description of a raster assembled from other rasters:
 * each band lists sources, and each source maps a pixel rectangle of a
 * source file (SrcRect) onto a rectangle of the virtual grid (DstRect).
 * This module only parses; vrt-loader.js opens sources and reads pixels.
 *
 * Supported: VRTDataset with VRTRasterBand + SimpleSource / ComplexSource /
 * AveragedSource (what gdalbuildvrt and gdal_translate -of VRT write).
 * Rejected with a clear error: VRTWarpedDataset, VRTDerivedRasterBand
 * (pixel functions), KernelFilteredSource, mask-band sources.
 *
 * Reference: https://gdal.org/drivers/raster/vrt.html
 */

// ─── Minimal XML reader ────────────────────────────────────────────────
// VRT XML is plain elements + attributes + text; no namespaces or DTDs
// worth honouring. DOMParser is not available in Node or workers, so we
// read it ourselves rather than add a dependency.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Parse XML text into a tree of {name, attrs, children, text}.
 * @param {string} xml
 * @returns {{name: string, attrs: Object, children: Array, text: string}} root element
 */
export function parseXml(xml) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[2] !== undefined) {
      if (top.name !== m[2]) throw new Error(`VRT XML: mismatched </${m[2]}> (open <${top.name}>)`);
      stack.pop();
    } else if (m[3] !== undefined) {
      const attrs = {};
      let a;
      attrRe.lastIndex = 0;
      while ((a = attrRe.exec(m[4] || '')) !== null) attrs[a[1]] = decodeEntities(a[2] ?? a[3]);
      const el = { name: m[3], attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) {
      top.text += decodeEntities(m[6]);
    }
  }
  if (stack.length !== 1) throw new Error(`VRT XML: unclosed <${stack[stack.length - 1].name}>`);
  const el = root.children[0];
  if (!el) throw new Error('VRT XML: empty document');
  return el;
}

const child = (el, name) => el.children.find(c => c.name === name) || null;
const childrenNamed = (el, name) => el.children.filter(c => c.name === name);
const textOf = (el, name) => {
  const c = child(el, name);
  return c ? c.text.trim() : null;
};
const numOrNull = (s) => {
  if (s === null || s === undefined || s === '') return null;
  const t = String(s).trim();
  // GDAL writes nodata as "nan", "-inf", "inf" as well as plain numbers
  if (/^[+-]?nan$/i.test(t)) return NaN;
  if (/^[+-]?inf(inity)?$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  const v = Number(t);
  return Number.isNaN(v) ? null : v;
};

// ─── SRS → CRS string ──────────────────────────────────────────────────

/**
 * Extract an "EPSG:nnnn" string from a VRT <SRS> value.
 *
 * Handles the forms GDAL writes: a bare "EPSG:nnnn" user input, WKT1 with
 * a trailing AUTHORITY["EPSG","nnnn"], and WKT2 with ID["EPSG",nnnn]. The
 * CRS's own authority is the LAST top-level one in the WKT — the earlier
 * ones belong to the datum, ellipsoid, and units.
 *
 * @param {string|null} srs
 * @returns {string|null}
 */
export function epsgFromSrs(srs) {
  if (!srs) return null;
  const s = srs.trim();
  const bare = /^EPSG:(\d+)$/i.exec(s);
  if (bare) return `EPSG:${bare[1]}`;

  // Walk the bracket structure and remember authorities at depth 1
  // (children of the outermost CRS node).
  let depth = 0;
  let last = null;
  const re = /(AUTHORITY|ID)\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?|[[\]()]|"(?:[^"]|"")*"/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const tok = m[0];
    if (tok === '[' || tok === '(') depth++;
    else if (tok === ']' || tok === ')') depth--;
    else if (m[1]) {
      if (depth === 1) last = m[2];
      depth++; // the authority's own bracket was consumed by the match
    }
  }
  return last ? `EPSG:${last}` : null;
}

// ─── Source paths ──────────────────────────────────────────────────────

/**
 * Resolve a VRT <SourceFilename> into something a loader can open.
 *
 * @param {string} filename  Raw SourceFilename text.
 * @param {boolean} relativeToVRT  The element's relativeToVRT attribute.
 * @param {string|null} baseUrl  Un-proxied URL of the VRT, or null when the
 *   VRT is a local File.
 * @returns {{kind: 'url', url: string} | {kind: 'local', name: string, path: string}}
 */
export function resolveVrtSourcePath(filename, relativeToVRT, baseUrl) {
  let f = filename.trim();
  if (/^\/vsicurl\//.test(f)) return { kind: 'url', url: f.slice('/vsicurl/'.length) };
  const vs3 = /^\/vsis3\/(.+)$/.exec(f);
  if (vs3) return { kind: 'url', url: `s3://${vs3[1]}` };
  if (/^\/vsigs\//.test(f)) return { kind: 'url', url: `https://storage.googleapis.com/${f.slice('/vsigs/'.length)}` };
  if (/^\/vsi[a-z0-9_]+\//.test(f)) {
    throw new Error(`VRT source ${f}: GDAL virtual filesystem ${f.split('/')[1]} is not supported`);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(f)) return { kind: 'url', url: f };
  if (/^[A-Z0-9_]+:/.test(f) && !/^[A-Za-z]:[\\/]/.test(f)) {
    // Driver-prefixed subdataset, e.g. HDF5:"file.h5"://path or NETCDF:...
    throw new Error(`VRT source ${f}: driver subdatasets (${f.split(':')[0]}) are not supported`);
  }

  f = f.replace(/\\/g, '/');
  const name = f.split('/').pop();
  if (baseUrl) {
    if (!relativeToVRT && (f.startsWith('/') || /^[A-Za-z]:\//.test(f))) {
      throw new Error(`VRT source ${f} is a local absolute path — a remote VRT can only reference URLs or paths relative to itself`);
    }
    return { kind: 'url', url: new URL(f, baseUrl).href };
  }
  return { kind: 'local', name, path: f };
}

// ─── VRT document ──────────────────────────────────────────────────────

const SOURCE_TYPES = new Set(['SimpleSource', 'ComplexSource', 'AveragedSource']);
const UNSUPPORTED_SOURCES = {
  KernelFilteredSource: 'KernelFilteredSource (convolution kernels)',
  NoDataFromMaskSource: 'NoDataFromMaskSource',
  ArraySource: 'ArraySource (multidimensional)',
};

function parseRect(el) {
  if (!el) return null;
  const n = (k) => Number(el.attrs[k]);
  const r = { x: n('xOff'), y: n('yOff'), w: n('xSize'), h: n('ySize') };
  return [r.x, r.y, r.w, r.h].every(Number.isFinite) ? r : null;
}

function parseSource(el) {
  const fnEl = child(el, 'SourceFilename');
  if (!fnEl) throw new Error(`VRT ${el.name} has no SourceFilename`);
  const bandText = textOf(el, 'SourceBand') || '1';
  if (!/^\d+$/.test(bandText)) {
    throw new Error(`VRT source band "${bandText}" (mask bands) is not supported`);
  }
  if (child(el, 'LUT')) throw new Error('VRT ComplexSource <LUT> is not supported');
  if (child(el, 'ColorTableComponent')) throw new Error('VRT ComplexSource <ColorTableComponent> is not supported');
  const ratio = numOrNull(textOf(el, 'ScaleRatio'));
  const offset = numOrNull(textOf(el, 'ScaleOffset'));
  const exponent = numOrNull(textOf(el, 'Exponent'));
  if (exponent !== null && exponent !== 1) throw new Error('VRT ComplexSource <Exponent> is not supported');
  return {
    type: el.name,
    filename: fnEl.text.trim(),
    relativeToVRT: fnEl.attrs.relativeToVRT === '1',
    sourceBand: Number(bandText),
    srcRect: parseRect(child(el, 'SrcRect')),
    dstRect: parseRect(child(el, 'DstRect')),
    nodata: el.name === 'ComplexSource' ? numOrNull(textOf(el, 'NODATA')) : null,
    scaleRatio: ratio ?? 1,
    scaleOffset: offset ?? 0,
    resampling: el.attrs.resampling || null,
  };
}

/**
 * Parse VRT XML text.
 *
 * @param {string} xml
 * @returns {{
 *   width: number, height: number,
 *   geoTransform: number[] | null,   // GDAL order [x0, dx, rotX, y0, rotY, dy]
 *   srs: string | null, crs: string | null,
 *   bands: Array<{band: number, dataType: string, description: string|null,
 *                 nodata: number|null, sources: Array<Object>}>
 * }}
 */
export function parseVRT(xml) {
  const root = parseXml(xml);
  if (root.name !== 'VRTDataset') throw new Error(`Not a VRT: root element is <${root.name}>`);
  if (root.attrs.subClass === 'VRTWarpedDataset') {
    throw new Error('Warped VRTs (VRTWarpedDataset, from gdalwarp -of VRT) are not supported — warp to a COG instead');
  }
  if (root.attrs.subClass) throw new Error(`VRT subClass "${root.attrs.subClass}" is not supported`);

  const width = Number(root.attrs.rasterXSize);
  const height = Number(root.attrs.rasterYSize);
  if (!(width > 0 && height > 0)) throw new Error('VRT: missing rasterXSize/rasterYSize');

  let geoTransform = null;
  const gtText = textOf(root, 'GeoTransform');
  if (gtText) {
    const gt = gtText.split(',').map(Number);
    if (gt.length === 6 && gt.every(Number.isFinite)) geoTransform = gt;
  }
  const srs = textOf(root, 'SRS');

  const bands = childrenNamed(root, 'VRTRasterBand').map((b, i) => {
    if (b.attrs.subClass === 'VRTDerivedRasterBand') {
      const fn = textOf(b, 'PixelFunctionType');
      throw new Error(`VRT band ${i + 1} is a derived band${fn ? ` (pixel function "${fn}")` : ''} — pixel functions are not supported`);
    }
    if (b.attrs.subClass) throw new Error(`VRT band subClass "${b.attrs.subClass}" is not supported`);
    const sources = [];
    for (const c of b.children) {
      if (SOURCE_TYPES.has(c.name)) sources.push(parseSource(c));
      else if (UNSUPPORTED_SOURCES[c.name]) {
        throw new Error(`VRT band ${i + 1}: ${UNSUPPORTED_SOURCES[c.name]} is not supported`);
      }
    }
    return {
      band: Number(b.attrs.band) || i + 1,
      dataType: b.attrs.dataType || 'Float32',
      description: textOf(b, 'Description'),
      nodata: numOrNull(textOf(b, 'NoDataValue')),
      scale: numOrNull(textOf(b, 'Scale')),
      offset: numOrNull(textOf(b, 'Offset')),
      sources,
    };
  });
  if (bands.length === 0) throw new Error('VRT has no VRTRasterBand elements');

  return { width, height, geoTransform, srs, crs: epsgFromSrs(srs), bands };
}
