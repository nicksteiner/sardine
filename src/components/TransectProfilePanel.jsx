import { useRef, useState, useLayoutEffect } from 'react';

/**
 * TransectProfilePanel — plot of values sampled along the free transect line,
 * rendered in the sidebar drawer. Distance along the line on X, value on Y.
 *
 * Props:
 *   data          — { dist: Float32Array (px), values: Float32Array, lenPx, angleDeg }
 *                   or null while sampling / when no line
 *   enabled       — whether the transect tool is on
 *   useDecibels   — axis unit label
 *   width         — perpendicular half-width (px) averaged across the line
 *                   (0 = centerline only, 1 = ±1 → 3-px strip, …)
 *   onWidthChange — (halfWidth) => void
 */
const C = {
  bg: 'rgba(10, 22, 40, 0.6)', border: '#1e3a5f',
  cyan: '#4ec9d4', orange: '#e8833a', muted: '#5a7099',
  text: '#e8edf5', mono: "'JetBrains Mono', monospace",
};

// Perpendicular half-widths: 0 = centerline, 1 = ±1 (3-px strip), etc.
const WIDTH_OPTIONS = [0, 1, 2, 3];

function WidthControl({ width, onWidthChange }) {
  if (!onWidthChange) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: '0.68rem', fontFamily: C.mono, color: C.muted }}>
      <span title="Average pixels perpendicular to the line">⊥ avg</span>
      {WIDTH_OPTIONS.map(w => (
        <button
          key={w}
          onClick={() => onWidthChange(w)}
          title={w === 0 ? 'Centerline only' : `Average ${2 * w + 1} px across the line`}
          style={{
            padding: '2px 7px', borderRadius: 4, cursor: 'pointer',
            fontFamily: C.mono, fontSize: '0.68rem',
            background: width === w ? 'rgba(78,201,212,0.14)' : 'transparent',
            border: `1px solid ${width === w ? '#2a8a93' : C.border}`,
            color: width === w ? C.cyan : C.muted,
          }}
        >{w === 0 ? 'off' : `${2 * w + 1}px`}</button>
      ))}
    </div>
  );
}

export function TransectProfilePanel({ data, enabled, useDecibels = true, width = 1, onWidthChange, line = null }) {
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const [boxW, setBoxW] = useState(600);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const cw = entries[0]?.contentRect?.width;
      if (cw && cw > 0) setBoxW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!enabled) {
    return (
      <div ref={wrapRef} style={{ padding: '8px 4px', color: 'var(--text-muted)', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
        Transect tool off — enable it from the command palette (⌘K), then drag a line on the image.
      </div>
    );
  }
  if (!data || !data.values?.length) {
    return (
      <div ref={wrapRef} style={{ padding: '4px' }}>
        <WidthControl width={width} onWidthChange={onWidthChange} />
        <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
          Drag a line on the viewer. Drag its ends to reshape, the center ring to rotate, the body to move.
        </div>
      </div>
    );
  }

  const { dist, values, lenPx, angleDeg } = data;
  const unit = useDecibels ? 'dB' : 'power';

  // value range
  let vMin = Infinity, vMax = -Infinity, sum = 0, cnt = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
    sum += v; cnt++;
  }
  if (!Number.isFinite(vMin)) {
    return (
      <div ref={wrapRef} style={{ padding: '4px' }}>
        <WidthControl width={width} onWidthChange={onWidthChange} />
        <div style={{ color: C.muted, fontSize: '0.72rem', fontFamily: C.mono }}>No valid samples along the line.</div>
      </div>
    );
  }
  const mean = cnt ? sum / cnt : NaN;
  const vRange = (vMax - vMin) || 1;

  const dMax = dist?.length ? dist[dist.length - 1] : (values.length - 1);
  const dRange = dMax || 1;

  // Render at the measured drawer width (natural aspect — no text distortion).
  const W = Math.max(320, Math.round(boxW));
  const H = Math.max(180, Math.min(300, Math.round(W * 0.28)));
  const pad = { t: 26, r: 16, b: 30, l: 56 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const pts = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const d = dist ? dist[i] : i;
    const px = pad.l + (d / dRange) * innerW;
    const py = pad.t + (1 - (v - vMin) / vRange) * innerH;
    pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
  }

  const meanY = Number.isFinite(mean) ? pad.t + (1 - (mean - vMin) / vRange) * innerH : null;
  const fmt = (v) => Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) : '';

  // Horizontal gridlines at 25/50/75%
  const grid = [0.25, 0.5, 0.75].map(f => pad.t + f * innerH);

  // Serialize the plot SVG + embed the raw transect data, then download.
  const exportSVG = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    // Embed geometry + the sampled data as CSV inside a <metadata> block so
    // the .svg is self-describing and the numbers are recoverable.
    const rows = ['distance_px,value_' + (useDecibels ? 'dB' : 'power')];
    for (let i = 0; i < values.length; i++) {
      const d = dist ? dist[i] : i;
      rows.push(`${d.toFixed(3)},${Number.isFinite(values[i]) ? values[i].toFixed(6) : 'NaN'}`);
    }
    const meta = [
      line ? `line_image_px: (${Math.round(line.x0)},${Math.round(line.y0)}) -> (${Math.round(line.x1)},${Math.round(line.y1)})` : null,
      `length_px: ${Math.round(lenPx ?? dMax)}`,
      Number.isFinite(angleDeg) ? `angle_deg: ${angleDeg.toFixed(1)}` : null,
      `perp_avg_px: ${width > 0 ? 2 * width + 1 : 1}`,
      `unit: ${unit}`,
      `mean: ${fmt(mean)}`,
      `n_valid: ${cnt}`,
    ].filter(Boolean).join('\n');

    const metaEl = document.createElementNS('http://www.w3.org/2000/svg', 'metadata');
    metaEl.setAttribute('id', 'sardine-transect');
    metaEl.textContent = '\n' + meta + '\n\n' + rows.join('\n') + '\n';
    clone.insertBefore(metaEl, clone.firstChild);

    const src = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
    const blob = new Blob([src], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sardine-transect-${Math.round(lenPx ?? dMax)}px.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <div ref={wrapRef} style={{ padding: '2px 0' }}>
      <WidthControl width={width} onWidthChange={onWidthChange} />
      <svg
        ref={svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ display: 'block' }}
      >
        <rect x={1} y={1} width={W - 2} height={H - 2}
          fill={C.bg} stroke={C.border} strokeWidth={1.5} rx={3} />
        {/* gridlines */}
        {grid.map((gy, i) => (
          <line key={i} x1={pad.l} y1={gy} x2={pad.l + innerW} y2={gy}
            stroke={C.border} strokeWidth={0.75} opacity={0.4} />
        ))}
        <text x={W / 2} y={18} textAnchor="middle" fill={C.text} fontSize={16} fontFamily={C.mono}>
          {`transect (${unit})   μ=${fmt(mean)}   ${width > 0 ? `⊥ ${2 * width + 1}px` : `n=${cnt}`}`}
        </text>
        {/* axis */}
        <line x1={pad.l} y1={pad.t + innerH} x2={pad.l + innerW} y2={pad.t + innerH}
          stroke={C.border} strokeWidth={1.25} />
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + innerH}
          stroke={C.border} strokeWidth={1.25} />
        {/* mean line */}
        {meanY !== null && (
          <line x1={pad.l} y1={meanY} x2={pad.l + innerW} y2={meanY}
            stroke={C.orange} strokeWidth={1.25} strokeDasharray="6,4" opacity={0.8} />
        )}
        {/* profile */}
        {pts.length > 1 && (
          <polyline points={pts.join(' ')} fill="none"
            stroke={C.cyan} strokeWidth={2} strokeLinejoin="round" opacity={0.95}
            vectorEffect="non-scaling-stroke" />
        )}
        {/* value ticks (left) */}
        <text x={pad.l - 6} y={pad.t + 6} textAnchor="end" fill={C.muted} fontSize={13} fontFamily={C.mono}>{fmt(vMax)}</text>
        <text x={pad.l - 6} y={pad.t + innerH} textAnchor="end" fill={C.muted} fontSize={13} fontFamily={C.mono}>{fmt(vMin)}</text>
        {/* distance ticks (bottom) */}
        <text x={pad.l} y={H - 8} textAnchor="start" fill={C.muted} fontSize={13} fontFamily={C.mono}>0</text>
        <text x={pad.l + innerW} y={H - 8} textAnchor="end" fill={C.muted} fontSize={13} fontFamily={C.mono}>{Math.round(dMax)} px</text>
      </svg>
      <div style={{ marginTop: 4, color: C.muted, fontSize: '0.72rem', fontFamily: C.mono, display: 'flex', gap: 16, alignItems: 'center' }}>
        <span>len {Math.round(lenPx ?? dMax)} px</span>
        <span>{Number.isFinite(angleDeg) ? `${angleDeg.toFixed(0)}°` : ''}</span>
        <span>n {cnt}</span>
        <button
          onClick={exportSVG}
          title="Download the plot + data as SVG"
          style={{
            marginLeft: 'auto', padding: '2px 10px', cursor: 'pointer',
            fontFamily: C.mono, fontSize: '0.72rem',
            background: 'transparent', color: C.cyan,
            border: `1px solid ${C.border}`, borderRadius: 4,
          }}
        >⬇ SVG</button>
      </div>
    </div>
  );
}

export default TransectProfilePanel;
