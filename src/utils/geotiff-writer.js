/**
 * Minimal GeoTIFF Writer
 *
 * Produces a valid 3-band uint8 RGB GeoTIFF with geospatial tags.
 * Only supports the minimum needed for SARdine export:
 *   - RGB uint8, interleaved pixels
 *   - Single strip (no tiling)
 *   - ModelTiepointTag + ModelPixelScaleTag for georeferencing
 *   - GeoKeyDirectoryTag with ProjectedCSTypeGeoKey
 *
 * Based on TIFF 6.0 and GeoTIFF 1.1 specs.
 */

// TIFF tag IDs
const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_STRIP_OFFSETS = 273;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_ROWS_PER_STRIP = 278;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_PLANAR_CONFIG = 284;

// GeoTIFF tag IDs
const TAG_MODEL_TIEPOINT = 33922;
const TAG_MODEL_PIXEL_SCALE = 33550;
const TAG_GEO_KEY_DIRECTORY = 34735;

// TIFF types
const TYPE_SHORT = 3;    // uint16
const TYPE_LONG = 4;     // uint32
const TYPE_DOUBLE = 12;  // float64

// GeoKey IDs
const KEY_GT_MODEL_TYPE = 1024;
const KEY_GT_RASTER_TYPE = 1025;
const KEY_PROJECTED_CS_TYPE = 3072;

// GeoKey values
const MODEL_TYPE_PROJECTED = 1;
const MODEL_TYPE_GEOGRAPHIC = 2;
const RASTER_TYPE_PIXEL_IS_AREA = 1;

/**
 * Write an RGB GeoTIFF from RGBA pixel data.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgbaData - RGBA pixel data (4 bytes per pixel)
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {number[]} bounds - [minX, minY, maxX, maxY] in CRS coordinates
 * @param {number} epsgCode - EPSG code (e.g. 32610 for UTM 10N)
 * @returns {ArrayBuffer} Valid GeoTIFF file
 */
export function writeRGBGeoTIFF(rgbaData, width, height, bounds, epsgCode = 32610) {
  const [minX, minY, maxX, maxY] = bounds;

  // Pixel size
  const pixelScaleX = (maxX - minX) / width;
  const pixelScaleY = (maxY - minY) / height;

  // Strip RGB data from RGBA (drop alpha channel)
  const rgbSize = width * height * 3;
  const rgbData = new Uint8Array(rgbSize);
  for (let i = 0; i < width * height; i++) {
    rgbData[i * 3] = rgbaData[i * 4];
    rgbData[i * 3 + 1] = rgbaData[i * 4 + 1];
    rgbData[i * 3 + 2] = rgbaData[i * 4 + 2];
  }

  // Build IFD entries
  const ifdEntries = [];

  // Standard TIFF tags
  ifdEntries.push(makeShortEntry(TAG_IMAGE_WIDTH, width));
  ifdEntries.push(makeShortEntry(TAG_IMAGE_LENGTH, height));
  // BitsPerSample: 3 values (8, 8, 8) — stored as offset if count > 2
  ifdEntries.push({ tag: TAG_BITS_PER_SAMPLE, type: TYPE_SHORT, count: 3, data: [8, 8, 8] });
  ifdEntries.push(makeShortEntry(TAG_COMPRESSION, 1)); // No compression
  ifdEntries.push(makeShortEntry(TAG_PHOTOMETRIC, 2)); // RGB
  ifdEntries.push(makeLongEntry(TAG_STRIP_OFFSETS, 0)); // Placeholder — filled later
  ifdEntries.push(makeShortEntry(TAG_SAMPLES_PER_PIXEL, 3));
  ifdEntries.push(makeLongEntry(TAG_ROWS_PER_STRIP, height)); // Single strip
  ifdEntries.push(makeLongEntry(TAG_STRIP_BYTE_COUNTS, rgbSize));
  ifdEntries.push(makeShortEntry(TAG_PLANAR_CONFIG, 1)); // Chunky (interleaved)

  // GeoTIFF tags
  // ModelTiepointTag: [I, J, K, X, Y, Z] — maps pixel (0,0,0) to world (minX, maxY, 0)
  // Note: TIFF rows go top-to-bottom, so pixel (0,0) = top-left = (minX, maxY)
  ifdEntries.push({
    tag: TAG_MODEL_TIEPOINT,
    type: TYPE_DOUBLE,
    count: 6,
    data: [0, 0, 0, minX, maxY, 0],
  });

  // ModelPixelScaleTag: [scaleX, scaleY, scaleZ]
  ifdEntries.push({
    tag: TAG_MODEL_PIXEL_SCALE,
    type: TYPE_DOUBLE,
    count: 3,
    data: [pixelScaleX, pixelScaleY, 0],
  });

  // GeoKeyDirectoryTag
  const isGeographic = epsgCode >= 4000 && epsgCode < 5000;
  const modelType = isGeographic ? MODEL_TYPE_GEOGRAPHIC : MODEL_TYPE_PROJECTED;
  const csKeyId = isGeographic ? 2048 : KEY_PROJECTED_CS_TYPE; // GeographicTypeGeoKey or ProjectedCSTypeGeoKey

  // GeoKey directory: [KeyDirectoryVersion, KeyRevision, MinorRevision, NumberOfKeys, ...keys]
  // Each key: [KeyID, TIFFTagLocation, Count, Value_Offset]
  const geoKeys = [
    1, 1, 0, 3,                                // Header: version 1.1.0, 3 keys
    KEY_GT_MODEL_TYPE, 0, 1, modelType,         // ModelTypeGeoKey
    KEY_GT_RASTER_TYPE, 0, 1, RASTER_TYPE_PIXEL_IS_AREA, // RasterTypeGeoKey
    csKeyId, 0, 1, epsgCode,                    // ProjectedCSTypeGeoKey or GeographicTypeGeoKey
  ];

  ifdEntries.push({
    tag: TAG_GEO_KEY_DIRECTORY,
    type: TYPE_SHORT,
    count: geoKeys.length,
    data: geoKeys,
  });

  // Sort entries by tag (TIFF requirement)
  ifdEntries.sort((a, b) => a.tag - b.tag);

  // Calculate file layout
  // Header: 8 bytes
  // IFD: 2 (count) + entries * 12 + 4 (next IFD pointer) = 2 + N*12 + 4
  // Overflow data: variable (for entries that don't fit in 4 bytes)
  // Strip data: rgbSize

  const headerSize = 8;
  const ifdSize = 2 + ifdEntries.length * 12 + 4;
  const ifdOffset = headerSize;

  // Calculate overflow data size
  let overflowOffset = ifdOffset + ifdSize;
  for (const entry of ifdEntries) {
    const byteSize = getEntryByteSize(entry);
    if (byteSize > 4) {
      entry._overflowOffset = overflowOffset;
      overflowOffset += byteSize;
      // Align to word boundary
      if (overflowOffset % 2 !== 0) overflowOffset++;
    }
  }

  // Strip data starts after overflow
  const stripOffset = overflowOffset;

  // Update strip offset entry
  const stripOffsetEntry = ifdEntries.find(e => e.tag === TAG_STRIP_OFFSETS);
  if (stripOffsetEntry) {
    stripOffsetEntry.value = stripOffset;
  }

  // Total file size
  const totalSize = stripOffset + rgbSize;

  // Write the file
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let pos = 0;

  // TIFF header (little-endian)
  view.setUint16(pos, 0x4949, true); pos += 2; // Byte order: little-endian
  view.setUint16(pos, 42, true); pos += 2;     // Magic number
  view.setUint32(pos, ifdOffset, true); pos += 4; // Offset to first IFD

  // IFD
  pos = ifdOffset;
  view.setUint16(pos, ifdEntries.length, true); pos += 2;

  for (const entry of ifdEntries) {
    view.setUint16(pos, entry.tag, true); pos += 2;
    view.setUint16(pos, entry.type, true); pos += 2;
    view.setUint32(pos, entry.count, true); pos += 4;

    const byteSize = getEntryByteSize(entry);

    if (byteSize <= 4) {
      // Value fits in the 4-byte value/offset field
      writeEntryValue(view, pos, entry);
      pos += 4;
    } else {
      // Write offset to overflow area
      view.setUint32(pos, entry._overflowOffset, true);
      pos += 4;
      // Write data in overflow area
      writeEntryData(view, bytes, entry._overflowOffset, entry);
    }
  }

  // Next IFD pointer (0 = no more IFDs)
  view.setUint32(pos, 0, true);

  // Write strip data
  bytes.set(rgbData, stripOffset);

  return buffer;
}

function makeShortEntry(tag, value) {
  return { tag, type: TYPE_SHORT, count: 1, value };
}

function makeLongEntry(tag, value) {
  return { tag, type: TYPE_LONG, count: 1, value };
}

function getEntryByteSize(entry) {
  const typeSize = { [TYPE_SHORT]: 2, [TYPE_LONG]: 4, [TYPE_DOUBLE]: 8 };
  return (typeSize[entry.type] || 2) * entry.count;
}

function writeEntryValue(view, pos, entry) {
  if (entry.type === TYPE_SHORT && entry.count === 1) {
    view.setUint16(pos, entry.value, true);
  } else if (entry.type === TYPE_LONG && entry.count === 1) {
    view.setUint32(pos, entry.value, true);
  } else if (entry.type === TYPE_SHORT && entry.count === 2 && entry.data) {
    view.setUint16(pos, entry.data[0], true);
    view.setUint16(pos + 2, entry.data[1], true);
  }
}

function writeEntryData(view, bytes, offset, entry) {
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
