/**
 * ClassificationOverlay — Canvas overlay that colors ROI pixels by class.
 *
 * Receives a classificationMap (Uint8Array, one value per ROI pixel) where
 * 0 = unclassified, 1..N = class index (1-based). Renders each classified
 * pixel using the corresponding class color at ~50% opacity.
 *
 * Follows the same canvas overlay pattern as ROIOverlay.jsx: positioned
 * absolutely over the deck.gl viewer, redrawn on every viewState change.
 *
 * `frame` (view-frame.js) is optional: with it the overlay runs on the
 * basemap, where the ROI is a rotated image-space quad. The class image is
 * drawn through the affine map of the ROI's projected corners, which is
 * exact in the native view and the same approximation the ROI box uses on
 * the map (image grid ≈ affine over a few km).
 */

import React, { useRef, useLayoutEffect, useMemo } from 'react';
import { worldToPixel } from '../utils/geo-overlays.js';
import { useResizeTick } from './useResizeTick.js';

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
  frame = null,       // view frame supplying worldToPixel (basemap); default ortho math
}) {
  const w2p = frame?.worldToPixel || worldToPixel;
  const canvasRef = useRef(null);
  const resizeTick = useResizeTick(canvasRef); // redraw when the viewer box changes

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
      return w2p(wx, wy, viewState, cw, ch);
    };

    // Three ROI corners define the affine image→screen map (the 4th follows).
    const [ax, ay] = imgToScreen(roi.left, roi.top);
    const [bx, by] = imgToScreen(roi.left + roi.width, roi.top);
    const [dx, dy] = imgToScreen(roi.left, roi.top + roi.height);
    const iw = classImage.width, ih = classImage.height;
    const ex = [(bx - ax) / iw, (by - ay) / iw]; // screen step per class column
    const ey = [(dx - ax) / ih, (dy - ay) / ih]; // screen step per class row

    // Skip if ROI is off-screen or tiny
    if (Math.hypot(bx - ax, by - ay) < 2 || Math.hypot(dx - ax, dy - ay) < 2) return;

    // Draw classImage through the affine (dpr folded in; setTransform replaces the scale above)
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = iw;
    tmpCanvas.height = ih;
    tmpCanvas.getContext('2d').putImageData(classImage, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(ex[0] * dpr, ex[1] * dpr, ey[0] * dpr, ey[1] * dpr, ax * dpr, ay * dpr);
    ctx.drawImage(tmpCanvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

  }, [viewState, bounds, imageWidth, imageHeight, roi, classImage, resizeTick, w2p]);

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
