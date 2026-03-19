/**
 * HAlphaPlane — Cloude-Pottier H/α classification plane scatter plot.
 *
 * Renders the canonical 9-zone entropy (H) vs mean alpha angle (α) plane
 * as a 2D density heatmap with zone boundaries, feasibility curves, and
 * interactive zone-based classification.
 *
 * Zone layout (Cloude & Pottier 1997, IEEE TGRS 35(1)):
 *
 *   α (°)
 *   90 ┬─────────┬─────────┬─────────┐
 *      │   Z7    │   Z4    │   Z1    │  ← Double-bounce
 *  47.5├─────────┼─────────┼─────────┤
 *      │   Z8    │   Z5    │   Z2    │  ← Volume / dipole
 *  42.5├─────────┼─────────┼─────────┤
 *      │   Z9    │   Z6    │   Z3    │  ← Surface
 *    0 └─────────┴─────────┴─────────┘
 *      0        0.5       0.9        1   H (entropy)
 *
 * Reference: Cloude & Pottier 1997, "An entropy based classification
 *            scheme for land applications of polarimetric SAR"
 */

import React, { useRef, useEffect, useState, useCallback, useMemo, useLayoutEffect } from 'react';

/* ── Zone definitions ─────────────────────────────────────────────── */

const H_BOUNDS = [0.5, 0.9];          // entropy boundaries
const ALPHA_BOUNDS = [42.5, 47.5];     // alpha angle boundaries (°)

const ZONES = [
  // { id, label, description, hRange: [min, max], alphaRange: [min, max], color }
  { id: 'Z9', label: 'Z9', desc: 'Surface / Bragg',       hRange: [0, 0.5],  alphaRange: [0, 42.5],    color: '#3498db' },
  { id: 'Z8', label: 'Z8', desc: 'Dipole',                hRange: [0, 0.5],  alphaRange: [42.5, 47.5], color: '#2ecc71' },
  { id: 'Z7', label: 'Z7', desc: 'Double-bounce',         hRange: [0, 0.5],  alphaRange: [47.5, 90],   color: '#e74c3c' },
  { id: 'Z6', label: 'Z6', desc: 'Random surface',        hRange: [0.5, 0.9], alphaRange: [0, 42.5],   color: '#5dade2' },
  { id: 'Z5', label: 'Z5', desc: 'Vegetation',            hRange: [0.5, 0.9], alphaRange: [42.5, 47.5], color: '#58d68d' },
  { id: 'Z4', label: 'Z4', desc: 'Forest / dbl-bounce',   hRange: [0.5, 0.9], alphaRange: [47.5, 90],  color: '#ec7063' },
  { id: 'Z3', label: 'Z3', desc: 'High-ent surface',      hRange: [0.9, 1.0], alphaRange: [0, 42.5],   color: '#85c1e9' },
  { id: 'Z2', label: 'Z2', desc: 'High-ent vegetation',   hRange: [0.9, 1.0], alphaRange: [42.5, 47.5], color: '#82e0aa' },
  { id: 'Z1', label: 'Z1', desc: 'High-ent dbl-bounce',   hRange: [0.9, 1.0], alphaRange: [47.5, 90],  color: '#f1948a' },
];

/* ── Feasibility curves ───────────────────────────────────────────── */

/**
 * Compute the upper and lower feasibility boundaries in the H-α plane.
 *
 * For a 3×3 coherency matrix with eigenvalues λ1 ≥ λ2 ≥ λ3 ≥ 0,
 * the extremes are:
 *   - Curve 1 (upper): λ3 = 0, vary m = λ2/λ1 from 0→1
 *     α_max from surface (0°) to isotropic (60°)
 *   - Curve 2 (lower): λ2 = λ3, vary m = λ2/λ1 from 0→0.5
 *     α_min — tighter constraint
 *
 * Returns arrays of {h, alpha} points for drawing.
 */
function computeFeasibilityCurves(nPoints = 200) {
  const LOG3 = Math.log(3);

  // Upper boundary: λ3 = 0, λ2 = m·λ1, sweep m ∈ [0, 1]
  const upper = [];
  for (let i = 0; i <= nPoints; i++) {
    const m = i / nPoints;
    const p1 = 1 / (1 + m);
    const p2 = m / (1 + m);
    let H = 0;
    if (p1 > 1e-10) H -= p1 * Math.log(p1) / LOG3;
    if (p2 > 1e-10) H -= p2 * Math.log(p2) / LOG3;
    // Alpha for 2-mechanism case: α ranges from 0° (m=0) to 90° (m→∞)
    // Upper boundary: α1 = 0 (surface), α2 = 90° (dbl-bounce)
    // Mean α = p1·0 + p2·90 = 90·m/(1+m)
    const alpha = 90 * m / (1 + m);
    upper.push({ h: H, alpha });
  }

  // Lower boundary: α1 = α2 = α3, all mechanisms same angle
  // For minimum α at given H: λ2 = λ3, vary ratio m = λ2/λ1
  const lower = [];
  for (let i = 0; i <= nPoints; i++) {
    const m = (i / nPoints) * 0.5;  // m ∈ [0, 0.5] for λ2 = λ3
    const denom = 1 + 2 * m;
    const p1 = 1 / denom;
    const p2 = m / denom;
    const p3 = m / denom;
    let H = 0;
    if (p1 > 1e-10) H -= p1 * Math.log(p1) / LOG3;
    if (p2 > 1e-10) H -= p2 * Math.log(p2) / LOG3;
    if (p3 > 1e-10) H -= p3 * Math.log(p3) / LOG3;
    // Minimum alpha: all eigenvectors aligned to surface → α = 0
    // This gives the H-axis itself as lower bound
    lower.push({ h: H, alpha: 0 });
  }

  // Also compute upper bound for 3-eigenvalue case:
  // λ2 = λ3, α1 = 90°, α2 = α3 = 0° → max spread
  const upper3 = [];
  for (let i = 0; i <= nPoints; i++) {
    const m = (i / nPoints) * 0.5;
    const denom = 1 + 2 * m;
    const p1 = 1 / denom;
    const p2 = m / denom;
    let H = 0;
    if (p1 > 1e-10) H -= p1 * Math.log(p1) / LOG3;
    if (p2 > 1e-10) H -= 2 * p2 * Math.log(p2) / LOG3;
    const alpha = p1 * 90 + p2 * 0 + p2 * 0;
    upper3.push({ h: H, alpha });
  }

  return { upper, lower, upper3 };
}

/* ── Canvas constants ─────────────────────────────────────────────── */

const PLOT_W = 320;
const PLOT_H = 320;
const MARGIN = { top: 12, right: 20, bottom: 44, left: 52 };
const DENSITY_BINS = 180;

/* ── Density grid + rendering ─────────────────────────────────────── */

function buildDensityGrid(hArr, alphaArr, valid) {
  const grid = new Uint32Array(DENSITY_BINS * DENSITY_BINS);
  for (let i = 0; i < hArr.length; i++) {
    if (!valid[i]) continue;
    const bx = Math.floor(hArr[i] * (DENSITY_BINS - 1));
    const by = Math.floor((alphaArr[i] / 90) * (DENSITY_BINS - 1));
    if (bx < 0 || bx >= DENSITY_BINS || by < 0 || by >= DENSITY_BINS) continue;
    // Flip Y so 0° is at bottom
    grid[(DENSITY_BINS - 1 - by) * DENSITY_BINS + bx]++;
  }
  return grid;
}

function densityToImage(grid) {
  const img = new ImageData(DENSITY_BINS, DENSITY_BINS);
  let maxCount = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] > maxCount) maxCount = grid[i];
  const logMax = Math.log10(maxCount + 1) || 1;

  for (let i = 0; i < grid.length; i++) {
    const t = grid[i] > 0 ? Math.log10(grid[i] + 1) / logMax : 0;
    const idx = i * 4;
    if (t === 0) {
      // Transparent background
      img.data[idx] = 0; img.data[idx + 1] = 0; img.data[idx + 2] = 0; img.data[idx + 3] = 0;
    } else if (t < 0.33) {
      const s = t / 0.33;
      img.data[idx]     = Math.round(s * 20);
      img.data[idx + 1] = Math.round(s * 60);
      img.data[idx + 2] = Math.round(40 + s * 120);
      img.data[idx + 3] = Math.round(100 + s * 155);
    } else if (t < 0.66) {
      const s = (t - 0.33) / 0.33;
      img.data[idx]     = Math.round(20 + s * 58);
      img.data[idx + 1] = Math.round(60 + s * 141);
      img.data[idx + 2] = Math.round(160 + s * 52);
      img.data[idx + 3] = 255;
    } else {
      const s = (t - 0.66) / 0.34;
      img.data[idx]     = Math.round(78 + s * 154);
      img.data[idx + 1] = Math.round(201 + s * 36);
      img.data[idx + 2] = Math.round(212 + s * 33);
      img.data[idx + 3] = 255;
    }
  }
  return img;
}

/**
 * Classify each pixel into one of the 9 Cloude-Pottier zones.
 * Returns Uint8Array with zone index (0=unclassified, 1-9=Z1-Z9).
 */
function classifyPixels(hArr, alphaArr, valid) {
  const n = hArr.length;
  const zones = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    const h = hArr[i];
    const a = alphaArr[i];

    // Determine H column: 0 = low, 1 = medium, 2 = high
    const hCol = h < H_BOUNDS[0] ? 0 : h < H_BOUNDS[1] ? 1 : 2;
    // Determine α row: 0 = surface, 1 = volume, 2 = double-bounce
    const aRow = a < ALPHA_BOUNDS[0] ? 0 : a < ALPHA_BOUNDS[1] ? 1 : 2;

    // Zone numbering: Z9=low-H/low-α, Z1=high-H/high-α
    // Layout: zone = 9 - (hCol * 3 + aRow)
    zones[i] = 9 - (hCol * 3 + aRow);
  }

  return zones;
}

/**
 * Count pixels per zone.
 */
function countZones(zoneMap) {
  const counts = new Array(10).fill(0); // index 0 = unclassified, 1-9 = zones
  for (let i = 0; i < zoneMap.length; i++) {
    counts[zoneMap[i]]++;
  }
  return counts;
}

/* ── Component ────────────────────────────────────────────────────── */

export default function HAlphaPlane({
  hData,          // Float32Array — entropy H ∈ [0, 1]
  alphaData,      // Float32Array — alpha angle ∈ [0°, 90°]
  anisotropyData, // Float32Array (optional) — anisotropy A ∈ [0, 1]
  valid,          // Uint8Array — validity mask
  width,          // ROI pixel width
  height,         // ROI pixel height
  onZoneClassification,  // (Uint8Array) => void — feed zone map back
  onClose,
}) {
  const canvasRef = useRef(null);
  const [selectedZones, setSelectedZones] = useState(new Set([1,2,3,4,5,6,7,8,9]));
  const [showFeasibility, setShowFeasibility] = useState(true);
  const [showZoneLabels, setShowZoneLabels] = useState(true);
  const [anisotropyFilter, setAnisotropyFilter] = useState([0, 1]);

  // Feasibility curves (computed once)
  const feasibility = useMemo(() => computeFeasibilityCurves(), []);

  // Filter valid pixels by anisotropy if available
  const effectiveValid = useMemo(() => {
    if (!anisotropyData || (anisotropyFilter[0] <= 0 && anisotropyFilter[1] >= 1)) {
      return valid;
    }
    const v = new Uint8Array(valid.length);
    const [aMin, aMax] = anisotropyFilter;
    for (let i = 0; i < valid.length; i++) {
      if (valid[i] && anisotropyData[i] >= aMin && anisotropyData[i] <= aMax) v[i] = 1;
    }
    return v;
  }, [valid, anisotropyData, anisotropyFilter]);

  // Density grid
  const densityImage = useMemo(() => {
    if (!hData || !alphaData) return null;
    const grid = buildDensityGrid(hData, alphaData, effectiveValid);
    return densityToImage(grid);
  }, [hData, alphaData, effectiveValid]);

  // Zone classification
  const zoneMap = useMemo(() => {
    if (!hData || !alphaData) return null;
    return classifyPixels(hData, alphaData, effectiveValid);
  }, [hData, alphaData, effectiveValid]);

  const zoneCounts = useMemo(() => {
    if (!zoneMap) return new Array(10).fill(0);
    return countZones(zoneMap);
  }, [zoneMap]);

  const totalValid = useMemo(() => {
    let count = 0;
    for (let i = 0; i < effectiveValid.length; i++) if (effectiveValid[i]) count++;
    return count;
  }, [effectiveValid]);

  // Push classification to parent when zones change
  useEffect(() => {
    if (!zoneMap || !onZoneClassification) return;
    // Build a classification mask: 1 = in selected zone, 0 = not
    const mask = new Uint8Array(zoneMap.length);
    for (let i = 0; i < zoneMap.length; i++) {
      if (zoneMap[i] > 0 && selectedZones.has(zoneMap[i])) mask[i] = zoneMap[i];
    }
    onZoneClassification(mask);
  }, [zoneMap, selectedZones, onZoneClassification]);

  // Canvas rendering
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

    // Plot background: dark
    ctx.fillStyle = 'rgba(10, 22, 40, 0.8)';
    ctx.fillRect(MARGIN.left, MARGIN.top, PLOT_W, PLOT_H);

    // ── Zone fills (subtle background) ──
    for (const zone of ZONES) {
      const [hMin, hMax] = zone.hRange;
      const [aMin, aMax] = zone.alphaRange;
      const x1 = MARGIN.left + (hMin / 1) * PLOT_W;
      const x2 = MARGIN.left + (hMax / 1) * PLOT_W;
      const y1 = MARGIN.top + PLOT_H - (aMax / 90) * PLOT_H;
      const y2 = MARGIN.top + PLOT_H - (aMin / 90) * PLOT_H;

      const isSelected = selectedZones.has(parseInt(zone.id.slice(1)));
      ctx.fillStyle = zone.color + (isSelected ? '18' : '08');
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    }

    // ── Density heatmap ──
    if (densityImage) {
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = DENSITY_BINS;
      tmpCanvas.height = DENSITY_BINS;
      tmpCanvas.getContext('2d').putImageData(densityImage, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmpCanvas, MARGIN.left, MARGIN.top, PLOT_W, PLOT_H);
      ctx.imageSmoothingEnabled = true;
    }

    // ── Zone boundary lines ──
    ctx.strokeStyle = 'rgba(78, 201, 212, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);

    // Vertical H boundaries
    for (const h of H_BOUNDS) {
      const x = MARGIN.left + (h / 1) * PLOT_W;
      ctx.beginPath();
      ctx.moveTo(x, MARGIN.top);
      ctx.lineTo(x, MARGIN.top + PLOT_H);
      ctx.stroke();
    }

    // Horizontal α boundaries
    for (const a of ALPHA_BOUNDS) {
      const y = MARGIN.top + PLOT_H - (a / 90) * PLOT_H;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, y);
      ctx.lineTo(MARGIN.left + PLOT_W, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // ── Feasibility curves ──
    if (showFeasibility) {
      ctx.lineWidth = 1.5;

      // Upper bound (2-eigenvalue)
      ctx.strokeStyle = 'rgba(232, 131, 58, 0.7)';
      ctx.beginPath();
      for (let i = 0; i < feasibility.upper.length; i++) {
        const { h, alpha } = feasibility.upper[i];
        const x = MARGIN.left + h * PLOT_W;
        const y = MARGIN.top + PLOT_H - (alpha / 90) * PLOT_H;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Upper bound (3-eigenvalue)
      ctx.strokeStyle = 'rgba(232, 131, 58, 0.4)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      for (let i = 0; i < feasibility.upper3.length; i++) {
        const { h, alpha } = feasibility.upper3[i];
        const x = MARGIN.left + h * PLOT_W;
        const y = MARGIN.top + PLOT_H - (alpha / 90) * PLOT_H;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Zone labels ──
    if (showZoneLabels) {
      ctx.font = "bold 10px 'JetBrains Mono', monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (const zone of ZONES) {
        const [hMin, hMax] = zone.hRange;
        const [aMin, aMax] = zone.alphaRange;
        const cx = MARGIN.left + ((hMin + hMax) / 2) * PLOT_W;
        const cy = MARGIN.top + PLOT_H - ((aMin + aMax) / 2 / 90) * PLOT_H;

        const zoneNum = parseInt(zone.id.slice(1));
        const isSelected = selectedZones.has(zoneNum);

        ctx.fillStyle = isSelected ? zone.color : 'rgba(90, 112, 153, 0.5)';
        ctx.fillText(zone.id, cx, cy - 6);
        ctx.font = "8px 'JetBrains Mono', monospace";
        ctx.fillStyle = isSelected ? 'rgba(232, 237, 245, 0.8)' : 'rgba(90, 112, 153, 0.4)';
        ctx.fillText(zone.desc, cx, cy + 6);
        ctx.font = "bold 10px 'JetBrains Mono', monospace";
      }
    }

    // ── Axes frame ──
    ctx.strokeStyle = '#1e3a5f';
    ctx.lineWidth = 1;
    ctx.strokeRect(MARGIN.left, MARGIN.top, PLOT_W, PLOT_H);

    // ── Grid lines + labels ──
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillStyle = '#5a7099';
    ctx.textAlign = 'center';

    // X-axis: H (entropy) 0 → 1
    for (let i = 0; i <= 10; i++) {
      const h = i / 10;
      const x = MARGIN.left + (h / 1) * PLOT_W;
      if (i > 0 && i < 10) {
        ctx.beginPath();
        ctx.moveTo(x, MARGIN.top);
        ctx.lineTo(x, MARGIN.top + PLOT_H);
        ctx.strokeStyle = 'rgba(30, 58, 95, 0.3)';
        ctx.stroke();
      }
      if (i % 2 === 0) {
        ctx.fillStyle = '#5a7099';
        ctx.fillText(h.toFixed(1), x, MARGIN.top + PLOT_H + 14);
      }
    }

    // Y-axis: α (alpha) 0° → 90°
    ctx.textAlign = 'right';
    for (let a = 0; a <= 90; a += 10) {
      const y = MARGIN.top + PLOT_H - (a / 90) * PLOT_H;
      if (a > 0 && a < 90) {
        ctx.beginPath();
        ctx.moveTo(MARGIN.left, y);
        ctx.lineTo(MARGIN.left + PLOT_W, y);
        ctx.strokeStyle = 'rgba(30, 58, 95, 0.3)';
        ctx.stroke();
      }
      ctx.fillStyle = '#5a7099';
      ctx.fillText(`${a}°`, MARGIN.left - 4, y + 3);
    }

    // Axis labels
    ctx.fillStyle = '#e8edf5';
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.textAlign = 'center';
    ctx.fillText('Entropy H', MARGIN.left + PLOT_W / 2, MARGIN.top + PLOT_H + 32);

    ctx.save();
    ctx.translate(14, MARGIN.top + PLOT_H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Alpha α (°)', 0, 0);
    ctx.restore();

  }, [densityImage, selectedZones, showFeasibility, showZoneLabels, feasibility]);

  // Toggle zone selection
  const toggleZone = useCallback((zoneNum) => {
    setSelectedZones(prev => {
      const next = new Set(prev);
      if (next.has(zoneNum)) next.delete(zoneNum);
      else next.add(zoneNum);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedZones(new Set([1,2,3,4,5,6,7,8,9]));
  }, []);

  const selectNone = useCallback(() => {
    setSelectedZones(new Set());
  }, []);

  const formatCount = (n) => {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  };

  const formatPct = (n, total) => {
    if (total === 0) return '0%';
    return (n / total * 100).toFixed(1) + '%';
  };

  if (!hData || !alphaData) return null;

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
      maxHeight: 'calc(100vh - 100px)',
      overflowY: 'auto',
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.5px' }}>
          <span style={{ color: '#4ec9d4' }}>H/α Classification Plane</span>
          <span style={{ color: '#5a7099', fontWeight: 400, fontSize: 10, marginLeft: 8 }}>
            Cloude-Pottier
          </span>
        </span>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: '#5a7099', cursor: 'pointer',
          fontSize: 16, padding: '0 4px', lineHeight: 1,
        }}>&times;</button>
      </div>

      {/* Canvas */}
      <canvas ref={canvasRef} style={{ display: 'block' }} />

      {/* Controls row */}
      <div style={{
        display: 'flex', gap: 8, marginTop: 8, fontSize: 10, color: '#5a7099',
        alignItems: 'center', flexWrap: 'wrap',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={showFeasibility} onChange={() => setShowFeasibility(!showFeasibility)}
            style={{ accentColor: '#e8833a' }} />
          Feasibility
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={showZoneLabels} onChange={() => setShowZoneLabels(!showZoneLabels)}
            style={{ accentColor: '#4ec9d4' }} />
          Labels
        </label>
        <span style={{ marginLeft: 'auto' }}>
          {formatCount(totalValid)} pixels
        </span>
      </div>

      {/* Zone table */}
      <div style={{ marginTop: 8, borderTop: '1px solid #1e3a5f', paddingTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 10, color: '#5a7099', fontWeight: 600 }}>Scattering zones</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={selectAll} style={{
              background: 'none', border: 'none', color: '#4ec9d4', cursor: 'pointer',
              fontSize: 9, fontFamily: 'inherit', padding: 0,
            }}>all</button>
            <button onClick={selectNone} style={{
              background: 'none', border: 'none', color: '#4ec9d4', cursor: 'pointer',
              fontSize: 9, fontFamily: 'inherit', padding: 0,
            }}>none</button>
          </div>
        </div>

        {ZONES.map((zone) => {
          const zoneNum = parseInt(zone.id.slice(1));
          const count = zoneCounts[zoneNum] || 0;
          const pct = formatPct(count, totalValid);
          const isSelected = selectedZones.has(zoneNum);
          const barWidth = totalValid > 0 ? (count / totalValid) * 100 : 0;

          return (
            <div key={zone.id} style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2,
              padding: '2px 4px', borderRadius: 3, cursor: 'pointer',
              background: isSelected ? 'rgba(78, 201, 212, 0.06)' : 'transparent',
              opacity: isSelected ? 1 : 0.5,
            }} onClick={() => toggleZone(zoneNum)}>
              <div style={{
                width: 10, height: 10, borderRadius: 2,
                background: zone.color, flexShrink: 0,
                border: isSelected ? '1px solid rgba(255,255,255,0.3)' : '1px solid transparent',
              }} />
              <span style={{ fontSize: 10, fontWeight: 600, width: 22, color: zone.color }}>
                {zone.id}
              </span>
              <span style={{ fontSize: 9, color: '#8899aa', width: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {zone.desc}
              </span>
              {/* Mini bar */}
              <div style={{
                flex: 1, height: 4, background: 'rgba(30, 58, 95, 0.5)',
                borderRadius: 2, overflow: 'hidden', minWidth: 40,
              }}>
                <div style={{
                  width: `${barWidth}%`, height: '100%',
                  background: zone.color, borderRadius: 2,
                }} />
              </div>
              <span style={{ fontSize: 9, color: '#5a7099', width: 35, textAlign: 'right' }}>
                {pct}
              </span>
              <span style={{ fontSize: 9, color: '#3d5577', width: 35, textAlign: 'right' }}>
                {formatCount(count)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Anisotropy filter */}
      {anisotropyData && (
        <div style={{ marginTop: 8, borderTop: '1px solid #1e3a5f', paddingTop: 8 }}>
          <div style={{ fontSize: 10, color: '#5a7099', marginBottom: 4 }}>
            Anisotropy filter ({anisotropyFilter[0].toFixed(2)} – {anisotropyFilter[1].toFixed(2)})
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 9, color: '#5a7099', width: 8 }}>A</span>
            <input type="range" min={0} max={1} step={0.01} value={anisotropyFilter[0]}
              onChange={(e) => {
                const v = Number(e.target.value);
                setAnisotropyFilter([Math.min(v, anisotropyFilter[1] - 0.01), anisotropyFilter[1]]);
              }}
              style={{ flex: 1, accentColor: '#4ec9d4', height: 4 }}
            />
            <input type="range" min={0} max={1} step={0.01} value={anisotropyFilter[1]}
              onChange={(e) => {
                const v = Number(e.target.value);
                setAnisotropyFilter([anisotropyFilter[0], Math.max(v, anisotropyFilter[0] + 0.01)]);
              }}
              style={{ flex: 1, accentColor: '#e8833a', height: 4 }}
            />
          </div>
        </div>
      )}

      {/* Interpretation guide */}
      <div style={{
        marginTop: 8, borderTop: '1px solid #1e3a5f', paddingTop: 6,
        fontSize: 8, color: '#3d5577', lineHeight: 1.5,
      }}>
        Low H = single mechanism · High H = random ·
        Low α = surface · Mid α = volume · High α = dbl-bounce
      </div>
    </div>
  );
}
