/**
 * ScatterClassifier — 2D Feature Space Scatter with interactive class regions.
 *
 * Renders a density heatmap of two SAR bands (e.g., HH dB vs HV dB) for pixels
 * within an ROI.  The user draws axis-aligned rectangles in the scatter to define
 * classes.  Pixels falling inside a class rectangle are assigned that class,
 * which is shown as a color overlay on the map via ClassificationOverlay.
 */

import React, { useRef, useEffect, useState, useCallback, useMemo, useLayoutEffect } from 'react';
import { generateScatterSVG, generateClassMapSVG, downloadSVG } from '../utils/svg-export.js';

const CLASS_COLORS = [
  '#3498db',  // blue   (water)
  '#2ecc71',  // green  (vegetation)
  '#f1c40f',  // yellow (inundated veg)
  '#e74c3c',  // red
  '#9b59b6',  // purple
  '#e67e22',  // orange
];

const DEFAULT_CLASS_NAMES = ['Water', 'Vegetation', 'Inundated Veg', 'Class 4', 'Class 5', 'Class 6'];

const PLOT_W = 280;
const PLOT_H = 280;
const MARGIN = { top: 12, right: 16, bottom: 40, left: 48 };
const DENSITY_BINS = 128;

/**
 * Build a 2D density grid (log-scaled counts) from scatter data.
 */
function buildDensityGrid(x, y, valid, xRange, yRange) {
  const grid = new Uint32Array(DENSITY_BINS * DENSITY_BINS);
  const [xMin, xMax] = xRange;
  const [yMin, yMax] = yRange;
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  for (let i = 0; i < x.length; i++) {
    if (!valid[i]) continue;
    const bx = Math.floor((x[i] - xMin) / xSpan * (DENSITY_BINS - 1));
    const by = Math.floor((y[i] - yMin) / ySpan * (DENSITY_BINS - 1));
    if (bx < 0 || bx >= DENSITY_BINS || by < 0 || by >= DENSITY_BINS) continue;
    // Flip Y so low values are at bottom
    grid[(DENSITY_BINS - 1 - by) * DENSITY_BINS + bx]++;
  }
  return grid;
}

/**
 * Render density grid to an ImageData.
 */
function densityToImage(grid) {
  const img = new ImageData(DENSITY_BINS, DENSITY_BINS);
  let maxCount = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] > maxCount) maxCount = grid[i];
  const logMax = Math.log10(maxCount + 1) || 1;

  for (let i = 0; i < grid.length; i++) {
    const t = grid[i] > 0 ? Math.log10(grid[i] + 1) / logMax : 0;
    const idx = i * 4;
    // sardine-style ramp: navy → cyan → white
    if (t === 0) {
      img.data[idx] = 10; img.data[idx + 1] = 22; img.data[idx + 2] = 40; img.data[idx + 3] = 255;
    } else if (t < 0.5) {
      const s = t / 0.5;
      img.data[idx]     = Math.round(10 + s * (78 - 10));
      img.data[idx + 1] = Math.round(22 + s * (201 - 22));
      img.data[idx + 2] = Math.round(40 + s * (212 - 40));
      img.data[idx + 3] = 255;
    } else {
      const s = (t - 0.5) / 0.5;
      img.data[idx]     = Math.round(78 + s * (232 - 78));
      img.data[idx + 1] = Math.round(201 + s * (237 - 201));
      img.data[idx + 2] = Math.round(212 + s * (245 - 212));
      img.data[idx + 3] = 255;
    }
  }
  return img;
}

/**
 * Convert data-space coords to canvas pixel coords (within plot area).
 */
function dataToPlot(val, rangeMin, rangeMax, plotSize) {
  return ((val - rangeMin) / (rangeMax - rangeMin || 1)) * plotSize;
}

/**
 * Convert canvas pixel coords (within plot area) to data-space.
 */
function plotToData(px, rangeMin, rangeMax, plotSize) {
  return rangeMin + (px / plotSize) * (rangeMax - rangeMin || 1);
}

/**
 * Classify each pixel and return per-class counts.
 */
function classifyCounts(x, y, valid, classRegions) {
  const counts = new Array(classRegions.length).fill(0);
  for (let i = 0; i < x.length; i++) {
    if (!valid[i]) continue;
    const xv = x[i], yv = y[i];
    for (let c = 0; c < classRegions.length; c++) {
      const r = classRegions[c];
      if (xv >= r.xMin && xv <= r.xMax && yv >= r.yMin && yv <= r.yMax) {
        counts[c]++;
        break;
      }
    }
  }
  return counts;
}

export default function ScatterClassifier({
  scatterData,   // { x: Float32Array, y: Float32Array, valid: Uint8Array, incidence?: Float32Array }
  xLabel,        // "HHHH (dB)"
  yLabel,        // "HVHV (dB)"
  classRegions,  // [{name, color, xMin, xMax, yMin, yMax}]
  onClassRegionsChange,
  classificationMap,       // Uint8Array from parent (for export)
  classifierRoiDims,       // {w, h}
  incidenceRange,          // [min, max] degrees
  onIncidenceRangeChange,  // ([min, max]) => void
  onClose,
}) {
  const canvasRef = useRef(null);
  const [drawingClass, setDrawingClass] = useState(-1); // index of class being drawn, -1 = none
  const [dragState, setDragState] = useState(null);
  // dragState: { type: 'new'|'move'|'resize', classIdx, startPx, startPy, origRect?, edge? }

  // Compute data ranges (stable across renders)
  const { xRange, yRange } = useMemo(() => {
    if (!scatterData) return { xRange: [-30, 0], yRange: [-30, 0] };
    const { x, y, valid } = scatterData;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < x.length; i++) {
      if (!valid[i]) continue;
      if (x[i] < xMin) xMin = x[i];
      if (x[i] > xMax) xMax = x[i];
      if (y[i] < yMin) yMin = y[i];
      if (y[i] > yMax) yMax = y[i];
    }
    // Add 5% padding
    const xPad = (xMax - xMin) * 0.05 || 1;
    const yPad = (yMax - yMin) * 0.05 || 1;
    return {
      xRange: [xMin - xPad, xMax + xPad],
      yRange: [yMin - yPad, yMax + yPad],
    };
  }, [scatterData]);

  // Build density grid
  const densityImage = useMemo(() => {
    if (!scatterData) return null;
    const grid = buildDensityGrid(scatterData.x, scatterData.y, scatterData.valid, xRange, yRange);
    return densityToImage(grid);
  }, [scatterData, xRange, yRange]);

  // Compute per-class pixel counts
  const classCounts = useMemo(() => {
    if (!scatterData || !classRegions.length) return [];
    return classifyCounts(scatterData.x, scatterData.y, scatterData.valid, classRegions);
  }, [scatterData, classRegions]);

  // --- Drawing ---
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const totalW = MARGIN.left + PLOT_W + MARGIN.right;
    const totalH = MARGIN.top + PLOT_H + MARGIN.bottom;
    canvas.width = totalW * dpr;
    canvas.height = totalH * dpr;
    canvas.style.width = `${totalW}px`;
    canvas.style.height = `${totalH}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, totalW, totalH);

    // Draw density heatmap
    if (densityImage) {
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = DENSITY_BINS;
      tmpCanvas.height = DENSITY_BINS;
      tmpCanvas.getContext('2d').putImageData(densityImage, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmpCanvas, MARGIN.left, MARGIN.top, PLOT_W, PLOT_H);
      ctx.imageSmoothingEnabled = true;
    }

    const [xMin, xMax] = xRange;
    const [yMin, yMax] = yRange;

    // Draw class rectangles
    for (let c = 0; c < classRegions.length; c++) {
      const r = classRegions[c];
      const lx = MARGIN.left + dataToPlot(r.xMin, xMin, xMax, PLOT_W);
      const rx = MARGIN.left + dataToPlot(r.xMax, xMin, xMax, PLOT_W);
      const ty = MARGIN.top + PLOT_H - dataToPlot(r.yMax, yMin, yMax, PLOT_H);
      const by = MARGIN.top + PLOT_H - dataToPlot(r.yMin, yMin, yMax, PLOT_H);
      const w = rx - lx;
      const h = by - ty;

      ctx.fillStyle = r.color + '40'; // ~25% alpha
      ctx.fillRect(lx, ty, w, h);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(lx, ty, w, h);

      // Label
      ctx.font = "bold 11px 'JetBrains Mono', monospace";
      ctx.fillStyle = r.color;
      ctx.fillText(r.name, lx + 4, ty + 14);
    }

    // Draw drag preview
    if (dragState?.type === 'new' && dragState.currentPx != null) {
      const { startPx, startPy, currentPx, currentPy, classIdx } = dragState;
      const color = classRegions[classIdx]?.color || CLASS_COLORS[classIdx % CLASS_COLORS.length];
      const lx = MARGIN.left + Math.min(startPx, currentPx);
      const ty = MARGIN.top + Math.min(startPy, currentPy);
      const w = Math.abs(currentPx - startPx);
      const h = Math.abs(currentPy - startPy);
      ctx.fillStyle = color + '30';
      ctx.fillRect(lx, ty, w, h);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(lx, ty, w, h);
      ctx.setLineDash([]);
    }

    // Axes
    ctx.strokeStyle = '#1e3a5f';
    ctx.lineWidth = 1;
    ctx.strokeRect(MARGIN.left, MARGIN.top, PLOT_W, PLOT_H);

    // Grid lines + labels
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillStyle = '#5a7099';
    ctx.textAlign = 'center';

    const nTicks = 5;
    for (let i = 0; i <= nTicks; i++) {
      const t = i / nTicks;
      // X axis
      const xVal = xMin + t * (xMax - xMin);
      const xPx = MARGIN.left + t * PLOT_W;
      ctx.beginPath();
      ctx.moveTo(xPx, MARGIN.top);
      ctx.lineTo(xPx, MARGIN.top + PLOT_H);
      ctx.strokeStyle = 'rgba(30,58,95,0.4)';
      ctx.stroke();
      ctx.fillText(xVal.toFixed(0), xPx, MARGIN.top + PLOT_H + 14);

      // Y axis
      const yVal = yMin + t * (yMax - yMin);
      const yPx = MARGIN.top + PLOT_H - t * PLOT_H;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, yPx);
      ctx.lineTo(MARGIN.left + PLOT_W, yPx);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(yVal.toFixed(0), MARGIN.left - 4, yPx + 3);
      ctx.textAlign = 'center';
    }

    // Axis labels
    ctx.fillStyle = '#e8edf5';
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.textAlign = 'center';
    ctx.fillText(xLabel || 'Band X (dB)', MARGIN.left + PLOT_W / 2, MARGIN.top + PLOT_H + 32);

    ctx.save();
    ctx.translate(12, MARGIN.top + PLOT_H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yLabel || 'Band Y (dB)', 0, 0);
    ctx.restore();

  }, [densityImage, classRegions, dragState, xRange, yRange, xLabel, yLabel]);

  // --- Mouse interaction for drawing class rectangles ---
  const handlePointerDown = useCallback((e) => {
    if (drawingClass < 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left - MARGIN.left;
    const py = e.clientY - rect.top - MARGIN.top;
    if (px < 0 || px > PLOT_W || py < 0 || py > PLOT_H) return;

    setDragState({ type: 'new', classIdx: drawingClass, startPx: px, startPy: py, currentPx: px, currentPy: py });
    e.preventDefault();
  }, [drawingClass]);

  const handlePointerMove = useCallback((e) => {
    if (!dragState || dragState.type !== 'new') return;
    const rect = canvasRef.current.getBoundingClientRect();
    const px = Math.max(0, Math.min(PLOT_W, e.clientX - rect.left - MARGIN.left));
    const py = Math.max(0, Math.min(PLOT_H, e.clientY - rect.top - MARGIN.top));
    setDragState(prev => ({ ...prev, currentPx: px, currentPy: py }));
  }, [dragState]);

  const handlePointerUp = useCallback((e) => {
    if (!dragState || dragState.type !== 'new') return;
    const rect = canvasRef.current.getBoundingClientRect();
    const px = Math.max(0, Math.min(PLOT_W, e.clientX - rect.left - MARGIN.left));
    const py = Math.max(0, Math.min(PLOT_H, e.clientY - rect.top - MARGIN.top));

    const { startPx, startPy, classIdx } = dragState;
    const w = Math.abs(px - startPx);
    const h = Math.abs(py - startPy);

    if (w > 5 && h > 5) {
      const [xMin, xMax] = xRange;
      const [yMin, yMax] = yRange;
      const x1 = plotToData(Math.min(startPx, px), xMin, xMax, PLOT_W);
      const x2 = plotToData(Math.max(startPx, px), xMin, xMax, PLOT_W);
      // Y is flipped (top of canvas = high value)
      const y1 = plotToData(PLOT_H - Math.max(startPy, py), yMin, yMax, PLOT_H);
      const y2 = plotToData(PLOT_H - Math.min(startPy, py), yMin, yMax, PLOT_H);

      const updated = [...classRegions];
      if (classIdx < updated.length) {
        updated[classIdx] = { ...updated[classIdx], xMin: x1, xMax: x2, yMin: y1, yMax: y2 };
      }
      onClassRegionsChange(updated);
    }

    setDragState(null);
    setDrawingClass(-1);
  }, [dragState, xRange, yRange, classRegions, onClassRegionsChange]);

  // Attach document-level listeners for drag
  useEffect(() => {
    if (!dragState) return;
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragState, handlePointerMove, handlePointerUp]);

  // --- Class management ---
  const addClass = useCallback(() => {
    const idx = classRegions.length;
    if (idx >= CLASS_COLORS.length) return;
    const newRegion = {
      name: DEFAULT_CLASS_NAMES[idx] || `Class ${idx + 1}`,
      color: CLASS_COLORS[idx],
      xMin: 0, xMax: 0, yMin: 0, yMax: 0,
    };
    onClassRegionsChange([...classRegions, newRegion]);
    setDrawingClass(idx);
  }, [classRegions, onClassRegionsChange]);

  const removeClass = useCallback((idx) => {
    const updated = classRegions.filter((_, i) => i !== idx);
    onClassRegionsChange(updated);
    if (drawingClass === idx) setDrawingClass(-1);
    else if (drawingClass > idx) setDrawingClass(drawingClass - 1);
  }, [classRegions, onClassRegionsChange, drawingClass]);

  const renameClass = useCallback((idx, newName) => {
    const updated = classRegions.map((r, i) => i === idx ? { ...r, name: newName } : r);
    onClassRegionsChange(updated);
  }, [classRegions, onClassRegionsChange]);

  const redrawClass = useCallback((idx) => {
    setDrawingClass(idx);
  }, []);

  const handleExportSVG = useCallback(() => {
    const svg = generateScatterSVG(scatterData, xLabel, yLabel, classRegions, xRange, yRange);
    if (svg) downloadSVG(svg, 'scatter_classification.svg');
  }, [scatterData, xLabel, yLabel, classRegions, xRange, yRange]);

  const handleExportClassMap = useCallback(() => {
    const svg = generateClassMapSVG(classificationMap, classifierRoiDims, classRegions);
    if (svg) downloadSVG(svg, 'class_map.svg');
  }, [classificationMap, classifierRoiDims, classRegions]);

  const formatCount = (n) => {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  };

  if (!scatterData) return null;

  const totalW = MARGIN.left + PLOT_W + MARGIN.right;

  return (
    <div style={{
      position: 'absolute',
      bottom: 16,
      right: 16,
      background: 'rgba(10, 22, 40, 0.94)',
      border: '1px solid #1e3a5f',
      borderRadius: 8,
      padding: 12,
      zIndex: 30,
      fontFamily: "'JetBrains Mono', monospace",
      color: '#e8edf5',
      minWidth: totalW + 24,
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.5px' }}>
          <span style={{ color: '#4ec9d4' }}>Feature Space</span>
        </span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button onClick={handleExportSVG} title="Export scatter SVG" style={{
            background: 'none', border: '1px solid #1e3a5f', color: '#5a7099', cursor: 'pointer',
            fontSize: 9, padding: '1px 5px', borderRadius: 3, fontFamily: 'inherit',
          }}>SVG</button>
          {classificationMap && (
            <button onClick={handleExportClassMap} title="Export class map SVG" style={{
              background: 'none', border: '1px solid #1e3a5f', color: '#5a7099', cursor: 'pointer',
              fontSize: 9, padding: '1px 5px', borderRadius: 3, fontFamily: 'inherit',
            }}>Map</button>
          )}
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#5a7099', cursor: 'pointer',
            fontSize: 16, padding: '0 4px', lineHeight: 1,
          }}>&times;</button>
        </div>
      </div>

      {/* Scatter canvas */}
      <canvas
        ref={canvasRef}
        style={{ cursor: drawingClass >= 0 ? 'crosshair' : 'default', display: 'block' }}
        onPointerDown={handlePointerDown}
      />

      {/* Drawing mode indicator */}
      {drawingClass >= 0 && (
        <div style={{ fontSize: 10, color: '#e8833a', marginTop: 4, textAlign: 'center' }}>
          Draw rectangle for: {classRegions[drawingClass]?.name || `Class ${drawingClass + 1}`}
        </div>
      )}

      {/* Class list */}
      <div style={{ marginTop: 8, borderTop: '1px solid #1e3a5f', paddingTop: 8 }}>
        {classRegions.map((r, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
            padding: '3px 4px', borderRadius: 4,
            background: drawingClass === i ? 'rgba(78,201,212,0.1)' : 'transparent',
          }}>
            <div style={{
              width: 12, height: 12, borderRadius: 2,
              background: r.color, flexShrink: 0,
            }} />
            <input
              type="text"
              value={r.name}
              onChange={(e) => renameClass(i, e.target.value)}
              style={{
                background: 'transparent', border: 'none', color: '#e8edf5',
                fontSize: 11, fontFamily: 'inherit', width: 100, padding: '1px 2px',
                borderBottom: '1px solid transparent',
              }}
              onFocus={(e) => { e.target.style.borderBottomColor = '#4ec9d4'; }}
              onBlur={(e) => { e.target.style.borderBottomColor = 'transparent'; }}
            />
            <span style={{ fontSize: 10, color: '#5a7099', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
              {classCounts[i] != null ? formatCount(classCounts[i]) : '—'}
            </span>
            <button
              onClick={() => redrawClass(i)}
              title="Redraw region"
              style={{
                background: 'none', border: 'none', color: '#4ec9d4', cursor: 'pointer',
                fontSize: 11, padding: '0 2px',
              }}
            >&#9998;</button>
            <button
              onClick={() => removeClass(i)}
              title="Remove class"
              style={{
                background: 'none', border: 'none', color: '#e74c3c', cursor: 'pointer',
                fontSize: 13, padding: '0 2px', lineHeight: 1,
              }}
            >&times;</button>
          </div>
        ))}
        {classRegions.length < CLASS_COLORS.length && (
          <button onClick={addClass} style={{
            background: 'rgba(78,201,212,0.12)',
            border: '1px solid rgba(78,201,212,0.3)',
            borderRadius: 4,
            color: '#4ec9d4',
            fontSize: 11,
            fontFamily: 'inherit',
            cursor: 'pointer',
            padding: '4px 10px',
            marginTop: 4,
            width: '100%',
          }}>+ Add Class</button>
        )}
      </div>

      {/* Incidence angle filter */}
      {!scatterData?.incidence && (
        <div style={{ marginTop: 8, borderTop: '1px solid #1e3a5f', paddingTop: 8, fontSize: 9, color: '#5a7099' }}>
          No incidence angle data (NISAR HDF5 only)
        </div>
      )}
      {scatterData?.incidence && incidenceRange && onIncidenceRangeChange && (() => {
        const inc = scatterData.incidence;
        const valid = scatterData.valid;
        let dataMin = 90, dataMax = 0;
        for (let i = 0; i < inc.length; i++) {
          if (valid[i] && !isNaN(inc[i])) {
            if (inc[i] < dataMin) dataMin = inc[i];
            if (inc[i] > dataMax) dataMax = inc[i];
          }
        }
        dataMin = Math.floor(dataMin);
        dataMax = Math.ceil(dataMax);
        const [curMin, curMax] = incidenceRange;
        return (
          <div style={{ marginTop: 8, borderTop: '1px solid #1e3a5f', paddingTop: 8 }}>
            <div style={{ fontSize: 10, color: '#5a7099', marginBottom: 4 }}>
              Incidence Angle Filter ({curMin}°–{curMax}°)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 9, color: '#5a7099', width: 22, textAlign: 'right' }}>{curMin}°</span>
              <input type="range" min={dataMin} max={dataMax} step={1} value={curMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  onIncidenceRangeChange([Math.min(v, curMax - 1), curMax]);
                }}
                style={{ flex: 1, accentColor: '#4ec9d4', height: 4 }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 9, color: '#5a7099', width: 22, textAlign: 'right' }}>{curMax}°</span>
              <input type="range" min={dataMin} max={dataMax} step={1} value={curMax}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  onIncidenceRangeChange([curMin, Math.max(v, curMin + 1)]);
                }}
                style={{ flex: 1, accentColor: '#e8833a', height: 4 }}
              />
            </div>
          </div>
        );
      })()}
    </div>
  );
}
