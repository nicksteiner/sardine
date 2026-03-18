/**
 * PNG tEXt chunk state embedding for SARdine.
 *
 * Embeds visualization state as a PNG tEXt chunk (keyword "SARdine-State")
 * so exported figures carry enough context to restore display parameters
 * when dragged back into the app.
 */

const KEYWORD = 'SARdine-State';
const STATE_VERSION = 1;

// PNG signature bytes
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

// CRC32 lookup table
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Embed a SARdine state object as a tEXt chunk in a PNG blob.
 * The chunk is inserted right after the IHDR chunk.
 *
 * @param {Blob} pngBlob
 * @param {object} state  Visualization state to embed
 * @returns {Promise<Blob>}
 */
export async function embedStateInPNG(pngBlob, state) {
  const buffer = await pngBlob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Verify PNG signature
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error('Not a PNG file');
  }

  const enc = new TextEncoder();
  const payload = JSON.stringify({ _v: STATE_VERSION, ...state });
  const textBytes = enc.encode(`${KEYWORD}\0${payload}`);
  const typeBytes = enc.encode('tEXt');

  // CRC covers type + data
  const typeAndData = new Uint8Array(4 + textBytes.length);
  typeAndData.set(typeBytes, 0);
  typeAndData.set(textBytes, 4);
  const crc = crc32(typeAndData);

  // Chunk layout: length(4) + type(4) + data + crc(4)
  const chunk = new Uint8Array(12 + textBytes.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, textBytes.length, false);
  chunk.set(typeBytes, 4);
  chunk.set(textBytes, 8);
  view.setUint32(8 + textBytes.length, crc, false);

  // IHDR is always 13 bytes of data → its chunk ends at byte 33
  const insertAt = 33;

  const result = new Uint8Array(bytes.length + chunk.length);
  result.set(bytes.subarray(0, insertAt), 0);
  result.set(chunk, insertAt);
  result.set(bytes.subarray(insertAt), insertAt + chunk.length);

  return new Blob([result], { type: 'image/png' });
}

/**
 * Extract SARdine state from a PNG file's tEXt chunks.
 * Returns null if no SARdine state chunk is found or the file is not a PNG.
 *
 * @param {File|Blob} pngFile
 * @returns {Promise<object|null>}
 */
export async function extractStateFromPNG(pngFile) {
  const buffer = await pngFile.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // Verify PNG signature
  if (bytes.length < 8) return null;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) return null;
  }

  const dec = new TextDecoder();
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const chunkLen = view.getUint32(offset, false);
    const chunkType = dec.decode(bytes.subarray(offset + 4, offset + 8));

    if (chunkType === 'IEND') break;

    if (chunkType === 'tEXt' && chunkLen > KEYWORD.length) {
      const dataBytes = bytes.subarray(offset + 8, offset + 8 + chunkLen);
      const text = dec.decode(dataBytes);
      const nullIdx = text.indexOf('\0');
      if (nullIdx !== -1 && text.slice(0, nullIdx) === KEYWORD) {
        try {
          return JSON.parse(text.slice(nullIdx + 1));
        } catch {
          return null;
        }
      }
    }

    offset += 4 + 4 + chunkLen + 4;
  }

  return null;
}
