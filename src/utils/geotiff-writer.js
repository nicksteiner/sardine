/**
 * Cloud Optimized GeoTIFF Writer
 *
 * Produces valid Cloud Optimized GeoTIFFs with:
 *   - RGBA uint8 (4-band with alpha channel)
 *   - 512×512 tiled layout
 *   - DEFLATE compression with horizontal predictor
 *   - Overview pyramids (2×, 4×, 8× downsampling)
 *   - Full georeferencing (ModelTiepoint, ModelPixelScale, GeoKeys, CRS)
 *
 * Based on TIFF 6.0, GeoTIFF 1.1, and COG 1.0 specifications.
 */

import pako from 'pako';

// TIFF tag IDs
const TAG_NEW_SUBFILE_TYPE = 254;
const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_PLANAR_CONFIG = 284;
const TAG_PREDICTOR = 317;
const TAG_TILE_WIDTH = 322;
const TAG_TILE_LENGTH = 323;
const TAG_TILE_OFFSETS = 324;
const TAG_TILE_BYTE_COUNTS = 325;
const TAG_EXTRA_SAMPLES = 338;
const TAG_SAMPLE_FORMAT = 339;

// GDAL metadata tag
const TAG_GDAL_NODATA = 42113;

// GeoTIFF tag IDs
const TAG_MODEL_PIXEL_SCALE = 33550;
const TAG_MODEL_TIEPOINT = 33922;
const TAG_GEO_KEY_DIRECTORY = 34735;
const TAG_GEO_DOUBLE_PARAMS = 34736;
const TAG_GEO_ASCII_PARAMS = 34737;

// TIFF types
const TYPE_ASCII = 2;    // null-terminated string
const TYPE_SHORT = 3;    // uint16
const TYPE_LONG = 4;     // uint32
const TYPE_DOUBLE = 12;  // float64

// GeoKey IDs
const KEY_GT_MODEL_TYPE = 1024;
const KEY_GT_RASTER_TYPE = 1025;
const KEY_GEOGRAPHIC_TYPE = 2048;
const KEY_PROJECTED_CS_TYPE = 3072;

// Constants
const TILE_SIZE = 512;
const MODEL_TYPE_PROJECTED = 1;
const MODEL_TYPE_GEOGRAPHIC = 2;
const RASTER_TYPE_PIXEL_IS_AREA = 1;

/**
 * Write a Cloud Optimized RGBA GeoTIFF.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgbaData - RGBA pixel data (4 bytes per pixel)
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {number[]} bounds - [minX, minY, maxX, maxY] in CRS coordinates
 * @param {number} epsgCode - EPSG code (e.g. 32610 for UTM 10N, 4326 for WGS84)
 * @param {object} options - Optional parameters
 * @param {boolean} options.generateOverviews - Generate overview pyramids (default: true)
 * @param {function} options.onProgress - Progress callback (percent)
 * @param {object|number[]} options.dbLimits - dB contrast limits for SAR multilook
 *   Can be uniform [min, max] or per-channel {R: [min,max], G: [min,max], B: [min,max]}
 * @param {boolean} options.useDecibels - Whether data was converted from dB (default: true)
 * @param {number} options.multilookWindow - Multilook averaging window size (default: matches overview scale)
 *   E.g., multilookWindow=4 uses 4×4 averaging for all overview levels
 * @returns {ArrayBuffer} Valid Cloud Optimized GeoTIFF file
 */
export function writeRGBAGeoTIFF(rgbaData, width, height, bounds, epsgCode = 32610, options = {}) {
  const { generateOverviews = true, onProgress, dbLimits, useDecibels = true, multilookWindow } = options;

  // Validate inputs
  if (rgbaData.length !== width * height * 4) {
    throw new Error(`RGBA data size mismatch: expected ${width * height * 4}, got ${rgbaData.length}`);
  }

  // Report progress
  const reportProgress = (pct) => {
    if (onProgress) onProgress(pct);
  };

  reportProgress(0);

  // Generate image pyramid
  const pyramid = [{ data: rgbaData, width, height }];

  if (generateOverviews) {
    let currentLevel = { data: rgbaData, width, height };
    let scale = 2;

    // Generate overviews until smaller than TILE_SIZE in both dimensions
    while (currentLevel.width / scale >= TILE_SIZE && currentLevel.height / scale >= TILE_SIZE) {
      // Use user-specified multilook window or default to overview scale
      const mlWindow = multilookWindow || scale;

      const overview = generateOverview(
        currentLevel.data,
        currentLevel.width,
        currentLevel.height,
        scale,
        { dbLimits, useDecibels, multilookWindow: mlWindow }
      );
      const ovWidth = Math.floor(currentLevel.width / scale);
      const ovHeight = Math.floor(currentLevel.height / scale);
      pyramid.push({ data: overview, width: ovWidth, height: ovHeight });

      // Move to next level (only generate 2×, 4×, 8× for COG standard)
      scale *= 2;
      if (scale > 8) break;
    }
  }

  reportProgress(20);

  // Pass 1: Compress all tiles and collect sizes
  const levels = [];

  for (let i = 0; i < pyramid.length; i++) {
    const { data, width: lvlWidth, height: lvlHeight } = pyramid[i];
    const tiles = extractAndCompressTiles(data, lvlWidth, lvlHeight);
    levels.push({ width: lvlWidth, height: lvlHeight, tiles });
    reportProgress(20 + (i + 1) / pyramid.length * 60);
  }

  // Pass 2: Calculate file layout and write
  const buffer = buildCOGFile(levels, bounds, epsgCode);
  reportProgress(100);

  return buffer;
}

/**
 * Legacy RGB export (deprecated - use writeRGBAGeoTIFF instead)
 * Converts RGBA to RGB by dropping alpha channel
 */
export function writeRGBGeoTIFF(rgbaData, width, height, bounds, epsgCode = 32610) {
  console.warn('writeRGBGeoTIFF is deprecated. Use writeRGBAGeoTIFF for better transparency support.');

  // Convert RGBA to RGB (drop alpha)
  const rgbData = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgbData[i * 3] = rgbaData[i * 4];
    rgbData[i * 3 + 1] = rgbaData[i * 4 + 1];
    rgbData[i * 3 + 2] = rgbaData[i * 4 + 2];
  }

  // Write as RGB using legacy single-strip format
  return writeLegacyRGBGeoTIFF(rgbData, width, height, bounds, epsgCode);
}

/**
 * Generate overview pyramid level using box-filter averaging
 * For SAR data with dB scaling, uses inverse-dB multilook for statistical correctness
 *
 * @param {Uint8ClampedArray} rgbaData - Source RGBA data
 * @param {number} width - Source width
 * @param {number} height - Source height
 * @param {number} scale - Overview scale factor (2×, 4×, 8×)
 * @param {object} options - Options
 * @param {object|number[]} options.dbLimits - dB contrast limits
 * @param {boolean} options.useDecibels - Whether to use inverse-dB multilook
 * @param {number} options.multilookWindow - Multilook window size (independent of scale)
 */
function generateOverview(rgbaData, width, height, scale, options = {}) {
  const { dbLimits, useDecibels = true, multilookWindow } = options;
  const newWidth = Math.floor(width / scale);
  const newHeight = Math.floor(height / scale);
  const overview = new Uint8ClampedArray(newWidth * newHeight * 4);

  // Determine if we have per-channel or uniform dB limits
  const hasDbLimits = dbLimits && useDecibels;
  const isPerChannel = hasDbLimits && typeof dbLimits === 'object' && dbLimits.R;

  // Multilook window (defaults to scale if not specified)
  const mlWindow = multilookWindow || scale;

  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const outIdx = (y * newWidth + x) * 4;

      // Process each channel (R, G, B, Alpha)
      for (let c = 0; c < 4; c++) {
        if (c === 3) {
          // Alpha channel: simple averaging using multilook window
          let sumA = 0, count = 0;

          // Center the multilook window on the target pixel
          const startY = Math.floor(y * scale - (mlWindow - scale) / 2);
          const startX = Math.floor(x * scale - (mlWindow - scale) / 2);

          for (let dy = 0; dy < mlWindow; dy++) {
            for (let dx = 0; dx < mlWindow; dx++) {
              const srcX = startX + dx;
              const srcY = startY + dy;
              if (srcX >= 0 && srcX < width && srcY >= 0 && srcY < height) {
                const idx = (srcY * width + srcX) * 4 + 3;
                sumA += rgbaData[idx];
                count++;
              }
            }
          }
          overview[outIdx + 3] = count > 0 ? Math.round(sumA / count) : 0;
        } else {
          // RGB channels: use inverse-dB multilook if limits available
          if (hasDbLimits) {
            // Get dB limits for this channel
            let dbMin, dbMax;
            if (isPerChannel) {
              const channelName = ['R', 'G', 'B'][c];
              dbMin = dbLimits[channelName][0];
              dbMax = dbLimits[channelName][1];
            } else {
              dbMin = dbLimits[0];
              dbMax = dbLimits[1];
            }

            // Average in linear power space (SAR multilook) using multilook window
            let sumLinear = 0, count = 0;

            // Center the multilook window on the target pixel
            const startY = Math.floor(y * scale - (mlWindow - scale) / 2);
            const startX = Math.floor(x * scale - (mlWindow - scale) / 2);

            for (let dy = 0; dy < mlWindow; dy++) {
              for (let dx = 0; dx < mlWindow; dx++) {
                const srcX = startX + dx;
                const srcY = startY + dy;

                if (srcX >= 0 && srcX < width && srcY >= 0 && srcY < height) {
                  const idx = (srcY * width + srcX) * 4 + c;
                  const uint8Val = rgbaData[idx];

                  // Inverse transform: uint8 → [0,1] → dB → linear power
                  const normalized = uint8Val / 255.0;
                  const db = normalized * (dbMax - dbMin) + dbMin;
                  const linear = Math.pow(10, db / 10);

                  sumLinear += linear;
                  count++;
                }
              }
            }

            if (count > 0) {
              // Average in linear space, then convert back to dB
              const avgLinear = sumLinear / count;
              const avgDb = 10 * Math.log10(Math.max(avgLinear, 1e-10));

              // Forward transform: dB → [0,1] → uint8
              const normalizedOut = Math.max(0, Math.min(1, (avgDb - dbMin) / (dbMax - dbMin)));
              overview[outIdx + c] = Math.round(normalizedOut * 255);
            } else {
              overview[outIdx + c] = 0;
            }
          } else {
            // Simple averaging in uint8 space (fallback for non-SAR data)
            let sum = 0, count = 0;

            // Center the multilook window on the target pixel
            const startY = Math.floor(y * scale - (mlWindow - scale) / 2);
            const startX = Math.floor(x * scale - (mlWindow - scale) / 2);

            for (let dy = 0; dy < mlWindow; dy++) {
              for (let dx = 0; dx < mlWindow; dx++) {
                const srcX = startX + dx;
                const srcY = startY + dy;

                if (srcX >= 0 && srcX < width && srcY >= 0 && srcY < height) {
                  const idx = (srcY * width + srcX) * 4 + c;
                  sum += rgbaData[idx];
                  count++;
                }
              }
            }

            overview[outIdx + c] = count > 0 ? Math.round(sum / count) : 0;
          }
        }
      }
    }
  }

  return overview;
}

/**
 * Extract tiles from RGBA data and compress with DEFLATE
 */
function extractAndCompressTiles(rgbaData, width, height) {
  const tilesX = Math.ceil(width / TILE_SIZE);
  const tilesY = Math.ceil(height / TILE_SIZE);
  const tiles = [];

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * TILE_SIZE;
      const y0 = ty * TILE_SIZE;
      const x1 = Math.min(x0 + TILE_SIZE, width);
      const y1 = Math.min(y0 + TILE_SIZE, height);
      const tileW = x1 - x0;
      const tileH = y1 - y0;

      // Extract tile (may be partial at edges)
      const tileData = extractTile(rgbaData, width, height, x0, y0, tileW, tileH);

      // Apply horizontal predictor for better compression
      const predicted = applyHorizontalPredictor(tileData, tileW, tileH);

      // Compress with DEFLATE
      const compressed = pako.deflate(predicted, { level: 6 });

      tiles.push({
        x: tx,
        y: ty,
        width: tileW,
        height: tileH,
        data: compressed,
        byteCount: compressed.byteLength
      });
    }
  }

  return tiles;
}

/**
 * Extract a single tile from RGBA image data
 */
function extractTile(rgbaData, imgWidth, imgHeight, x0, y0, tileW, tileH) {
  // Always allocate full TILE_SIZE×TILE_SIZE to maintain consistent tile dimensions
  // Fill with zeros (transparent black) for partial tiles
  const tileData = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);

  for (let y = 0; y < tileH; y++) {
    for (let x = 0; x < tileW; x++) {
      const srcIdx = ((y0 + y) * imgWidth + (x0 + x)) * 4;
      const dstIdx = (y * TILE_SIZE + x) * 4;

      tileData[dstIdx] = rgbaData[srcIdx];
      tileData[dstIdx + 1] = rgbaData[srcIdx + 1];
      tileData[dstIdx + 2] = rgbaData[srcIdx + 2];
      tileData[dstIdx + 3] = rgbaData[srcIdx + 3];
    }
  }

  return tileData;
}

/**
 * Apply horizontal predictor (TIFF Predictor tag value 2)
 * Encodes each pixel as the difference from the previous pixel
 */
function applyHorizontalPredictor(data, width, height) {
  const predicted = new Uint8Array(data.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * TILE_SIZE + x) * 4;

      if (x === 0) {
        // First pixel in row: no prediction
        predicted[idx] = data[idx];
        predicted[idx + 1] = data[idx + 1];
        predicted[idx + 2] = data[idx + 2];
        predicted[idx + 3] = data[idx + 3];
      } else {
        // Subsequent pixels: difference from previous
        const prevIdx = (y * TILE_SIZE + (x - 1)) * 4;
        predicted[idx] = (data[idx] - data[prevIdx]) & 0xFF;
        predicted[idx + 1] = (data[idx + 1] - data[prevIdx + 1]) & 0xFF;
        predicted[idx + 2] = (data[idx + 2] - data[prevIdx + 2]) & 0xFF;
        predicted[idx + 3] = (data[idx + 3] - data[prevIdx + 3]) & 0xFF;
      }
    }
  }

  return predicted;
}

/**
 * Build complete COG file with IFD chain and tile data
 */
function buildCOGFile(levels, bounds, epsgCode) {
  const [minX, minY, maxX, maxY] = bounds;

  // Calculate pixel scale (geotransform)
  const pixelScaleX = (maxX - minX) / levels[0].width;
  const pixelScaleY = (maxY - minY) / levels[0].height;

  // Build IFDs for all levels
  const ifds = [];

  for (let i = 0; i < levels.length; i++) {
    const { width, height, tiles } = levels[i];
    const isOverview = i > 0;

    // Scale-adjusted pixel scale for overviews
    const scale = Math.pow(2, i);
    const levelPixelScaleX = pixelScaleX * scale;
    const levelPixelScaleY = pixelScaleY * scale;

    const ifd = buildIFD(
      width,
      height,
      tiles,
      { minX, minY, maxX, maxY },
      { pixelScaleX: levelPixelScaleX, pixelScaleY: levelPixelScaleY },
      epsgCode,
      isOverview
    );

    ifds.push(ifd);
  }

  // Calculate file layout
  const headerSize = 8;
  let currentOffset = headerSize;

  // Reserve space for all IFDs
  const ifdOffsets = [];
  for (let i = 0; i < ifds.length; i++) {
    ifdOffsets.push(currentOffset);
    currentOffset += ifds[i].ifdSize;
  }

  // Overflow data (TileOffsets arrays, etc.)
  for (let i = 0; i < ifds.length; i++) {
    ifds[i].overflowOffset = currentOffset;
    currentOffset += ifds[i].overflowSize;
    // Align to word boundary
    if (currentOffset % 2 !== 0) currentOffset++;
  }

  // Tile data
  for (let i = 0; i < ifds.length; i++) {
    ifds[i].tileDataOffset = currentOffset;
    const totalTileBytes = ifds[i].tiles.reduce((sum, t) => sum + t.byteCount, 0);
    currentOffset += totalTileBytes;
  }

  // Allocate buffer
  const totalSize = currentOffset;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let pos = 0;

  // Write TIFF header
  view.setUint16(pos, 0x4949, true); pos += 2; // Little-endian
  view.setUint16(pos, 42, true); pos += 2;      // Magic number
  view.setUint32(pos, ifdOffsets[0], true); pos += 4; // First IFD offset

  // Write IFDs
  for (let i = 0; i < ifds.length; i++) {
    const ifd = ifds[i];
    const nextIFDOffset = i < ifds.length - 1 ? ifdOffsets[i + 1] : 0;

    pos = ifdOffsets[i];
    pos = writeIFD(view, bytes, pos, ifd, nextIFDOffset);
  }

  // Write overflow data and tile data
  for (let i = 0; i < ifds.length; i++) {
    const ifd = ifds[i];

    // Write overflow data (arrays too large to fit in IFD entries)
    pos = ifd.overflowOffset;
    pos = writeOverflowData(view, bytes, pos, ifd);

    // Write tile data
    pos = ifd.tileDataOffset;
    for (const tile of ifd.tiles) {
      bytes.set(tile.data, pos);
      pos += tile.byteCount;
    }
  }

  return buffer;
}

/**
 * Build IFD (Image File Directory) for one pyramid level
 */
function buildIFD(width, height, tiles, bounds, pixelScale, epsgCode, isOverview) {
  const entries = [];

  // NewSubfileType (254) - 0 for full res, 1 for reduced-resolution
  if (isOverview) {
    entries.push(makeEntry(TAG_NEW_SUBFILE_TYPE, TYPE_LONG, 1, 1));
  }

  // Image dimensions
  entries.push(makeEntry(TAG_IMAGE_WIDTH, TYPE_LONG, 1, width));
  entries.push(makeEntry(TAG_IMAGE_LENGTH, TYPE_LONG, 1, height));

  // BitsPerSample: [8, 8, 8, 8] for RGBA
  entries.push(makeArrayEntry(TAG_BITS_PER_SAMPLE, TYPE_SHORT, [8, 8, 8, 8]));

  // Compression: 8 = DEFLATE
  entries.push(makeEntry(TAG_COMPRESSION, TYPE_SHORT, 1, 8));

  // Photometric: 2 = RGB
  entries.push(makeEntry(TAG_PHOTOMETRIC, TYPE_SHORT, 1, 2));

  // SamplesPerPixel: 4 (RGBA)
  entries.push(makeEntry(TAG_SAMPLES_PER_PIXEL, TYPE_SHORT, 1, 4));

  // PlanarConfig: 1 = chunky/interleaved
  entries.push(makeEntry(TAG_PLANAR_CONFIG, TYPE_SHORT, 1, 1));

  // Predictor: 2 = horizontal differencing
  entries.push(makeEntry(TAG_PREDICTOR, TYPE_SHORT, 1, 2));

  // TileWidth, TileLength
  entries.push(makeEntry(TAG_TILE_WIDTH, TYPE_LONG, 1, TILE_SIZE));
  entries.push(makeEntry(TAG_TILE_LENGTH, TYPE_LONG, 1, TILE_SIZE));

  // TileOffsets (array)
  const tileOffsets = new Array(tiles.length).fill(0); // Placeholder
  entries.push(makeArrayEntry(TAG_TILE_OFFSETS, TYPE_LONG, tileOffsets));

  // TileByteCounts (array)
  const tileByteCounts = tiles.map(t => t.byteCount);
  entries.push(makeArrayEntry(TAG_TILE_BYTE_COUNTS, TYPE_LONG, tileByteCounts));

  // ExtraSamples: 1 = associated alpha (transparency)
  entries.push(makeArrayEntry(TAG_EXTRA_SAMPLES, TYPE_SHORT, [1]));

  // SampleFormat: 1 = unsigned integer
  entries.push(makeArrayEntry(TAG_SAMPLE_FORMAT, TYPE_SHORT, [1, 1, 1, 1]));

  // GeoTIFF tags (required for ALL IFDs including overviews)
  // ModelTiepoint: maps pixel (0,0,0) to world (minX, maxY, 0)
  const { minX, maxY } = bounds;
  entries.push(makeArrayEntry(TAG_MODEL_TIEPOINT, TYPE_DOUBLE, [0, 0, 0, minX, maxY, 0]));

  // ModelPixelScale: pixel size in CRS units (scaled for overviews)
  entries.push(makeArrayEntry(TAG_MODEL_PIXEL_SCALE, TYPE_DOUBLE, [
    pixelScale.pixelScaleX,
    pixelScale.pixelScaleY,
    0
  ]));

  // GeoKeyDirectory
  const isGeographic = epsgCode >= 4000 && epsgCode < 5000;
  const modelType = isGeographic ? MODEL_TYPE_GEOGRAPHIC : MODEL_TYPE_PROJECTED;
  const csKeyId = isGeographic ? KEY_GEOGRAPHIC_TYPE : KEY_PROJECTED_CS_TYPE;

  const geoKeys = [
    1, 1, 0, 3,                                // Header: version 1.1.0, 3 keys
    KEY_GT_MODEL_TYPE, 0, 1, modelType,         // ModelTypeGeoKey
    KEY_GT_RASTER_TYPE, 0, 1, RASTER_TYPE_PIXEL_IS_AREA, // RasterTypeGeoKey
    csKeyId, 0, 1, epsgCode,                    // ProjectedCSTypeGeoKey or GeographicTypeGeoKey
  ];

  entries.push(makeArrayEntry(TAG_GEO_KEY_DIRECTORY, TYPE_SHORT, geoKeys));

  // Sort entries by tag (TIFF requirement)
  entries.sort((a, b) => a.tag - b.tag);

  // Calculate sizes
  const ifdSize = 2 + entries.length * 12 + 4; // count + entries + nextIFD pointer
  let overflowSize = 0;

  for (const entry of entries) {
    const byteSize = getEntryByteSize(entry);
    if (byteSize > 4) {
      entry.needsOverflow = true;
      entry.overflowSize = byteSize;
      overflowSize += byteSize;
      // Align to word boundary
      if (overflowSize % 2 !== 0) overflowSize++;
    }
  }

  return {
    entries,
    tiles,
    ifdSize,
    overflowSize,
    width,
    height
  };
}

/**
 * Write IFD to buffer
 */
function writeIFD(view, bytes, offset, ifd, nextIFDOffset) {
  let pos = offset;

  // Entry count
  view.setUint16(pos, ifd.entries.length, true); pos += 2;

  // Track overflow position
  let overflowPos = ifd.overflowOffset;
  let tileDataPos = ifd.tileDataOffset;

  // Write entries
  for (const entry of ifd.entries) {
    view.setUint16(pos, entry.tag, true); pos += 2;
    view.setUint16(pos, entry.type, true); pos += 2;
    view.setUint32(pos, entry.count, true); pos += 4;

    const byteSize = getEntryByteSize(entry);

    if (byteSize <= 4) {
      // Value fits inline
      writeEntryValue(view, pos, entry);
      pos += 4;
    } else {
      // Special handling for TileOffsets
      if (entry.tag === TAG_TILE_OFFSETS) {
        view.setUint32(pos, overflowPos, true);
        pos += 4;

        // Write TileOffsets array at overflow position
        for (let i = 0; i < ifd.tiles.length; i++) {
          view.setUint32(overflowPos, tileDataPos, true);
          overflowPos += 4;
          tileDataPos += ifd.tiles[i].byteCount;
        }

        // Align
        if (overflowPos % 2 !== 0) overflowPos++;
      } else {
        // Other overflow data
        view.setUint32(pos, overflowPos, true);
        pos += 4;
        entry.overflowPosition = overflowPos;
        overflowPos += entry.overflowSize;
        if (overflowPos % 2 !== 0) overflowPos++;
      }
    }
  }

  // Next IFD pointer
  view.setUint32(pos, nextIFDOffset, true);
  pos += 4;

  return pos;
}

/**
 * Write overflow data (arrays that don't fit in IFD entries)
 */
function writeOverflowData(view, bytes, offset, ifd) {
  let pos = offset;

  for (const entry of ifd.entries) {
    if (entry.needsOverflow && entry.tag !== TAG_TILE_OFFSETS) {
      // TileOffsets already written in writeIFD
      writeEntryArray(view, entry.overflowPosition, entry);
    }
  }

  return pos;
}

/**
 * Helper: Create IFD entry
 */
function makeEntry(tag, type, count, value) {
  return { tag, type, count, value };
}

/**
 * Helper: Create IFD entry with array data
 */
function makeArrayEntry(tag, type, data) {
  return { tag, type, count: data.length, data };
}

/**
 * Helper: Get byte size of entry data
 */
function getEntryByteSize(entry) {
  const typeSize = { [TYPE_ASCII]: 1, [TYPE_SHORT]: 2, [TYPE_LONG]: 4, [TYPE_DOUBLE]: 8 };
  return (typeSize[entry.type] || 2) * entry.count;
}

/**
 * Helper: Write entry value inline (≤4 bytes)
 */
function writeEntryValue(view, pos, entry) {
  // Resolve value: makeEntry sets .value, makeArrayEntry sets .data
  const val = entry.value !== undefined ? entry.value : (entry.data ? entry.data[0] : 0);

  if (entry.type === TYPE_ASCII && entry.asciiValue) {
    // Write ASCII bytes inline (up to 4 bytes including null terminator)
    const str = entry.asciiValue;
    for (let i = 0; i < Math.min(entry.count, 4); i++) {
      view.setUint8(pos + i, i < str.length ? str.charCodeAt(i) : 0);
    }
  } else if (entry.type === TYPE_SHORT && entry.count === 1) {
    view.setUint16(pos, val, true);
  } else if (entry.type === TYPE_LONG && entry.count === 1) {
    view.setUint32(pos, val, true);
  } else if (entry.type === TYPE_SHORT && entry.count === 2 && entry.data) {
    view.setUint16(pos, entry.data[0], true);
    view.setUint16(pos + 2, entry.data[1], true);
  }
}

/**
 * Helper: Write entry array data
 */
function writeEntryArray(view, pos, entry) {
  if (entry.type === TYPE_ASCII && entry.asciiValue) {
    const str = entry.asciiValue;
    for (let i = 0; i < entry.count; i++) {
      view.setUint8(pos + i, i < str.length ? str.charCodeAt(i) : 0);
    }
    return;
  }
  if (entry.type === TYPE_SHORT) {
    for (let i = 0; i < entry.count; i++) {
      view.setUint16(pos, entry.data[i], true);
      pos += 2;
    }
  } else if (entry.type === TYPE_LONG) {
    for (let i = 0; i < entry.count; i++) {
      view.setUint32(pos, entry.data[i], true);
      pos += 4;
    }
  } else if (entry.type === TYPE_DOUBLE) {
    for (let i = 0; i < entry.count; i++) {
      view.setFloat64(pos, entry.data[i], true);
      pos += 8;
    }
  }
}

/**
 * Legacy RGB writer (single-strip, no COG features)
 */
function writeLegacyRGBGeoTIFF(rgbData, width, height, bounds, epsgCode) {
  // Original implementation for backward compatibility
  const [minX, minY, maxX, maxY] = bounds;
  const pixelScaleX = (maxX - minX) / width;
  const pixelScaleY = (maxY - minY) / height;

  const ifdEntries = [];

  ifdEntries.push({ tag: TAG_IMAGE_WIDTH, type: TYPE_LONG, count: 1, value: width });
  ifdEntries.push({ tag: TAG_IMAGE_LENGTH, type: TYPE_LONG, count: 1, value: height });
  ifdEntries.push({ tag: TAG_BITS_PER_SAMPLE, type: TYPE_SHORT, count: 3, data: [8, 8, 8] });
  ifdEntries.push({ tag: TAG_COMPRESSION, type: TYPE_SHORT, count: 1, value: 1 }); // No compression
  ifdEntries.push({ tag: TAG_PHOTOMETRIC, type: TYPE_SHORT, count: 1, value: 2 }); // RGB
  ifdEntries.push({ tag: 273, type: TYPE_LONG, count: 1, value: 0 }); // StripOffsets (placeholder)
  ifdEntries.push({ tag: TAG_SAMPLES_PER_PIXEL, type: TYPE_SHORT, count: 1, value: 3 });
  ifdEntries.push({ tag: 278, type: TYPE_LONG, count: 1, value: height }); // RowsPerStrip
  ifdEntries.push({ tag: 279, type: TYPE_LONG, count: 1, value: rgbData.length }); // StripByteCounts
  ifdEntries.push({ tag: TAG_PLANAR_CONFIG, type: TYPE_SHORT, count: 1, value: 1 });

  // GeoTIFF tags
  ifdEntries.push({ tag: TAG_MODEL_TIEPOINT, type: TYPE_DOUBLE, count: 6, data: [0, 0, 0, minX, maxY, 0] });
  ifdEntries.push({ tag: TAG_MODEL_PIXEL_SCALE, type: TYPE_DOUBLE, count: 3, data: [pixelScaleX, pixelScaleY, 0] });

  const isGeographic = epsgCode >= 4000 && epsgCode < 5000;
  const modelType = isGeographic ? MODEL_TYPE_GEOGRAPHIC : MODEL_TYPE_PROJECTED;
  const csKeyId = isGeographic ? KEY_GEOGRAPHIC_TYPE : KEY_PROJECTED_CS_TYPE;

  const geoKeys = [
    1, 1, 0, 3,
    KEY_GT_MODEL_TYPE, 0, 1, modelType,
    KEY_GT_RASTER_TYPE, 0, 1, RASTER_TYPE_PIXEL_IS_AREA,
    csKeyId, 0, 1, epsgCode,
  ];

  ifdEntries.push({ tag: TAG_GEO_KEY_DIRECTORY, type: TYPE_SHORT, count: geoKeys.length, data: geoKeys });

  ifdEntries.sort((a, b) => a.tag - b.tag);

  const headerSize = 8;
  const ifdSize = 2 + ifdEntries.length * 12 + 4;
  const ifdOffset = headerSize;

  let overflowOffset = ifdOffset + ifdSize;
  for (const entry of ifdEntries) {
    const byteSize = getEntryByteSize(entry);
    if (byteSize > 4) {
      entry._overflowOffset = overflowOffset;
      overflowOffset += byteSize;
      if (overflowOffset % 2 !== 0) overflowOffset++;
    }
  }

  const stripOffset = overflowOffset;
  const stripOffsetEntry = ifdEntries.find(e => e.tag === 273);
  if (stripOffsetEntry) stripOffsetEntry.value = stripOffset;

  const totalSize = stripOffset + rgbData.length;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let pos = 0;

  view.setUint16(pos, 0x4949, true); pos += 2;
  view.setUint16(pos, 42, true); pos += 2;
  view.setUint32(pos, ifdOffset, true); pos += 4;

  pos = ifdOffset;
  view.setUint16(pos, ifdEntries.length, true); pos += 2;

  for (const entry of ifdEntries) {
    view.setUint16(pos, entry.tag, true); pos += 2;
    view.setUint16(pos, entry.type, true); pos += 2;
    view.setUint32(pos, entry.count, true); pos += 4;

    const byteSize = getEntryByteSize(entry);

    if (byteSize <= 4) {
      writeEntryValue(view, pos, entry);
      pos += 4;
    } else {
      view.setUint32(pos, entry._overflowOffset, true);
      pos += 4;
      writeLegacyOverflow(view, bytes, entry._overflowOffset, entry);
    }
  }

  view.setUint32(pos, 0, true);

  bytes.set(rgbData, stripOffset);

  return buffer;
}

function writeLegacyOverflow(view, bytes, offset, entry) {
  let pos = offset;

  if (entry.type === TYPE_SHORT) {
    for (let i = 0; i < entry.count; i++) {
      view.setUint16(pos, entry.data[i], true);
      pos += 2;
    }
  } else if (entry.type === TYPE_LONG) {
    for (let i = 0; i < entry.count; i++) {
      view.setUint32(pos, entry.data[i], true);
      pos += 4;
    }
  } else if (entry.type === TYPE_DOUBLE) {
    for (let i = 0; i < entry.count; i++) {
      view.setFloat64(pos, entry.data[i], true);
      pos += 8;
    }
  }
}

/**
 * Write a multi-band Float32 GeoTIFF with raw data values.
 *
 * Produces a standard GeoTIFF (not COG) suitable for analysis software:
 *   - N bands of Float32 data (one per polarization)
 *   - 512×512 tiled layout for efficient access
 *   - DEFLATE compression
 *   - Full georeferencing (ModelTiepoint, ModelPixelScale, GeoKeys)
 *   - Band-interleaved-by-pixel layout (BIP/chunky)
 *
 * @param {Object} bands - { HHHH: Float32Array, HVHV: Float32Array, ... }
 * @param {string[]} bandNames - Band names in order, e.g. ['HHHH', 'HVHV']
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number[]} bounds - [minX, minY, maxX, maxY] pixel-EDGE bounds
 * @param {number} epsgCode - EPSG code
 * @param {Object} [options] - { onProgress }
 * @returns {ArrayBuffer} - Complete TIFF file
 */
export function writeFloat32GeoTIFF(bands, bandNames, width, height, bounds, epsgCode, options = {}) {
  const { onProgress } = options;
  const numBands = bandNames.length;
  const [minX, minY, maxX, maxY] = bounds;
  const pixelScaleX = (maxX - minX) / width;
  const pixelScaleY = (maxY - minY) / height;

  if (onProgress) onProgress(0);

  // --- Step 1: Extract and compress 512×512 tiles ---
  const tilesX = Math.ceil(width / TILE_SIZE);
  const tilesY = Math.ceil(height / TILE_SIZE);
  const numTiles = tilesX * tilesY;
  const compressedTiles = [];

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * TILE_SIZE;
      const y0 = ty * TILE_SIZE;
      const tileW = Math.min(TILE_SIZE, width - x0);
      const tileH = Math.min(TILE_SIZE, height - y0);

      // Extract tile data: band-interleaved-by-pixel (BIP)
      // Each pixel has numBands Float32 values
      const tileData = new Float32Array(TILE_SIZE * TILE_SIZE * numBands);

      for (let py = 0; py < tileH; py++) {
        for (let px = 0; px < tileW; px++) {
          const srcIdx = (y0 + py) * width + (x0 + px);
          const dstIdx = (py * TILE_SIZE + px) * numBands;
          for (let b = 0; b < numBands; b++) {
            tileData[dstIdx + b] = bands[bandNames[b]][srcIdx];
          }
        }
      }

      // Compress as raw bytes
      const tileBytes = new Uint8Array(tileData.buffer, tileData.byteOffset, tileData.byteLength);
      const compressed = pako.deflate(tileBytes, { level: 6 });
      compressedTiles.push({ data: compressed, byteCount: compressed.byteLength });
    }

    if (onProgress) onProgress(Math.round((ty + 1) / tilesY * 60));
  }

  // --- Step 2: Build IFD entries ---
  const entries = [];

  entries.push(makeEntry(TAG_IMAGE_WIDTH, TYPE_LONG, 1, width));
  entries.push(makeEntry(TAG_IMAGE_LENGTH, TYPE_LONG, 1, height));

  // BitsPerSample: 32 per band
  const bitsPerSample = new Array(numBands).fill(32);
  entries.push(makeArrayEntry(TAG_BITS_PER_SAMPLE, TYPE_SHORT, bitsPerSample));

  // Compression: DEFLATE
  entries.push(makeEntry(TAG_COMPRESSION, TYPE_SHORT, 1, 8));

  // Photometric: 1 = MinIsBlack (generic data, not RGB)
  entries.push(makeEntry(TAG_PHOTOMETRIC, TYPE_SHORT, 1, 1));

  // SamplesPerPixel
  entries.push(makeEntry(TAG_SAMPLES_PER_PIXEL, TYPE_SHORT, 1, numBands));

  // ExtraSamples: required when SamplesPerPixel > 1 with Photometric=MinIsBlack
  // Photometric=1 implies 1 color channel; extra bands are type 0 (EXTRASAMPLE_UNSPECIFIED)
  if (numBands > 1) {
    const extraSamples = new Array(numBands - 1).fill(0); // 0 = unspecified
    entries.push(makeArrayEntry(TAG_EXTRA_SAMPLES, TYPE_SHORT, extraSamples));
  }

  // PlanarConfig: 1 = chunky/BIP
  entries.push(makeEntry(TAG_PLANAR_CONFIG, TYPE_SHORT, 1, 1));

  // TileWidth, TileLength
  entries.push(makeEntry(TAG_TILE_WIDTH, TYPE_LONG, 1, TILE_SIZE));
  entries.push(makeEntry(TAG_TILE_LENGTH, TYPE_LONG, 1, TILE_SIZE));

  // TileOffsets (placeholder)
  const tileOffsets = new Array(numTiles).fill(0);
  entries.push(makeArrayEntry(TAG_TILE_OFFSETS, TYPE_LONG, tileOffsets));

  // TileByteCounts
  const tileByteCounts = compressedTiles.map(t => t.byteCount);
  entries.push(makeArrayEntry(TAG_TILE_BYTE_COUNTS, TYPE_LONG, tileByteCounts));

  // SampleFormat: 3 = IEEE floating point (for all bands)
  const sampleFormat = new Array(numBands).fill(3);
  entries.push(makeArrayEntry(TAG_SAMPLE_FORMAT, TYPE_SHORT, sampleFormat));

  // GeoTIFF tags
  entries.push(makeArrayEntry(TAG_MODEL_TIEPOINT, TYPE_DOUBLE, [0, 0, 0, minX, maxY, 0]));
  entries.push(makeArrayEntry(TAG_MODEL_PIXEL_SCALE, TYPE_DOUBLE, [pixelScaleX, pixelScaleY, 0]));

  const isGeographic = epsgCode >= 4000 && epsgCode < 5000;
  const modelType = isGeographic ? MODEL_TYPE_GEOGRAPHIC : MODEL_TYPE_PROJECTED;
  const csKeyId = isGeographic ? KEY_GEOGRAPHIC_TYPE : KEY_PROJECTED_CS_TYPE;

  entries.push(makeArrayEntry(TAG_GEO_KEY_DIRECTORY, TYPE_SHORT, [
    1, 1, 0, 3,
    KEY_GT_MODEL_TYPE, 0, 1, modelType,
    KEY_GT_RASTER_TYPE, 0, 1, RASTER_TYPE_PIXEL_IS_AREA,
    csKeyId, 0, 1, epsgCode,
  ]));

  // GDAL_NODATA: mark NaN as no-data so QGIS renders it as transparent
  entries.push({ tag: TAG_GDAL_NODATA, type: TYPE_ASCII, count: 4, asciiValue: 'nan' });

  // Sort by tag
  entries.sort((a, b) => a.tag - b.tag);

  // --- Step 3: Calculate file layout ---
  const headerSize = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  const ifdOffset = headerSize;

  // Overflow data (arrays too large for 4 bytes)
  let overflowSize = 0;
  for (const entry of entries) {
    const byteSize = getEntryByteSize(entry);
    if (byteSize > 4) {
      entry.needsOverflow = true;
      entry.overflowSize = byteSize;
      overflowSize += byteSize;
      if (overflowSize % 2 !== 0) overflowSize++;
    }
  }

  const overflowOffset = ifdOffset + ifdSize;
  const tileDataOffset = overflowOffset + overflowSize;
  const totalTileBytes = compressedTiles.reduce((sum, t) => sum + t.byteCount, 0);
  const totalSize = tileDataOffset + totalTileBytes;

  // --- Step 4: Write the file ---
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // TIFF header
  view.setUint16(0, 0x4949, true); // Little-endian
  view.setUint16(2, 42, true);     // Magic
  view.setUint32(4, ifdOffset, true);

  // Write IFD
  let pos = ifdOffset;
  view.setUint16(pos, entries.length, true); pos += 2;

  let curOverflow = overflowOffset;
  let curTileData = tileDataOffset;

  for (const entry of entries) {
    view.setUint16(pos, entry.tag, true); pos += 2;
    view.setUint16(pos, entry.type, true); pos += 2;
    view.setUint32(pos, entry.count, true); pos += 4;

    const byteSize = getEntryByteSize(entry);

    if (entry.tag === TAG_TILE_OFFSETS) {
      // TileOffsets need actual tile data positions, not placeholder values
      if (byteSize <= 4) {
        // Single tile: write offset inline
        view.setUint32(pos, tileDataOffset, true); pos += 4;
      } else {
        // Multiple tiles: write pointer to overflow array
        view.setUint32(pos, curOverflow, true); pos += 4;
        let tilePos = tileDataOffset;
        for (let i = 0; i < compressedTiles.length; i++) {
          view.setUint32(curOverflow, tilePos, true);
          curOverflow += 4;
          tilePos += compressedTiles[i].byteCount;
        }
        if (curOverflow % 2 !== 0) curOverflow++;
      }
    } else if (byteSize <= 4) {
      writeEntryValue(view, pos, entry);
      pos += 4;
    } else {
      // Other overflow arrays
      view.setUint32(pos, curOverflow, true); pos += 4;
      writeEntryArray(view, curOverflow, entry);
      curOverflow += entry.overflowSize;
      if (curOverflow % 2 !== 0) curOverflow++;
    }
  }

  // Next IFD pointer (0 = none)
  view.setUint32(pos, 0, true);

  // Write tile data
  let tileWritePos = tileDataOffset;
  for (const tile of compressedTiles) {
    bytes.set(tile.data, tileWritePos);
    tileWritePos += tile.byteCount;
  }

  if (onProgress) onProgress(100);
  return buffer;
}

/**
 * Trigger a file download in the browser.
 * @param {ArrayBuffer} buffer - File data
 * @param {string} filename - Download filename
 */
export function downloadBuffer(buffer, filename) {
  const blob = new Blob([buffer], { type: 'image/tiff' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
