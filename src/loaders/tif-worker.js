/**
 * Web Worker for loading plain (non-COG) GeoTIFF rasters off the main thread.
 * Reads the raster in horizontal strips so progress can be reported back.
 *
 * Progress range: 35-85 (caller handles 0-35 and 85-100)
 */
import { fromArrayBuffer } from 'geotiff';

self.onmessage = async (e) => {
  const { arrayBuffer, stripCount = 16 } = e.data;

  try {
    const tiff = await fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();

    self.postMessage({ type: 'progress', value: 40 });

    // Read in strips for progress reporting
    const nStrips = Math.min(stripCount, height);
    const rowsPerStrip = Math.ceil(height / nStrips);
    const fullData = new Float32Array(width * height);

    for (let s = 0; s < nStrips; s++) {
      const y0 = s * rowsPerStrip;
      const y1 = Math.min(height, y0 + rowsPerStrip);
      if (y0 >= height) break;

      const rasters = await image.readRasters({
        window: [0, y0, width, y1],
      });

      // Copy strip into full array
      const strip = rasters[0];
      const offset = y0 * width;
      if (strip instanceof Float32Array) {
        fullData.set(strip, offset);
      } else {
        for (let i = 0; i < strip.length; i++) {
          fullData[offset + i] = strip[i];
        }
      }

      // Progress: 40-85 maps to strip progress
      const pct = 40 + Math.round(((s + 1) / nStrips) * 45);
      self.postMessage({ type: 'progress', value: pct });
    }

    // Transfer the buffer back (zero-copy)
    self.postMessage(
      { type: 'done', data: fullData, width, height },
      [fullData.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
