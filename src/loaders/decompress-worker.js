/**
 * Web Worker for parallel HDF5 chunk decompression.
 *
 * Receives compressed chunk buffers, applies inflate + unshuffle + type decode,
 * and returns the resulting Float32Array via Transferable for zero-copy.
 */

function unshuffle(data, elementSize) {
  const count = data.length / elementSize;
  const result = new Uint8Array(data.length);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < elementSize; j++) {
      result[i * elementSize + j] = data[j * count + i];
    }
  }
  return result;
}

async function inflate(data) {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function decodeFloat16(buffer) {
  const uint16 = new Uint16Array(buffer);
  const result = new Float32Array(uint16.length);
  for (let i = 0; i < uint16.length; i++) {
    const h = uint16[i];
    const sign = (h & 0x8000) >> 15;
    const exp = (h & 0x7C00) >> 10;
    const frac = h & 0x03FF;
    if (exp === 0) {
      result[i] = frac === 0 ? (sign ? -0 : 0)
        : (sign ? -1 : 1) * (frac / 1024) * Math.pow(2, -14);
    } else if (exp === 31) {
      result[i] = frac ? NaN : (sign ? -Infinity : Infinity);
    } else {
      result[i] = (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
    }
  }
  return result;
}

function decodeData(buffer, dtype) {
  switch (dtype) {
    case 'float32':   return new Float32Array(buffer);
    case 'float64':   return new Float32Array(new Float64Array(buffer));
    case 'float16':   return decodeFloat16(buffer);
    case 'int16':     return new Float32Array(new Int16Array(buffer));
    case 'uint16':    return new Float32Array(new Uint16Array(buffer));
    case 'int32':     return new Float32Array(new Int32Array(buffer));
    case 'uint32':    return new Float32Array(new Uint32Array(buffer));
    case 'uint8':     return new Float32Array(new Uint8Array(buffer));
    case 'int8':      return new Float32Array(new Int8Array(buffer));
    case 'cfloat32':  return new Float32Array(buffer);
    case 'cfloat64':  return new Float32Array(new Float64Array(buffer));
    default:          return new Float32Array(buffer);
  }
}

const FILTER_DEFLATE = 1;
const FILTER_SHUFFLE = 2;

async function decompressAndDecode(compressedBuffer, filters, dtype) {
  let data = new Uint8Array(compressedBuffer);

  // Apply filters in reverse order (same as h5chunk._decompressChunk)
  for (let i = filters.length - 1; i >= 0; i--) {
    const filter = filters[i];
    switch (filter.id) {
      case FILTER_DEFLATE:
        data = await inflate(data);
        break;
      case FILTER_SHUFFLE:
        data = unshuffle(data, filter.params?.[0] || 4);
        break;
    }
  }

  return decodeData(data.buffer, dtype);
}

self.onmessage = async (e) => {
  const { id, buffer, filters, dtype } = e.data;
  try {
    const result = await decompressAndDecode(buffer, filters, dtype);
    self.postMessage({ id, data: result.buffer }, [result.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
