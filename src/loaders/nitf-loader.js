/**
 * NITF 2.1 loader for SARdine
 *
 * Streams NITF image data via File.slice() — only reads the rows
 * needed for the current viewport tile.  Handles SICD complex (I/Q int16)
 * products by computing amplitude = sqrt(I² + Q²) on the fly.
 *
 * Designed for uncompressed (IC=NC/NM) NITF files.  JPEG 2000
 * compressed files are not yet supported.
 *
 * Returns the same { getTile, bounds, width, height, … } shape as
 * loadLocalTIF so the rest of SARdine can use it unchanged.
 */

import { buildSICDProjection, imageBboxFromProjection } from '../utils/sicd-projection.js';

// ─── NITF header parsing ────────────────────────────────────────────

/**
 * Read `len` ASCII characters from a DataView at `offset`.
 */
function readStr(dv, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(offset + i));
  return s;
}

/**
 * Read a numeric field (ASCII integer) from a DataView.
 */
function readInt(dv, offset, len) {
  const s = readStr(dv, offset, len).trim();
  return s.length === 0 ? 0 : parseInt(s, 10);
}

/**
 * Parse the NITF 2.1 file header.
 * Only the first ~1 KB is needed.
 */
function parseFileHeader(buf) {
  const dv = new DataView(buf);
  const fhdr = readStr(dv, 0, 9);   // 'NITF02.10'
  if (!fhdr.startsWith('NITF')) throw new Error(`Not a NITF file (got: ${fhdr})`);

  const version = fhdr.slice(4);     // '02.10'
  const clevel = readInt(dv, 9, 2);
  const ftitle = readStr(dv, 39, 80).trim();
  const fl = readInt(dv, 342, 12);   // file length
  const hl = readInt(dv, 354, 6);    // header length

  // Image segments
  const numi = readInt(dv, 360, 3);
  let off = 363;
  const images = [];
  for (let i = 0; i < numi; i++) {
    const lish = readInt(dv, off, 6);       // image subheader length
    const li = readInt(dv, off + 6, 10);    // image data length
    images.push({ subheaderLen: lish, dataLen: li });
    off += 16;
  }

  // Graphics
  const nums = readInt(dv, off, 3); off += 3;
  for (let i = 0; i < nums; i++) off += 10;

  // Reserved
  off += 3;

  // Text
  const numt = readInt(dv, off, 3); off += 3;
  for (let i = 0; i < numt; i++) off += 9;

  // Data Extension Segments
  const numdes = readInt(dv, off, 3); off += 3;
  const des = [];
  for (let i = 0; i < numdes; i++) {
    const ldsh = readInt(dv, off, 4);
    const ld = readInt(dv, off + 4, 9);
    des.push({ subheaderLen: ldsh, dataLen: ld });
    off += 13;
  }

  return { version, clevel, ftitle, fl, hl, numi, images, nums, numt, numdes, des };
}


/**
 * Parse a NITF 2.1 image subheader.
 * Expects the complete subheader buffer.
 */
function parseImageSubheader(buf) {
  const dv = new DataView(buf);
  let off = 0;

  const im = readStr(dv, off, 2); off += 2;       // 'IM'
  if (im !== 'IM') throw new Error(`Expected 'IM', got '${im}'`);

  const iid1 = readStr(dv, off, 10).trim(); off += 10;
  const idatim = readStr(dv, off, 14).trim(); off += 14;
  const tgtid = readStr(dv, off, 17).trim(); off += 17;
  const iid2 = readStr(dv, off, 80).trim(); off += 80;

  // Security fields (NITF 2.1)
  const isclas = readStr(dv, off, 1); off += 1;
  // ISCLSY(2) + ISCODE(11) + ISCTLH(2) + ISREL(20) + ISDCTP(2) + ISDCDT(8) +
  // ISDCXM(4) + ISDG(1) + ISDGDT(8) + ISCLTX(43) + ISCATP(1) + ISCAUT(40) +
  // ISCRSN(1) + ISSRDT(8) + ISCTLN(15)
  off += 2 + 11 + 2 + 20 + 2 + 8 + 4 + 1 + 8 + 43 + 1 + 40 + 1 + 8 + 15;
  // = 167 bytes of security

  const encryp = readStr(dv, off, 1); off += 1;
  const isorce = readStr(dv, off, 42).trim(); off += 42;

  const nrows = readInt(dv, off, 8); off += 8;
  const ncols = readInt(dv, off, 8); off += 8;

  const pvtype = readStr(dv, off, 3).trim(); off += 3;     // SI, R, C, INT
  const irep = readStr(dv, off, 8).trim(); off += 8;       // NODISPLY, MONO, RGB, etc
  const icat = readStr(dv, off, 8).trim(); off += 8;       // SAR, VIS, IR, etc
  const abpp = readInt(dv, off, 2); off += 2;              // actual bits per pixel
  const pjust = readStr(dv, off, 1); off += 1;             // pixel justification

  const icords = readStr(dv, off, 1).trim(); off += 1;     // coordinate rep: G, N, S, U, D, ''

  let igeolo = '';
  if (icords) {
    igeolo = readStr(dv, off, 60); off += 60;
  }

  // Image comments
  const nicom = readInt(dv, off, 1); off += 1;
  for (let i = 0; i < nicom; i++) off += 80;

  // Compression
  const ic = readStr(dv, off, 2).trim(); off += 2;

  // COMRAT only present when compressed
  let comrat = '';
  if (ic !== 'NC' && ic !== 'NM') {
    comrat = readStr(dv, off, 4).trim(); off += 4;
  }

  // Bands
  const nbands = readInt(dv, off, 1); off += 1;
  let xbands = 0;
  if (nbands === 0) {
    xbands = readInt(dv, off, 5); off += 5;
  }
  const totalBands = nbands || xbands;

  const bands = [];
  for (let i = 0; i < totalBands; i++) {
    const irepband = readStr(dv, off, 2).trim(); off += 2;
    const isubcat = readStr(dv, off, 6).trim(); off += 6;
    const ifc = readStr(dv, off, 1); off += 1;
    const imflt = readStr(dv, off, 3); off += 3;
    const nluts = readInt(dv, off, 1); off += 1;
    let lutEntries = 0;
    if (nluts > 0) {
      lutEntries = readInt(dv, off, 5); off += 5;
      off += nluts * lutEntries; // skip LUT data
    }
    bands.push({ irepband, isubcat, ifc, imflt, nluts });
  }

  const isync = readStr(dv, off, 1); off += 1;
  const imode = readStr(dv, off, 1); off += 1;   // P, B, R, S
  const nbpr = readInt(dv, off, 4); off += 4;    // blocks per row
  const nbpc = readInt(dv, off, 4); off += 4;    // blocks per col
  const nppbh = readInt(dv, off, 4); off += 4;   // pixels per block H
  const nppbv = readInt(dv, off, 4); off += 4;   // pixels per block V
  const nbpp = readInt(dv, off, 2); off += 2;    // bits per pixel per band

  return {
    iid1, idatim, tgtid, iid2, isclas, encryp, isorce,
    nrows, ncols, pvtype, irep, icat, abpp, pjust,
    icords, igeolo, ic, comrat,
    totalBands, bands, imode, nbpr, nbpc, nppbh, nppbv, nbpp,
  };
}


// ─── IGEOLO coordinate parsing ──────────────────────────────────────

/**
 * Parse IGEOLO string (60 chars) into four corner coordinates [lat, lon].
 * Supports Geographic (G/D) and UTM/MGRS formats.
 * Returns [[lat,lon], [lat,lon], [lat,lon], [lat,lon]] for the four corners
 * in order: UL, UR, LR, LL (FRFC, FRLC, LRLC, LRFC).
 */
function parseIGEOLO(icords, igeolo) {
  if (!igeolo || igeolo.trim().length === 0) return null;

  if (icords === 'G') {
    // Geographic: ddmmssXdddmmssY repeated 4 times (15 chars each, 60 total)
    const corners = [];
    for (let i = 0; i < 4; i++) {
      const chunk = igeolo.slice(i * 15, (i + 1) * 15);
      const latD = parseInt(chunk.slice(0, 2));
      const latM = parseInt(chunk.slice(2, 4));
      const latS = parseInt(chunk.slice(4, 6));
      const latH = chunk[6]; // N or S
      const lonD = parseInt(chunk.slice(7, 10));
      const lonM = parseInt(chunk.slice(10, 12));
      const lonS = parseInt(chunk.slice(12, 14));
      const lonH = chunk[14]; // E or W
      let lat = latD + latM / 60 + latS / 3600;
      let lon = lonD + lonM / 60 + lonS / 3600;
      if (latH === 'S') lat = -lat;
      if (lonH === 'W') lon = -lon;
      corners.push([lat, lon]);
    }
    return corners;
  }

  if (icords === 'D') {
    // Decimal degrees: ±dd.ddd±ddd.ddd repeated 4 times
    const corners = [];
    for (let i = 0; i < 4; i++) {
      const chunk = igeolo.slice(i * 15, (i + 1) * 15);
      const lat = parseFloat(chunk.slice(0, 7));
      const lon = parseFloat(chunk.slice(7, 15));
      corners.push([lat, lon]);
    }
    return corners;
  }

  // UTM / MGRS — stored as a zone+grid string, needs MGRS decoding
  // For now, return null and rely on SICD XML
  console.warn(`[NITF Loader] IGEOLO coordinate system '${icords}' not fully supported, will use SICD XML`);
  return null;
}


// ─── SICD XML parsing ───────────────────────────────────────────────

/**
 * Parse SICD XML from a DES segment to extract corner coordinates.
 * Returns { corners: [[lat,lon]×4], scp: {lat,lon,hae}, pixelType, nrows, ncols }
 */
function parseSICDXml(xmlStr, DOMParserImpl) {
  const ParserCtor = DOMParserImpl || (typeof DOMParser !== 'undefined' ? DOMParser : null);
  if (!ParserCtor) throw new Error('No DOMParser available; pass one as the second argument');
  const parser = new ParserCtor();
  const doc = parser.parseFromString(xmlStr, 'text/xml');

  // ── helpers: walk descendants by tag-name path (works in browser + xmldom) ──
  // findOne('ImageData','SCPPixel','Row') returns the first <Row> inside the
  // first <SCPPixel> inside the first <ImageData>. Returns null if any level
  // is missing.
  function findOne(...tags) {
    let node = doc;
    for (const tag of tags) {
      if (!node) return null;
      const kids = node.getElementsByTagName(tag);
      if (!kids || kids.length === 0) return null;
      node = kids[0];
    }
    return node;
  }
  function findAll(root, tag) {
    if (!root) return [];
    const kids = root.getElementsByTagName(tag);
    const arr = [];
    for (let i = 0; i < kids.length; i++) arr.push(kids[i]);
    return arr;
  }
  const textOf = (el) => {
    if (!el) return null;
    // xmldom lacks .textContent on some nodes; walk children
    if (el.textContent != null) return el.textContent;
    let s = '';
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeValue != null) s += n.nodeValue;
    }
    return s;
  };
  const numOf = (el) => { const t = textOf(el); return t == null ? null : parseFloat(t); };
  const intOf = (el) => { const t = textOf(el); return t == null ? null : parseInt(t, 10); };
  const strOf = (el) => { const t = textOf(el); return t == null ? null : t.trim(); };
  // Read an XYZ triple from a child element (e.g. <ARPPos><X/><Y/><Z/></ARPPos>)
  const xyzOf = (el) => {
    if (!el) return null;
    const x = numOf(findAll(el, 'X')[0]);
    const y = numOf(findAll(el, 'Y')[0]);
    const z = numOf(findAll(el, 'Z')[0]);
    if (x == null || y == null || z == null) return null;
    return { x, y, z };
  };

  const result = {};

  // Image corners (ICP) — parsed but NOT used by the projection.
  const icContainer = findOne('ImageCorners');
  if (icContainer) {
    const icps = findAll(icContainer, 'ICP');
    if (icps.length >= 4) {
      const corners = [];
      for (const icp of icps) {
        const lat = numOf(findAll(icp, 'Lat')[0]);
        const lon = numOf(findAll(icp, 'Lon')[0]);
        corners.push([lat, lon]);
      }
      result.corners = corners;
    }
  }

  // Scene center point
  const scpLat = numOf(findOne('GeoData', 'SCP', 'LLH', 'Lat'));
  const scpLon = numOf(findOne('GeoData', 'SCP', 'LLH', 'Lon'));
  const scpHae = numOf(findOne('GeoData', 'SCP', 'LLH', 'HAE'));
  if (scpLat != null && scpLon != null) {
    result.scp = { lat: scpLat, lon: scpLon, hae: scpHae || 0 };
  }

  // Image dimensions
  const numRows = intOf(findOne('ImageData', 'NumRows'));
  const numCols = intOf(findOne('ImageData', 'NumCols'));
  if (numRows != null) result.nrows = numRows;
  if (numCols != null) result.ncols = numCols;

  // Full image dimensions (pre-chip)
  const fullRows = intOf(findOne('ImageData', 'FullImage', 'NumRows'));
  const fullCols = intOf(findOne('ImageData', 'FullImage', 'NumCols'));
  if (fullRows != null) result.fullRows = fullRows;
  if (fullCols != null) result.fullCols = fullCols;

  // Chip offset
  const firstRow = intOf(findOne('ImageData', 'FirstRow'));
  const firstCol = intOf(findOne('ImageData', 'FirstCol'));
  result.firstRow = firstRow != null ? firstRow : 0;
  result.firstCol = firstCol != null ? firstCol : 0;

  // SCPPixel in full-image coords
  const spRow = intOf(findOne('ImageData', 'SCPPixel', 'Row'));
  const spCol = intOf(findOne('ImageData', 'SCPPixel', 'Col'));
  if (spRow != null && spCol != null) {
    result.scpPixel = { row: spRow, col: spCol };
  }

  // Pixel type / collector / mode
  const pixelType = strOf(findOne('ImageData', 'PixelType'));
  if (pixelType) result.pixelType = pixelType;
  const collector = strOf(findOne('CollectionInfo', 'CollectorName'));
  if (collector) result.collector = collector;
  const modeType = strOf(findOne('CollectionInfo', 'RadarMode', 'ModeType'))
    || strOf(findOne('RadarMode', 'ModeType'));
  if (modeType) result.modeType = modeType;

  // Radiometric cal (constant-polynomial scale factors)
  const sigmaZeroSF = numOf(findOne('Radiometric', 'SigmaZeroSFPoly', 'Coef'));
  if (sigmaZeroSF != null) result.sigmaZeroSF = sigmaZeroSF;
  const betaZeroSF = numOf(findOne('Radiometric', 'BetaZeroSFPoly', 'Coef'));
  if (betaZeroSF != null) result.betaZeroSF = betaZeroSF;
  const gammaZeroSF = numOf(findOne('Radiometric', 'GammaZeroSFPoly', 'Coef'));
  if (gammaZeroSF != null) result.gammaZeroSF = gammaZeroSF;

  // ── View geometry: SCPCOA + Grid + GeoData/SCP/ECF ─────────────────
  const geometry = {};

  const scpcoa = findOne('SCPCOA');
  if (scpcoa) {
    const arpPos = xyzOf(findAll(scpcoa, 'ARPPos')[0]);
    if (arpPos) geometry.arpPos = arpPos;
    const arpVel = xyzOf(findAll(scpcoa, 'ARPVel')[0]);
    if (arpVel) geometry.arpVel = arpVel;
    const sot = strOf(findAll(scpcoa, 'SideOfTrack')[0]);
    if (sot) geometry.sideOfTrack = sot;
    const sr = numOf(findAll(scpcoa, 'SlantRange')[0]);
    if (sr != null) geometry.slantRange = sr;
    const gr = numOf(findAll(scpcoa, 'GrazeAng')[0]);
    if (gr != null) geometry.grazeAng = gr;
    const inc = numOf(findAll(scpcoa, 'IncidenceAng')[0]);
    if (inc != null) geometry.incidenceAng = inc;
    const tw = numOf(findAll(scpcoa, 'TwistAng')[0]);
    if (tw != null) geometry.twistAng = tw;
    const sl = numOf(findAll(scpcoa, 'SlopeAng')[0]);
    if (sl != null) geometry.slopeAng = sl;
    const az = numOf(findAll(scpcoa, 'AzimAng')[0]);
    if (az != null) geometry.azimAng = az;
    const lay = numOf(findAll(scpcoa, 'LayoverAng')[0]);
    if (lay != null) geometry.layoverAng = lay;
  }

  // Grid
  const gridType = strOf(findOne('Grid', 'Type'));
  if (gridType) geometry.gridType = gridType;
  geometry.rowUVect = xyzOf(findOne('Grid', 'Row', 'UVectECF')) || undefined;
  geometry.colUVect = xyzOf(findOne('Grid', 'Col', 'UVectECF')) || undefined;
  const rowSS = numOf(findOne('Grid', 'Row', 'SS'));
  if (rowSS != null) geometry.rowSS = rowSS;
  const colSS = numOf(findOne('Grid', 'Col', 'SS'));
  if (colSS != null) geometry.colSS = colSS;

  // SCP ECF
  const scpEcef = xyzOf(findOne('GeoData', 'SCP', 'ECF'));
  if (scpEcef && result.scp) result.scp.ecef = scpEcef;

  // Polarization
  const pol = strOf(findOne('ImageFormation', 'TxRcvPolarizationProc'));
  if (pol) geometry.polarization = pol;

  if (geometry.arpPos && result.scp) {
    result.geometry = geometry;
  }

  return result;
}


/**
 * Convert four corner lat/lon pairs to a bounding box [west, south, east, north].
 */
function cornersToBbox(corners) {
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  for (const [lat, lon] of corners) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return [minLon, minLat, maxLon, maxLat];
}


// ─── Image data reading ─────────────────────────────────────────────

/**
 * Determine bytes per pixel per band from PVTYPE + NBPP.
 */
function bytesPerPixelBand(pvtype, nbpp) {
  return nbpp / 8;
}

/**
 * Read a big-endian Int16 from a DataView.
 * NITF stores pixel data in big-endian byte order.
 */
function getInt16BE(dv, byteOff) {
  return dv.getInt16(byteOff, false); // false = big-endian
}

/**
 * Read a big-endian Float32 from a DataView.
 */
function getFloat32BE(dv, byteOff) {
  return dv.getFloat32(byteOff, false);
}

/**
 * Decode complex int16 pixel-interleaved data to calibrated sigma0 power.
 * Output = SF × (I² + Q²).  When SF=1 (no calibration), output is raw power.
 * The shader's 10*log10() then converts to proper dB.
 *
 * @param {DataView} dv         - Raw row data
 * @param {Float32Array} out    - Output buffer
 * @param {number} outW         - Output width
 * @param {number} outH         - Output height
 * @param {number} ncols        - Full image width (columns per row)
 * @param {number} startCol     - First column to read
 * @param {number} stride       - Column stride
 * @param {number} rowStride    - Row stride within the buffer
 * @param {number} maxSrcRows   - Number of source rows in the buffer
 * @param {number} sf           - Radiometric scale factor (sigma0)
 */
function decodeComplexInt16P(dv, out, outW, outH, ncols, startCol, stride, rowStride, maxSrcRows, sf) {
  const rowBytes = ncols * 4; // 2 bands × 2 bytes each
  for (let r = 0; r < outH; r++) {
    const srcRow = r * rowStride;
    if (srcRow >= maxSrcRows) break;
    const rowByteOff = srcRow * rowBytes;
    for (let c = 0; c < outW; c++) {
      const srcCol = startCol + c * stride;
      if (srcCol >= ncols) break;
      const pixByteOff = rowByteOff + srcCol * 4;
      const i16 = dv.getInt16(pixByteOff, false);
      const q16 = dv.getInt16(pixByteOff + 2, false);
      out[r * outW + c] = sf * (i16 * i16 + q16 * q16);
    }
  }
}

/**
 * Decode single-band real Float32 data (big-endian).
 */
function decodeFloat32(dv, out, outW, outH, ncols, startCol, stride, rowStride, maxSrcRows) {
  const rowBytes = ncols * 4;
  for (let r = 0; r < outH; r++) {
    const srcRow = r * rowStride;
    if (srcRow >= maxSrcRows) break;
    const rowByteOff = srcRow * rowBytes;
    for (let c = 0; c < outW; c++) {
      const srcCol = startCol + c * stride;
      if (srcCol >= ncols) break;
      out[r * outW + c] = dv.getFloat32(rowByteOff + srcCol * 4, false);
    }
  }
}

/**
 * Decode single-band Int16 data (big-endian).
 */
function decodeInt16(dv, out, outW, outH, ncols, startCol, stride, rowStride, maxSrcRows) {
  const rowBytes = ncols * 2;
  for (let r = 0; r < outH; r++) {
    const srcRow = r * rowStride;
    if (srcRow >= maxSrcRows) break;
    const rowByteOff = srcRow * rowBytes;
    for (let c = 0; c < outW; c++) {
      const srcCol = startCol + c * stride;
      if (srcCol >= ncols) break;
      out[r * outW + c] = dv.getInt16(rowByteOff + srcCol * 2, false);
    }
  }
}


// ─── Public API ─────────────────────────────────────────────────────

/**
 * Load a NITF file and return a tile-based reader compatible with SARdine.
 *
 * Streams data via File.slice() — only reads bytes for the requested
 * viewport region.  For complex (SICD) data, computes amplitude on the
 * fly.
 *
 * @param {File} file - The local NITF File object
 * @param {Function} [onProgress] - Progress callback (0-100)
 * @returns {Promise<Object>} SARdine-compatible dataset object
 */
export async function loadNITF(file, onProgress) {
  const progress = onProgress || (() => {});
  console.log(`[NITF Loader] Opening: ${file.name} (${(file.size / 1e9).toFixed(2)} GB)`);
  progress(5);

  // ── 1. Read file header (first 1 KB is always enough) ──
  const headerBuf = await file.slice(0, 1024).arrayBuffer();
  const fh = parseFileHeader(headerBuf);
  console.log('[NITF Loader] File header:', {
    version: fh.version, title: fh.ftitle,
    images: fh.numi, des: fh.numdes,
  });

  if (fh.numi === 0) throw new Error('NITF file contains no image segments');

  // ── 2. Read image subheader ──
  const imgSubStart = fh.hl;
  const imgSubLen = fh.images[0].subheaderLen;
  const imgSubBuf = await file.slice(imgSubStart, imgSubStart + imgSubLen).arrayBuffer();
  const img = parseImageSubheader(imgSubBuf);
  console.log('[NITF Loader] Image:', {
    id: img.iid1, size: `${img.nrows}×${img.ncols}`,
    pvtype: img.pvtype, irep: img.irep, icat: img.icat,
    compression: img.ic, bands: img.totalBands,
    imode: img.imode, nbpp: img.nbpp,
    bandInfo: img.bands.map(b => b.isubcat).join(','),
  });

  if (img.ic !== 'NC' && img.ic !== 'NM') {
    throw new Error(`Compressed NITF not yet supported (IC=${img.ic}). Only uncompressed (NC/NM) files work.`);
  }

  progress(15);

  // Image data starts right after the image subheader
  const dataOffset = imgSubStart + imgSubLen;
  const dataLen = fh.images[0].dataLen;

  // ── 3. Parse coordinates ──
  let geoBounds = null;
  let corners = null;
  let sicd = null;

  // Try IGEOLO first
  corners = parseIGEOLO(img.icords, img.igeolo);

  // Try SICD XML from DES
  if (fh.numdes > 0) {
    let desOffset = dataOffset + dataLen;
    for (let i = 0; i < fh.numdes; i++) {
      const desSubLen = fh.des[i].subheaderLen;
      const desDataLen = fh.des[i].dataLen;

      // Read DES subheader to check type
      const desSubBuf = await file.slice(desOffset, desOffset + desSubLen).arrayBuffer();
      const desSubStr = readStr(new DataView(desSubBuf), 0, Math.min(25, desSubLen));

      if (desSubStr.includes('XML_DATA_CONTENT')) {
        // Read the DES data (SICD XML)
        const desDataBuf = await file.slice(
          desOffset + desSubLen,
          desOffset + desSubLen + desDataLen
        ).arrayBuffer();
        const decoder = new TextDecoder('utf-8');
        const xmlStr = decoder.decode(desDataBuf);

        if (xmlStr.includes('<SICD')) {
          sicd = parseSICDXml(xmlStr);
          console.log('[NITF Loader] SICD metadata:', {
            collector: sicd.collector,
            mode: sicd.modeType,
            pixelType: sicd.pixelType,
            corners: sicd.corners?.map(c => `${c[0].toFixed(3)},${c[1].toFixed(3)}`),
          });
          if (sicd.corners) corners = sicd.corners;
        }
      }

      desOffset += desSubLen + desDataLen;
    }
  }

  // ── Build rigorous projection from SICD geometry (sarpy-equivalent) ──
  //
  // If the SICD XML provides the Grid + SCP + SCPPixel fields, we compute
  // geoBounds from imageBboxFromProjection() rather than from the ImageCorners
  // ICPs. The ICPs are metadata and may be less accurate than the rigorous
  // plane projection built from SCP + Grid.Row/Col.UVectECF.
  let projection = null;
  let projectedCorners = null;
  if (sicd && sicd.geometry?.rowUVect && sicd.geometry?.colUVect &&
      sicd.geometry?.rowSS && sicd.geometry?.colSS &&
      sicd.scp?.ecef && sicd.scpPixel) {
    try {
      // Inject chip dimensions in case SICD didn't populate NumRows/NumCols
      if (!sicd.nrows) sicd.nrows = img.nrows;
      if (!sicd.ncols) sicd.ncols = img.ncols;
      const proj = buildSICDProjection(sicd);
      const { bbox, corners: projCorners } = imageBboxFromProjection(proj);
      projection = proj;
      projectedCorners = projCorners;
      geoBounds = bbox;
      console.log('[NITF Loader] Georeferencing: SICD projection (sarpy-equivalent)');
      console.log('[NITF Loader]   bbox:', bbox.map(v => v.toFixed(5)).join(', '));
    } catch (e) {
      console.warn('[NITF Loader] SICD projection build failed:', e.message);
    }
  }

  if (!projection) {
    if (corners) {
      geoBounds = cornersToBbox(corners);
      console.warn(
        '\n' +
        '════════════════════════════════════════════════════════════════════\n' +
        '⚠  NITF Loader: Falling back to ImageCorners (ICP) for geoBounds.\n' +
        '   The SICD projection requires:\n' +
        '     • GeoData.SCP.ECF\n' +
        '     • ImageData.SCPPixel (Row + Col)\n' +
        '     • Grid.Row.UVectECF + Grid.Row.SS\n' +
        '     • Grid.Col.UVectECF + Grid.Col.SS\n' +
        '   One or more of these is missing from this NITF. Geolocation\n' +
        '   will use the ICP corners directly, which may be less accurate\n' +
        '   than a rigorous plane projection and does not model layover.\n' +
        '════════════════════════════════════════════════════════════════════'
      );
    } else {
      console.warn('[NITF Loader] No georeferencing found, using pixel coordinates');
      geoBounds = [0, 0, img.ncols, img.nrows];
    }
  }

  progress(25);

  const isComplex = img.totalBands === 2 &&
    img.bands[0]?.isubcat === 'I' && img.bands[1]?.isubcat === 'Q';

  // Radiometric calibration: sigma0 = SF × (I² + Q²)
  // Falls back to 1.0 (uncalibrated power) if no SICD metadata
  const calSF = sicd?.sigmaZeroSF || 1.0;
  if (sicd?.sigmaZeroSF) {
    console.log(`[NITF Loader] Sigma0 calibration: SF=${calSF.toExponential(4)}`);
  }

  const { nrows, ncols } = img;
  const bpp = bytesPerPixelBand(img.pvtype, img.nbpp);
  const pixelBytes = img.imode === 'P' ? img.totalBands * bpp : bpp;
  const rowBytes = ncols * pixelBytes;

  console.log('[NITF Loader] Ready:', {
    complex: isComplex,
    geoBounds,
    dataOffset,
    totalBytes: dataLen,
    bpp, pixelBytes, rowBytes,
  });

  // ── 4. Build tile reader ──

  /**
   * getTile — reads only the pixel rows/cols needed for a 256×256 tile.
   * Uses stride to downsample at low zoom levels.
   */
  async function getTile({ x, y, z, bbox }) {
    try {
      const tileSize = 256;

      // Get world rectangle
      let wxMin, wxMax, wyMin, wyMax;
      if (bbox && bbox.left !== undefined) {
        wxMin = Math.min(bbox.left, bbox.right);
        wxMax = Math.max(bbox.left, bbox.right);
        wyMin = Math.min(bbox.top, bbox.bottom);
        wyMax = Math.max(bbox.top, bbox.bottom);
      } else {
        const worldSize = tileSize / Math.pow(2, z);
        wxMin = x * worldSize;
        wxMax = wxMin + worldSize;
        wyMin = y * worldSize;
        wyMax = wyMin + worldSize;
      }

      // Map world coords to pixel coords (world Y is flipped: Y=0 bottom)
      const pxLeft = Math.max(0, Math.floor(wxMin));
      const pxRight = Math.min(ncols, Math.ceil(wxMax));
      const pxTop = Math.max(0, Math.floor(nrows - wyMax));
      const pxBottom = Math.min(nrows, Math.ceil(nrows - wyMin));

      if (pxLeft >= pxRight || pxTop >= pxBottom) return null;

      const srcW = pxRight - pxLeft;
      const srcH = pxBottom - pxTop;

      // Compute stride: how many source pixels per output pixel
      const stride = Math.max(1, Math.floor(Math.max(srcW, srcH) / tileSize));

      const outW = Math.min(tileSize, Math.ceil(srcW / stride));
      const outH = Math.min(tileSize, Math.ceil(srcH / stride));

      // Strategy: batch rows that are close together into a single File.slice(),
      // then extract the needed columns with stride.
      // For large strides at low zoom, we read individual rows to skip data.
      // For small strides (full/near-full res), we bulk-read the row range.
      const out = new Float32Array(outW * outH);

      if (stride <= 8) {
        // Bulk read: one File.slice() for the entire row range, then stride in JS.
        const byteStart = dataOffset + pxTop * rowBytes;
        const readRowCount = Math.min(srcH, nrows - pxTop);
        const byteEnd = dataOffset + (pxTop + readRowCount) * rowBytes;
        const blob = file.slice(byteStart, byteEnd);
        const buf = await blob.arrayBuffer();
        const dv = new DataView(buf);

        if (isComplex && img.imode === 'P' && bpp === 2) {
          decodeComplexInt16P(dv, out, outW, outH, ncols, pxLeft, stride, stride, readRowCount, calSF);
        } else if (img.pvtype === 'R' && bpp === 4) {
          decodeFloat32(dv, out, outW, outH, ncols, pxLeft, stride, stride, readRowCount);
        } else if (bpp === 2) {
          decodeInt16(dv, out, outW, outH, ncols, pxLeft, stride, stride, readRowCount);
        }
      } else {
        // Large stride: read individual rows to avoid pulling GB of data
        for (let r = 0; r < outH; r++) {
          const srcRow = pxTop + r * stride;
          if (srcRow >= nrows) break;

          const rowStart = dataOffset + srcRow * rowBytes;
          const rowBlob = file.slice(rowStart, rowStart + rowBytes);
          const rowBuf = await rowBlob.arrayBuffer();
          const dv = new DataView(rowBuf);

          if (isComplex && img.imode === 'P' && bpp === 2) {
            decodeComplexInt16P(dv, out.subarray(r * outW), outW, 1, ncols, pxLeft, stride, 1, 1, calSF);
          } else if (img.pvtype === 'R' && bpp === 4) {
            decodeFloat32(dv, out.subarray(r * outW), outW, 1, ncols, pxLeft, stride, 1, 1);
          } else if (bpp === 2) {
            decodeInt16(dv, out.subarray(r * outW), outW, 1, ncols, pxLeft, stride, 1, 1);
          }
        }
      }

      return { data: out, width: outW, height: outH };
    } catch (error) {
      console.error(`[NITF Loader] Tile error x:${x} y:${y} z:${z}:`, error);
      return null;
    }
  }

  /**
   * readRegion — read a rectangular region and return Float32Array of decoded values.
   * Used by getExportStripe and getPixelValue.
   */
  async function readRegion(startRow, numSrcRows, startCol, numSrcCols) {
    const clampedRows = Math.min(numSrcRows, nrows - startRow);
    if (clampedRows <= 0) return { data: new Float32Array(0), width: 0, height: 0 };

    const byteStart = dataOffset + startRow * rowBytes;
    const byteEnd = dataOffset + (startRow + clampedRows) * rowBytes;
    const blob = file.slice(byteStart, byteEnd);
    const buf = await blob.arrayBuffer();
    const dv = new DataView(buf);

    const outW = numSrcCols;
    const outH = clampedRows;
    const out = new Float32Array(outW * outH);

    if (isComplex && img.imode === 'P' && bpp === 2) {
      decodeComplexInt16P(dv, out, outW, outH, ncols, startCol, 1, 1, clampedRows, calSF);
    } else if (img.pvtype === 'R' && bpp === 4) {
      decodeFloat32(dv, out, outW, outH, ncols, startCol, 1, 1, clampedRows);
    } else if (bpp === 2) {
      decodeInt16(dv, out, outW, outH, ncols, startCol, 1, 1, clampedRows);
    }

    return { data: out, width: outW, height: outH };
  }

  /**
   * getExportStripe — read a stripe for GeoTIFF export with multilook.
   */
  async function getExportStripe({ startRow, numRows, ml, exportWidth, startCol = 0, numCols: outCols_ }) {
    const outCols = outCols_ || exportWidth;

    const srcStartRow = startRow * ml;
    const srcNumRows = numRows * ml;
    const srcStartCol = startCol * ml;
    const srcNumCols = outCols * ml;
    const region = await readRegion(srcStartRow, srcNumRows, srcStartCol, Math.min(srcNumCols, ncols - srcStartCol));

    // Multilook box-average
    const out = new Float32Array(outCols * numRows);
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < outCols; c++) {
        let sum = 0, cnt = 0;
        const r0 = r * ml;
        const c0 = c * ml;
        for (let dr = 0; dr < ml && r0 + dr < region.height; dr++) {
          for (let dc = 0; dc < ml && c0 + dc < region.width; dc++) {
            const v = region.data[(r0 + dr) * region.width + (c0 + dc)];
            if (!isNaN(v) && v !== 0) { sum += v; cnt++; }
          }
        }
        out[r * outCols + c] = cnt > 0 ? sum / cnt : NaN;
      }
    }

    return { bands: { band0: out } };
  }

  /**
   * getPixelValue — read a single pixel value.
   */
  async function getPixelValue(row, col) {
    if (row < 0 || row >= nrows || col < 0 || col >= ncols) return NaN;
    const region = await readRegion(row, 1, col, 1);
    return region.data[0] ?? NaN;
  }

  progress(100);

  const result = {
    getTile,
    getExportStripe,
    getPixelValue,
    bounds: [0, 0, ncols, nrows],    // pixel space for deck.gl tile indexing
    geoBounds,
    worldBounds: geoBounds,
    // Rigorous sarpy-equivalent projection (null if SICD fields missing → ICP fallback)
    projection,
    projectedCorners,
    crs: 'EPSG:4326',
    width: ncols,
    height: nrows,
    sourceWidth: ncols,
    sourceHeight: nrows,
    tileWidth: 256,
    tileHeight: 256,
    resolution: geoBounds ? [
      (geoBounds[2] - geoBounds[0]) / ncols,
      (geoBounds[3] - geoBounds[1]) / nrows,
    ] : null,
    isCOG: false,
    imageCount: 1,
    // Extra NITF-specific info
    nitfInfo: {
      title: fh.ftitle,
      compression: img.ic,
      isComplex,
      pvtype: img.pvtype,
      irep: img.irep,
      icat: img.icat,
      nbpp: img.nbpp,
      bands: img.bands,
      imode: img.imode,
      sicd,
    },
  };

  console.log('[NITF Loader] Loaded:', {
    width: ncols, height: nrows,
    bounds: result.bounds,
    geoBounds,
    complex: isComplex,
  });

  return result;
}

/**
 * Parse a NITF file from an in-memory ArrayBuffer (no File needed).
 * Suitable for Node scripts — pass a DOMParser implementation for SICD XML.
 *
 * Only parses header/subheader/SICD metadata. Does NOT read pixel data.
 *
 * @param {ArrayBuffer} buffer   Full NITF file as ArrayBuffer
 * @param {Function} [DOMParserImpl]  DOMParser constructor (e.g. from @xmldom/xmldom)
 * @returns {{ fileHeader, imageSubheader, sicd }}
 */
export function parseNITFMetadataFromBuffer(buffer, DOMParserImpl) {
  const fh = parseFileHeader(buffer.slice(0, 2048));
  if (fh.numi === 0) throw new Error('NITF file contains no image segments');

  const imgSubStart = fh.hl;
  const imgSubLen = fh.images[0].subheaderLen;
  const img = parseImageSubheader(buffer.slice(imgSubStart, imgSubStart + imgSubLen));

  const dataOffset = imgSubStart + imgSubLen;
  const dataLen = fh.images[0].dataLen;

  let sicd = null;
  if (fh.numdes > 0) {
    let desOffset = dataOffset + dataLen;
    for (let i = 0; i < fh.numdes; i++) {
      const desSubLen = fh.des[i].subheaderLen;
      const desDataLen = fh.des[i].dataLen;
      const desSubBuf = buffer.slice(desOffset, desOffset + desSubLen);
      const desSubStr = readStr(new DataView(desSubBuf), 0, Math.min(25, desSubLen));
      if (desSubStr.includes('XML_DATA_CONTENT')) {
        const desDataBuf = buffer.slice(desOffset + desSubLen, desOffset + desSubLen + desDataLen);
        const xmlStr = new TextDecoder('utf-8').decode(desDataBuf);
        if (xmlStr.includes('<SICD')) {
          sicd = parseSICDXml(xmlStr, DOMParserImpl);
          break;
        }
      }
      desOffset += desSubLen + desDataLen;
    }
  }

  return { fileHeader: fh, imageSubheader: img, sicd };
}

export { parseSICDXml, parseFileHeader, parseImageSubheader };

/**
 * Check if a filename looks like a NITF file.
 */
export function isNITFFile(filename) {
  const lower = filename.toLowerCase();
  return lower.endsWith('.nitf') || lower.endsWith('.ntf');
}
