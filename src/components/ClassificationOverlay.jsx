/**
 * ClassificationOverlay — Canvas overlay that colors ROI pixels by class.
 *
 * Receives a classificationMap (Uint8Array, one value per ROI pixel) where
 * 0 = unclassified, 1..N = class index (1-based). Renders each classified
 * pixel using the corresponding class color at ~50% opacity.
 *
 * Follows the same canvas overlay pattern as ROIOverlay.jsx: positioned
 * absolutely over the deck.gl viewer, redrawn on every viewState change.
 */

import React, { useRef, useLayoutEffect, useMemo } from 'react';
import { worldToPixel } from '../utils/geo-overlays.js';

/**
 * Parse hex color to [r, g, b].
 */
function hexToRGB(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

export default function ClassificationOverlay({
  viewState,
  bounds,
  imageWidth,
  imageHeight,
  roi,
  classificationMap,  // Uint8Array, length = roiW * roiH, values 0..N
  classRegions,       // [{name, color, ...}]
  roiDims,            // { w, h } — dimensions of the classification grid
}) {
  const canvasRef = useRef(null);

  // Pre-build an ImageData from classificationMap + class colors
  const classImage = useMemo(() => {
    if (!classificationMap || !roiDims || !classRegions?.length) return null;
    const { w, h } = roiDims;
    if (w <= 0 || h <= 0) return null;

    const rgba = new Uint8ClampedArray(w * h * 4);
    const colorLUT = classRegions.map(r => hexToRGB(r.color));

    for (let i = 0; i < classificationMap.length; i++) {
      const cls = classificationMap[i];
      if (cls === 0 || cls > colorLUT.length) continue;
      const [r, g, b] = colorLUT[cls - 1];
      const idx = i * 4;
      rgba[idx]     = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 200; // ~78% alpha
    }

    return new ImageData(rgba, w, h);
  }, [classificationMap, classRegions, roiDims]);

  // Draw the classification overlay each frame
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !viewState || !bounds) return;

    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, ch);

    if (!roi || !classImage || !imageWidth || !imageHeight) return;

    const [minX, minY, maxX, maxY] = bounds;

    // Image pixel → screen pixel
    // Y is flipped: image row 0 → world maxY (top), row H → world minY (bottom)
    const imgToScreen = (px, py) => {
      const wx = minX + (px / imageWidth) * (maxX - minX);
      const wy = maxY - (py / imageHeight) * (maxY - minY);
      return worldToPixel(wx, wy, viewState, cw, ch);
    };

    const [sx0, sy0] = imgToScreen(roi.left, roi.top);
    const [sx1, sy1] = imgToScreen(roi.left + roi.width, roi.top + roi.height);
    const rx = Math.min(sx0, sx1);
    const ry = Math.min(sy0, sy1);
    const rw = Math.abs(sx1 - sx0);
    const rh = Math.abs(sy1 - sy0);

    // Skip if ROI is off-screen or tiny
    if (rw < 2 || rh < 2) return;

    // Draw classImage scaled to ROI screen rect
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = classImage.width;
    tmpCanvas.height = classImage.height;
    tmpCanvas.getContext('2d').putImageData(classImage, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmpCanvas, rx, ry, rw, rh);

  }, [viewState, bounds, imageWidth, imageHeight, roi, classImage]);

  if (!viewState || !bounds || !roi || !classImage) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 3,
      }}
    />
  );
}
