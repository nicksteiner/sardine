import { useMemo, useRef } from 'react';
import { worldToPixel } from '../utils/geo-overlays.js';

/**
 * ROIProfilePlot — SAR profile plots overlaid on the viewer when a ROI is active.
 *
 * Layout (all positioned relative to the ROI box on screen):
 *   LEFT  : vertical Y-profile chart  (row means, value → horizontal axis)
 *   BOTTOM: horizontal X-profile chart (column means, value → vertical axis)
 *   CENTER: inset histogram (all ROI values, bins → horizontal, count → vertical)
 *
 * Props:
 *   roi         — {left, top, width, height} in image pixels
 *   profileData — {rowMeans, colMeans, hist, histMin, histMax, mean, count,
 *                  exportW, exportH, useDecibels}
 *   viewState   — deck.gl viewState {target, zoom}
 *   bounds      — [minX, minY, maxX, maxY] world bounds
 *   imageWidth  — source width in pixels
 *   imageHeight — source height in pixels
 *   useDecibels — for axis labels
 */
export function ROIProfilePlot({
  roi,
  profileData,
  viewState,
  bounds,
  imageWidth,
  imageHeight,
  useDecibels = true,
  show = { v: true, h: true, i: true },
}) {
  const containerRef = useRef(null);

  // Read container dimensions directly from the ref — no state needed.
  // viewState changes on every pan/zoom so this useMemo recalculates naturally.
  const layout = useMemo(() => {
    const el = containerRef.current;
    if (!el || !roi || !profileData || !viewState || !bounds || !imageWidth || !imageHeight) return null;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (!cw || !ch) return null;

    const [minX, minY, maxX, maxY] = bounds;

    // Convert image pixel → screen coords using measured container dimensions
    const imgToScreen = (imgX, imgY) => {
      const wx = minX + (imgX / imageWidth) * (maxX - minX);
      const wy = minY + (imgY / imageHeight) * (maxY - minY);
      return worldToPixel(wx, wy, viewState, cw, ch);
    };

    const [sx0, sy0] = imgToScreen(roi.left, roi.top);
    const [sx1, sy1] = imgToScreen(roi.left + roi.width, roi.top + roi.height);

    const roiW = sx1 - sx0;
    const roiH = sy1 - sy0;

    // Require minimum screen size to bother rendering
    if (Math.abs(roiW) < 30 || Math.abs(roiH) < 30) return null;

    // Normalize so lx0 < lx1, ly0 < ly1 for layout
    const lx0 = Math.min(sx0, sx1);
    const ly0 = Math.min(sy0, sy1);
    const lw = Math.abs(roiW);
    const lh = Math.abs(roiH);

    // Chart dimensions: proportional to ROI but capped so they stay readable
    // Y-profile width scales with ROI width (never wider than the ROI itself)
    const yProfW = Math.max(60, Math.min(100, lw * 0.7));
    // Y-profile height capped so tall ROIs don't create absurd panels
    const yProfH = Math.min(200, lh);
    // X-profile height scales with ROI height
    const xProfH = Math.max(50, Math.min(80, lh * 0.15));
    // X-profile width capped for wide ROIs
    const xProfW = Math.min(250, lw);
    const gap = 8;

    // Center the capped charts on the ROI midpoint
    const roiMidY = ly0 + lh / 2;
    const roiMidX = lx0 + lw / 2;

    // Histogram inset: centred in ROI box
    const histW = Math.max(120, Math.min(180, lw * 0.7));
    const histH = Math.max(80, Math.min(110, lh * 0.2));
    const histX = roiMidX - histW / 2;
    const histY = roiMidY - histH / 2;

    return {
      // ROI box on screen
      sx0: lx0, sy0: ly0, sx1: lx0 + lw, sy1: ly0 + lh, roiW: lw, roiH: lh,
      // Y-profile (left of ROI) — centred vertically on ROI midpoint
      yProf: { x: lx0 - gap - yProfW, y: roiMidY - yProfH / 2, w: yProfW, h: yProfH },
      // X-profile (below ROI) — centred horizontally on ROI midpoint
      xProf: { x: roiMidX - xProfW / 2, y: ly0 + lh + gap, w: xProfW, h: xProfH },
      // Histogram inset
      hist: { x: histX, y: histY, w: histW, h: histH },
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roi, profileData, viewState, bounds, imageWidth, imageHeight]);

  // ── Always render the container so the ref is available ─────────────────

  const hasContent = layout && profileData;

  // Early extract profile data for rendering (safe because we check hasContent below)
  const { rowMeans, colMeans, hist, histMin, histMax, mean, count, useDecibels: pdDb } = profileData || {};
  const db = pdDb ?? useDecibels;
  const unit = db ? 'dB' : 'power';

  // ── colour tokens (match sardine theme) ──────────────────────────────────
  const C = {
    bg:      'rgba(10, 22, 40, 0.88)',
    border:  '#1e3a5f',
    cyan:    '#4ec9d4',
    cyanDim: 'rgba(78,201,212,0.35)',
    orange:  '#e8833a',
    muted:   '#5a7099',
    text:    '#e8edf5',
    mono:    "'JetBrains Mono', monospace",
  };

  // Compute value range from valid row/col means
  const allMeans = hasContent ? [...(rowMeans || []), ...(colMeans || [])].filter(v => !isNaN(v)) : [];
  const vMin = allMeans.length ? Math.min(...allMeans) : (histMin ?? 0);
  const vMax = allMeans.length ? Math.max(...allMeans) : (histMax ?? 1);
  const vRange = vMax - vMin || 1;

  const fmt = (v) => isNaN(v) ? '' : v.toFixed(1);
  const fmtShort = (v) => {
    if (isNaN(v)) return '';
    if (Math.abs(v) >= 100) return v.toFixed(0);
    return v.toFixed(1);
  };

  // ── SVG helpers ───────────────────────────────────────────────────────────
  const chartBg = (x, y, w, h) => (
    <rect x={x} y={y} width={w} height={h}
      fill={C.bg} stroke={C.border} strokeWidth={0.75} rx={2} />
  );

  // Padding inside chart areas
  const yPad = { t: 4, r: 4, b: 14, l: 30 };  // Y-profile: left has value ticks
  const xPad = { t: 4, r: 4, b: 14, l: 4 };    // X-profile: bottom has value ticks
  const hPad = { t: 14, r: 4, b: 16, l: 4 };   // Histogram: top has stats, bottom has value ticks

  // Y-profile: line chart, one point per row (row 0 = top of ROI)
  // The chart height spans the ROI so rows map 1:1 vertically
  const yProfLines = () => {
    if (!rowMeans?.length) return null;
    const { x, y, w, h } = layout.yProf;
    const innerW = w - yPad.l - yPad.r;
    const innerH = h - yPad.t - yPad.b;
    if (innerW < 4 || innerH < 4) return null;
    const n = rowMeans.length;
    const pts = Array.from(rowMeans).map((v, i) => {
      if (isNaN(v)) return null;
      const px = yPad.l + ((v - vMin) / vRange) * innerW;
      const py = yPad.t + (i / Math.max(n - 1, 1)) * innerH;
      return `${x + px},${y + py}`;
    }).filter(Boolean);

    return (
      <g>
        {chartBg(x, y, w, h)}
        {/* vertical axis line at left edge of plot area */}
        <line x1={x + yPad.l} y1={y + yPad.t} x2={x + yPad.l} y2={y + h - yPad.b}
          stroke={C.border} strokeWidth={0.5} />
        {/* mean marker — vertical dashed line */}
        {!isNaN(mean) && (() => {
          const mx = x + yPad.l + ((mean - vMin) / vRange) * innerW;
          return (
            <line x1={mx} y1={y + yPad.t} x2={mx} y2={y + h - yPad.b}
              stroke={C.orange} strokeWidth={0.75} strokeDasharray="3,2" opacity={0.7} />
          );
        })()}
        {/* profile line */}
        {pts.length > 1 && (
          <polyline points={pts.join(' ')} fill="none"
            stroke={C.cyan} strokeWidth={1.25} strokeLinejoin="round" opacity={0.9} />
        )}
        {/* value axis ticks — bottom edge, show min and max */}
        <text x={x + yPad.l} y={y + h - 2} textAnchor="start"
          fill={C.muted} fontSize={7.5} fontFamily={C.mono}>{fmtShort(vMin)}</text>
        <text x={x + yPad.l + innerW} y={y + h - 2} textAnchor="end"
          fill={C.muted} fontSize={7.5} fontFamily={C.mono}>{fmtShort(vMax)}</text>
        {/* chart title */}
        <text x={x + w / 2} y={y - 3} textAnchor="middle"
          fill={C.muted} fontSize={8} fontFamily={C.mono}>Y profile ({unit})</text>
      </g>
    );
  };

  // X-profile: line chart, one point per column (col 0 = left of ROI)
  // The chart width spans the ROI so columns map 1:1 horizontally
  const xProfLines = () => {
    if (!colMeans?.length) return null;
    const { x, y, w, h } = layout.xProf;
    const innerW = w - xPad.l - xPad.r;
    const innerH = h - xPad.t - xPad.b;
    if (innerW < 4 || innerH < 4) return null;
    const n = colMeans.length;
    const pts = Array.from(colMeans).map((v, i) => {
      if (isNaN(v)) return null;
      const px = xPad.l + (i / Math.max(n - 1, 1)) * innerW;
      const py = xPad.t + (1 - (v - vMin) / vRange) * innerH;
      return `${x + px},${y + py}`;
    }).filter(Boolean);

    return (
      <g>
        {chartBg(x, y, w, h)}
        {/* horizontal baseline at bottom of plot area */}
        <line x1={x + xPad.l} y1={y + h - xPad.b} x2={x + xPad.l + innerW} y2={y + h - xPad.b}
          stroke={C.border} strokeWidth={0.5} />
        {/* mean marker — horizontal dashed line */}
        {!isNaN(mean) && (() => {
          const my = y + xPad.t + (1 - (mean - vMin) / vRange) * innerH;
          return (
            <line x1={x + xPad.l} y1={my} x2={x + xPad.l + innerW} y2={my}
              stroke={C.orange} strokeWidth={0.75} strokeDasharray="3,2" opacity={0.7} />
          );
        })()}
        {/* profile line */}
        {pts.length > 1 && (
          <polyline points={pts.join(' ')} fill="none"
            stroke={C.cyan} strokeWidth={1.25} strokeLinejoin="round" opacity={0.9} />
        )}
        {/* value axis ticks — left edge, show min at bottom and max at top */}
        <text x={x + 2} y={y + h - xPad.b + 10} textAnchor="start"
          fill={C.muted} fontSize={7.5} fontFamily={C.mono}>{fmtShort(vMin)}</text>
        <text x={x + 2} y={y + xPad.t - 1} textAnchor="start"
          fill={C.muted} fontSize={7.5} fontFamily={C.mono}>{fmtShort(vMax)}</text>
        {/* chart title */}
        <text x={x + w / 2} y={y + h + 11} textAnchor="middle"
          fill={C.muted} fontSize={8} fontFamily={C.mono}>X profile ({unit})</text>
      </g>
    );
  };

  // Histogram inset
  const histPlot = () => {
    if (!hist?.length) return null;
    const { x, y, w, h } = layout.hist;
    const innerW = w - hPad.l - hPad.r;
    const innerH = h - hPad.t - hPad.b;
    if (innerW < 4 || innerH < 4) return null;
    const n = hist.length;
    const maxCount = Math.max(...hist, 1);
    const binW = innerW / n;

    const meanBin = !isNaN(mean) && !isNaN(histMin) && !isNaN(histMax)
      ? ((mean - histMin) / (histMax - histMin || 1)) * innerW
      : null;

    return (
      <g>
        {/* Background */}
        <rect x={x} y={y} width={w} height={h}
          fill="rgba(10,22,40,0.92)" stroke={C.cyan} strokeWidth={0.75}
          strokeDasharray="4,3" rx={2} />

        {/* Bars */}
        {Array.from(hist).map((cnt, i) => {
          const bh = (cnt / maxCount) * innerH;
          return (
            <rect key={i}
              x={x + hPad.l + i * binW} y={y + hPad.t + innerH - bh}
              width={Math.max(1, binW - 0.5)} height={bh}
              fill={C.cyanDim}
            />
          );
        })}

        {/* Axis */}
        <line x1={x + hPad.l} y1={y + hPad.t + innerH}
          x2={x + hPad.l + innerW} y2={y + hPad.t + innerH}
          stroke={C.border} strokeWidth={0.75} />

        {/* Mean line */}
        {meanBin !== null && (
          <line
            x1={x + hPad.l + meanBin} y1={y + hPad.t}
            x2={x + hPad.l + meanBin} y2={y + hPad.t + innerH}
            stroke={C.orange} strokeWidth={1} strokeDasharray="3,2"
          />
        )}

        {/* Value axis labels — below the axis */}
        <text x={x + hPad.l} y={y + h - 2} textAnchor="start"
          fill={C.muted} fontSize={7.5} fontFamily={C.mono}>{fmtShort(histMin)}</text>
        <text x={x + hPad.l + innerW} y={y + h - 2} textAnchor="end"
          fill={C.muted} fontSize={7.5} fontFamily={C.mono}>{fmtShort(histMax)}</text>

        {/* Title + stats — above the bars */}
        <text x={x + w / 2} y={y + hPad.t - 3} textAnchor="middle"
          fill={C.text} fontSize={8.5} fontFamily={C.mono} fontWeight={500}>
          {`\u03BC=${fmt(mean)} ${unit}  n=${count >= 1000 ? (count / 1000).toFixed(1) + 'k' : count}`}
        </text>
      </g>
    );
  };

  // ROI outline dashes on top of the box
  const roiOutline = () => {
    const { sx0, sy0, roiW, roiH } = layout;
    return (
      <rect x={sx0} y={sy0} width={roiW} height={roiH}
        fill="none" stroke={C.cyanDim} strokeWidth={1}
        strokeDasharray="5,3" rx={1} />
    );
  };

  // Connector lines from ROI edge to chart edge
  const connectors = () => {
    const { sx0, sy0, sy1, roiW } = layout;
    const yp = layout.yProf;
    const xp = layout.xProf;
    return (
      <g stroke={C.border} strokeWidth={0.5} strokeDasharray="3,3" opacity={0.5}>
        {/* ROI left edge to Y-profile right edge (at chart top and bottom) */}
        <line x1={sx0} y1={yp.y} x2={yp.x + yp.w} y2={yp.y} />
        <line x1={sx0} y1={yp.y + yp.h} x2={yp.x + yp.w} y2={yp.y + yp.h} />
        {/* ROI bottom edge to X-profile top edge (at chart left and right) */}
        <line x1={xp.x} y1={sy1} x2={xp.x} y2={xp.y} />
        <line x1={xp.x + xp.w} y1={sy1} x2={xp.x + xp.w} y2={xp.y} />
      </g>
    );
  };

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 6 }}
    >
      {hasContent && (
        <svg
          width="100%" height="100%"
          style={{ position: 'absolute', inset: 0, overflow: 'visible' }}
        >
          {(show.v || show.h) && connectors()}
          {roiOutline()}
          {show.v && yProfLines()}
          {show.h && xProfLines()}
          {show.i && histPlot()}
        </svg>
      )}
    </div>
  );
}

export default ROIProfilePlot;
