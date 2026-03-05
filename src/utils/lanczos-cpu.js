/**
 * lanczos-cpu.js — CPU separable Lanczos-3 downsample for Float32 SAR power data
 *
 * Used to produce a high-quality overview level 0 from raw chunk data when
 * loading local files. The GPU Lanczos mipmap builder (lanczos-mipmaps.js)
 * then generates the remaining pyramid levels from this properly-filtered base.
 *
 * All operations are in linear power space. NaN/zero values are excluded from
 * the weighted average (nodata-aware filtering). Negative outputs are clamped
 * to zero since negative power is physically meaningless.
 */

const PI = Math.PI;

/**
 * Lanczos-3 kernel: sinc(x) * sinc(x/3), support [-3, 3]
 */
function lanczos3(x) {
  const ax = Math.abs(x);
  if (ax >= 3.0) return 0.0;
  if (ax < 1e-8) return 1.0;
  const px = PI * x;
  return (3.0 * Math.sin(px) * Math.sin(px / 3.0)) / (px * px);
}

/**
 * Downsample a Float32Array image using separable Lanczos-3 filtering.
 *
 * @param {Float32Array} src - Source image data (row-major, single channel)
 * @param {number} srcW - Source width
 * @param {number} srcH - Source height
 * @param {number} dstW - Target width
 * @param {number} dstH - Target height
 * @returns {Float32Array} Downsampled image (dstW * dstH)
 */
export function lanczosDownsample(src, srcW, srcH, dstW, dstH) {
  if (dstW >= srcW && dstH >= srcH) {
    // No downsampling needed
    return new Float32Array(src);
  }

  // Horizontal pass: srcW × srcH → dstW × srcH
  const intermediate = new Float32Array(dstW * srcH);
  const scaleX = srcW / dstW;
  const radiusX = Math.ceil(3 * scaleX);

  for (let y = 0; y < srcH; y++) {
    const srcRowOff = y * srcW;
    const dstRowOff = y * dstW;
    for (let x = 0; x < dstW; x++) {
      const center = (x + 0.5) * scaleX - 0.5;
      const iMin = Math.max(0, Math.floor(center - radiusX));
      const iMax = Math.min(srcW - 1, Math.ceil(center + radiusX));

      let sum = 0;
      let wSum = 0;
      for (let i = iMin; i <= iMax; i++) {
        const val = src[srcRowOff + i];
        // Skip NaN and exact-zero nodata
        if (val !== val || val <= 0) continue; // NaN check: val !== val
        const w = lanczos3((i - center) / scaleX);
        sum += w * val;
        wSum += w;
      }

      if (wSum > 0) {
        intermediate[dstRowOff + x] = Math.max(0, sum / wSum);
      } else {
        intermediate[dstRowOff + x] = 0; // all-nodata region
      }
    }
  }

  // Vertical pass: dstW × srcH → dstW × dstH
  const dst = new Float32Array(dstW * dstH);
  const scaleY = srcH / dstH;
  const radiusY = Math.ceil(3 * scaleY);

  for (let x = 0; x < dstW; x++) {
    for (let y = 0; y < dstH; y++) {
      const center = (y + 0.5) * scaleY - 0.5;
      const jMin = Math.max(0, Math.floor(center - radiusY));
      const jMax = Math.min(srcH - 1, Math.ceil(center + radiusY));

      let sum = 0;
      let wSum = 0;
      for (let j = jMin; j <= jMax; j++) {
        const val = intermediate[j * dstW + x];
        if (val !== val || val <= 0) continue;
        const w = lanczos3((j - center) / scaleY);
        sum += w * val;
        wSum += w;
      }

      if (wSum > 0) {
        dst[y * dstW + x] = Math.max(0, sum / wSum);
      } else {
        dst[y * dstW + x] = 0;
      }
    }
  }

  return dst;
}
