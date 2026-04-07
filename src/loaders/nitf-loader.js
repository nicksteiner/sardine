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
function parseSICDXml(xmlStr) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'text/xml');

  const result = {};

  // Image corners
  const icps = doc.querySelectorAll('ImageCorners ICP');
  if (icps.length >= 4) {
    // SICD corner order: 1:FRFC (UL), 2:FRLC (UR), 3:LRLC (LR), 4:LRFC (LL)
    const corners = [];
    for (const icp of icps) {
      const lat = parseFloat(icp.querySelector('Lat')?.textContent);
      const lon = parseFloat(icp.querySelector('Lon')?.textContent);
      corners.push([lat, lon]);
    }
    result.corners = corners;
  }

  // Scene center point
  const scpLat = doc.querySelector('GeoData SCP LLH Lat');
  const scpLon = doc.querySelector('GeoData SCP LLH Lon');
  const scpHae = doc.querySelector('GeoData SCP LLH HAE');
  if (scpLat && scpLon) {
    result.scp = {
      lat: parseFloat(scpLat.textContent),
      lon: parseFloat(scpLon.textContent),
      hae: scpHae ? parseFloat(scpHae.textContent) : 0,
    };
  }

  // Image dimensions (from SICD metadata, cross-check)
  const numRows = doc.querySelector('ImageData NumRows');
  const numCols = doc.querySelector('ImageData NumCols');
  if (numRows) result.nrows = parseInt(numRows.textContent);
  if (numCols) result.ncols = parseInt(numCols.textContent);

  // Pixel type
  const pixelType = doc.querySelector('ImageData PixelType');
  if (pixelType) result.pixelType = pixelType.textContent;

  // Collector info
  const collector = doc.querySelector('CollectionInfo CollectorName');
  if (collector) result.collector = collector.textContent;

  const modeType = doc.querySelector('RadarMode ModeType');
  if (modeType) result.modeType = modeType.textContent;

  // Radiometric calibration scale factors (constant polynomials)
  const sigmaZeroSF = doc.querySelector('Radiometric SigmaZeroSFPoly Coef');
  if (sigmaZeroSF) result.sigmaZeroSF = parseFloat(sigmaZeroSF.textContent);

  const betaZeroSF = doc.querySelector('Radiometric BetaZeroSFPoly Coef');
  if (betaZeroSF) result.betaZeroSF = parseFloat(betaZeroSF.textContent);

  const gammaZeroSF = doc.querySelector('Radiometric GammaZeroSFPoly Coef');
  if (gammaZeroSF) result.gammaZeroSF = parseFloat(gammaZeroSF.textContent);

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

  if (corners) {
    geoBounds = cornersToBbox(corners);
  } else {
    console.warn('[NITF Loader] No georeferencing found, using pixel coordinates');
    geoBounds = [0, 0, img.ncols, img.nrows];
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
 * Check if a filename looks like a NITF file.
 */
export function isNITFFile(filename) {
  const lower = filename.toLowerCase();
  return lower.endsWith('.nitf') || lower.endsWith('.ntf');
}
