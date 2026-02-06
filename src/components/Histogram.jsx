import React, { useRef, useEffect, useState } from 'react';

/**
 * HistogramPanel - Per-channel histogram display with contrast controls.
 *
 * For RGB mode: shows R, G, B histograms with independent min/max sliders.
 * For single-band mode: shows one histogram with min/max sliders.
 */
export function HistogramPanel({
  histograms,      // {single: stats} or {R: stats, G: stats, B: stats}
  mode,            // 'single' | 'rgb'
  contrastLimits,  // [min, max] for single, {R:[min,max], G:[min,max], B:[min,max]} for rgb
  useDecibels,
  onContrastChange,
  onAutoStretch,
}) {
  if (!histograms) return null;

  const channels = mode === 'rgb' ? ['R', 'G', 'B'] : ['single'];
  const colors = {
    R: 'rgba(255, 92, 92, 0.7)',
    G: 'rgba(61, 220, 132, 0.7)',
    B: 'rgba(78, 168, 255, 0.7)',
    single: 'rgba(78, 201, 212, 0.6)',
  };

  return (
    <div className="control-section">
      <h3>Histogram</h3>
      <button onClick={onAutoStretch} style={{ width: '100%', marginBottom: '8px' }}>
        Auto Stretch (2–98%)
      </button>
      {channels.map(ch => {
        const stats = histograms[ch];
        if (!stats) return null;

        const limits = mode === 'rgb'
          ? (contrastLimits[ch] || [stats.p2, stats.p98])
          : (contrastLimits || [stats.p2, stats.p98]);

        const handleChange = (newLimits) => {
          if (mode === 'rgb') {
            onContrastChange({ ...contrastLimits, [ch]: newLimits });
          } else {
            onContrastChange(newLimits);
          }
        };

        return (
          <ChannelHistogram
            key={ch}
            stats={stats}
            color={colors[ch]}
            label={mode === 'rgb' ? ch : null}
            limits={limits}
            useDecibels={useDecibels}
            onChange={handleChange}
          />
        );
      })}
    </div>
  );
}

/**
 * Single-channel histogram canvas with min/max range sliders.
 */
function ChannelHistogram({ stats, color, label, limits, useDecibels, onChange }) {
  const canvasRef = useRef(null);
  const [editingMin, setEditingMin] = useState(false);
  const [editingMax, setEditingMax] = useState(false);
  const [editMinVal, setEditMinVal] = useState('');
  const [editMaxVal, setEditMaxVal] = useState('');
  const WIDTH = 200;
  const HEIGHT = 50;

  useEffect(() => {
    if (!canvasRef.current || !stats) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // Draw bars with log-scale heights for better tail visibility
    const maxCount = Math.max(...stats.bins);
    if (maxCount === 0) return;

    const logMax = Math.log10(maxCount + 1);
    const barW = WIDTH / stats.bins.length;
    const dataRange = stats.max - stats.min || 1;

    ctx.fillStyle = color;
    for (let i = 0; i < stats.bins.length; i++) {
      if (stats.bins[i] === 0) continue;
      const h = (Math.log10(stats.bins[i] + 1) / logMax) * HEIGHT;
      ctx.fillRect(i * barW, HEIGHT - h, Math.max(barW, 1), h);
    }

    // Shade clipped regions and draw limit lines
    if (limits) {
      const [lo, hi] = limits;
      const loX = ((lo - stats.min) / dataRange) * WIDTH;
      const hiX = ((hi - stats.min) / dataRange) * WIDTH;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      if (loX > 0) ctx.fillRect(0, 0, loX, HEIGHT);
      if (hiX < WIDTH) ctx.fillRect(hiX, 0, WIDTH - hiX, HEIGHT);

      ctx.strokeStyle = '#e8833a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(loX, 0); ctx.lineTo(loX, HEIGHT);
      ctx.moveTo(hiX, 0); ctx.lineTo(hiX, HEIGHT);
      ctx.stroke();
    }
  }, [stats, limits, color]);

  if (!stats) return null;

  const [lo, hi] = limits;
  const step = (stats.max - stats.min) / 200 || 0.001;

  const fmt = (v) => {
    if (useDecibels) return v.toFixed(1) + ' dB';
    if (Math.abs(v) < 0.01 || Math.abs(v) >= 10000) return v.toExponential(2);
    return v.toFixed(4);
  };

  const fmtShort = (v) => {
    if (useDecibels) return v.toFixed(1);
    if (Math.abs(v) < 0.01 || Math.abs(v) >= 10000) return v.toExponential(1);
    return v.toFixed(3);
  };

  const numLabelStyle = {
    fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
    fontSize: '0.6rem',
    color: 'var(--sardine-cyan, #4ec9d4)',
    cursor: 'pointer',
    minWidth: '42px',
    textAlign: 'center',
    padding: '1px 2px',
    borderRadius: 'var(--radius-sm, 3px)',
    border: '1px solid transparent',
    transition: 'border-color var(--transition-fast, 150ms ease)',
  };

  const numInputStyle = {
    fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
    fontSize: '0.6rem',
    color: 'var(--text-primary, #e8edf5)',
    background: 'var(--sardine-bg, #0a1628)',
    border: '1px solid var(--sardine-cyan, #4ec9d4)',
    borderRadius: 'var(--radius-sm, 3px)',
    padding: '1px 3px',
    width: '48px',
    textAlign: 'center',
    outline: 'none',
  };

  return (
    <div style={{ marginBottom: '8px' }}>
      {label && (
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2px' }}>
          <div style={{
            width: 10, height: 10, borderRadius: 2, marginRight: 4,
            backgroundColor: color,
          }} />
          <span style={{ fontSize: '0.7rem', fontWeight: '600', color: 'var(--text-primary, #e8edf5)' }}>{label}</span>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-muted, #5a7099)', marginLeft: 'auto' }}>
            {fmt(lo)} – {fmt(hi)}
          </span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        style={{
          width: `${WIDTH}px`,
          height: `${HEIGHT}px`,
          display: 'block',
          borderRadius: 'var(--radius-sm, 4px)',
          border: '1px solid var(--sardine-border, #1e3a5f)',
        }}
      />
      <div style={{ marginTop: '3px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {editingMin ? (
            <input
              type="text"
              autoFocus
              value={editMinVal}
              onChange={(e) => setEditMinVal(e.target.value)}
              onBlur={() => {
                const v = parseFloat(editMinVal);
                if (!isNaN(v)) onChange([Math.max(stats.min, Math.min(v, hi)), hi]);
                setEditingMin(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.target.blur();
                if (e.key === 'Escape') setEditingMin(false);
              }}
              style={numInputStyle}
            />
          ) : (
            <span
              onClick={() => { setEditMinVal(fmtShort(lo)); setEditingMin(true); }}
              style={numLabelStyle}
              title="Click to edit"
            >{fmtShort(lo)}</span>
          )}
          <input
            type="range"
            min={stats.min}
            max={stats.max}
            step={step}
            value={lo}
            onChange={(e) => onChange([Number(e.target.value), hi])}
            style={{ flex: 1 }}
          />
          {editingMax ? (
            <input
              type="text"
              autoFocus
              value={editMaxVal}
              onChange={(e) => setEditMaxVal(e.target.value)}
              onBlur={() => {
                const v = parseFloat(editMaxVal);
                if (!isNaN(v)) onChange([lo, Math.min(stats.max, Math.max(v, lo))]);
                setEditingMax(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.target.blur();
                if (e.key === 'Escape') setEditingMax(false);
              }}
              style={numInputStyle}
            />
          ) : (
            <span
              onClick={() => { setEditMaxVal(fmtShort(hi)); setEditingMax(true); }}
              style={numLabelStyle}
              title="Click to edit"
            >{fmtShort(hi)}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default HistogramPanel;
