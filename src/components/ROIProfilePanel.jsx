/**
 * ROIProfilePanel — SAR profile plots rendered in the sidebar drawer.
 *
 * Unlike ROIProfilePlot (which overlays charts on the viewer, positioned
 * relative to the ROI box), this renders fixed-size charts stacked vertically
 * inside a control-panel section. It consumes the same precomputed profileData
 * produced in main.jsx.
 *
 * Props:
 *   profileData — {rowMeans, colMeans, hist, histMin, histMax, mean, count,
 *                  useDecibels}
 *   show        — {v, h, i} which charts to render
 *   useDecibels — fallback for axis unit label
 */
export function ROIProfilePanel({ profileData, show = { v: true, h: true, i: true }, useDecibels = true }) {
  if (!profileData) {
    return (
      <div style={{ padding: '8px 4px', color: 'var(--text-muted)', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
        Shift+drag on the viewer to select a region.
      </div>
    );
  }

  const { rowMeans, colMeans, hist, histMin, histMax, mean, count, useDecibels: pdDb } = profileData;
  const db = pdDb ?? useDecibels;
  const unit = db ? 'dB' : 'power';

  const C = {
    bg:      'rgba(10, 22, 40, 0.6)',
    border:  '#1e3a5f',
    cyan:    '#4ec9d4',
    cyanDim: 'rgba(78,201,212,0.35)',
    orange:  '#e8833a',
    muted:   '#5a7099',
    text:    '#e8edf5',
    mono:    "'JetBrains Mono', monospace",
  };

  // Value range shared by X/Y profiles
  const allMeans = [...(rowMeans || []), ...(colMeans || [])].filter(v => !isNaN(v));
  const vMin = allMeans.length ? Math.min(...allMeans) : (histMin ?? 0);
  const vMax = allMeans.length ? Math.max(...allMeans) : (histMax ?? 1);
  const vRange = vMax - vMin || 1;

  const fmt = (v) => isNaN(v) ? '' : v.toFixed(1);
  const fmtShort = (v) => {
    if (isNaN(v)) return '';
    if (Math.abs(v) >= 100) return v.toFixed(0);
    return v.toFixed(1);
  };

  // Fixed chart geometry — panel is ~fixed width
  const W = 240;
  const H = 90;
  const pad = { t: 6, r: 6, b: 16, l: 34 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const chartFrame = (titleText) => (
    <>
      <rect x={0.5} y={0.5} width={W - 1} height={H - 1}
        fill={C.bg} stroke={C.border} strokeWidth={0.75} rx={2} />
      <text x={W / 2} y={11} textAnchor="middle"
        fill={C.muted} fontSize={9} fontFamily={C.mono}>{titleText}</text>
    </>
  );

  // Line profile: value on the "amplitude" axis, sample index on the other.
  // orient='v' → index runs top→bottom (Y profile), value runs left→right.
  // orient='h' → index runs left→right (X profile), value runs bottom→top.
  const lineChart = (means, orient, title) => {
    if (!means?.length) return null;
    const n = means.length;
    const pts = Array.from(means).map((v, i) => {
      if (isNaN(v)) return null;
      const t = i / Math.max(n - 1, 1);          // 0..1 along index axis
      const a = (v - vMin) / vRange;             // 0..1 along value axis
      let px, py;
      if (orient === 'v') {
        px = pad.l + a * innerW;
        py = pad.t + t * innerH;
      } else {
        px = pad.l + t * innerW;
        py = pad.t + (1 - a) * innerH;
      }
      return `${px},${py}`;
    }).filter(Boolean);

    const meanPos = !isNaN(mean) ? (mean - vMin) / vRange : null;

    return (
      <svg width={W} height={H} style={{ display: 'block', marginTop: 6 }}>
        {chartFrame(`${title} (${unit})`)}
        {/* mean marker */}
        {meanPos !== null && orient === 'v' && (
          <line x1={pad.l + meanPos * innerW} y1={pad.t} x2={pad.l + meanPos * innerW} y2={pad.t + innerH}
            stroke={C.orange} strokeWidth={0.75} strokeDasharray="3,2" opacity={0.7} />
        )}
        {meanPos !== null && orient === 'h' && (
          <line x1={pad.l} y1={pad.t + (1 - meanPos) * innerH} x2={pad.l + innerW} y2={pad.t + (1 - meanPos) * innerH}
            stroke={C.orange} strokeWidth={0.75} strokeDasharray="3,2" opacity={0.7} />
        )}
        {pts.length > 1 && (
          <polyline points={pts.join(' ')} fill="none"
            stroke={C.cyan} strokeWidth={1.25} strokeLinejoin="round" opacity={0.9} />
        )}
        {/* value axis ticks */}
        <text x={2} y={pad.t + 4} textAnchor="start"
          fill={C.muted} fontSize={7.5} fontFamily={C.mono}>{orient === 'h' ? fmtShort(vMax) : ''}</text>
        <text x={pad.l} y={H - 3} textAnchor="start"
          fill={C.muted} fontSize={7.5} fontFamily={C.mono}>{fmtShort(vMin)}</text>
        <text x={pad.l + innerW} y={H - 3} textAnchor="end"
          fill={C.muted} fontSize={7.5} fontFamily={C.mono}>{orient === 'v' ? fmtShort(vMax) : ''}</text>
      </svg>
    );
  };

  const histChart = () => {
    if (!hist?.length) return null;
    const n = hist.length;
    const maxCount = Math.max(...hist, 1);
    const binW = innerW / n;
    const meanBin = (!isNaN(mean) && !isNaN(histMin) && !isNaN(histMax))
      ? ((mean - histMin) / (histMax - histMin || 1)) * innerW
      : null;

    return (
      <svg width={W} height={H} style={{ display: 'block', marginTop: 6 }}>
        {chartFrame(`μ=${fmt(mean)} ${unit}  n=${count >= 1000 ? (count / 1000).toFixed(1) + 'k' : count}`)}
        {Array.from(hist).map((cnt, i) => {
          const bh = (cnt / maxCount) * innerH;
          return (
            <rect key={i}
              x={pad.l + i * binW} y={pad.t + innerH - bh}
              width={Math.max(1, binW - 0.5)} height={bh}
              fill={C.cyanDim} />
          );
        })}
        <line x1={pad.l} y1={pad.t + innerH} x2={pad.l + innerW} y2={pad.t + innerH}
          stroke={C.border} strokeWidth={0.75} />
        {meanBin !== null && (
          <line x1={pad.l + meanBin} y1={pad.t} x2={pad.l + meanBin} y2={pad.t + innerH}
            stroke={C.orange} strokeWidth={1} strokeDasharray="3,2" />
        )}
        <text x={pad.l} y={H - 3} textAnchor="start"
          fill={C.muted} fontSize={7.5} fontFamily={C.mono}>{fmtShort(histMin)}</text>
        <text x={pad.l + innerW} y={H - 3} textAnchor="end"
          fill={C.muted} fontSize={7.5} fontFamily={C.mono}>{fmtShort(histMax)}</text>
      </svg>
    );
  };

  const nothing = !show.v && !show.h && !show.i;

  return (
    <div style={{ padding: '2px 0' }}>
      {nothing && (
        <div style={{ padding: '4px', color: C.muted, fontSize: '0.72rem', fontFamily: C.mono }}>
          All profiles hidden — toggle from the command palette (⌘K).
        </div>
      )}
      {show.v && lineChart(rowMeans, 'v', 'Y profile')}
      {show.h && lineChart(colMeans, 'h', 'X profile')}
      {show.i && histChart()}
    </div>
  );
}

export default ROIProfilePanel;
