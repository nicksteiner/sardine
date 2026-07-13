/**
 * ModelPanel — the Models section of the Analyze rail group (W025).
 *
 * Lists registered model plugins (heuristic / classical / ONNX / remote as
 * peers), runs them on the current ROI, and hosts the label→fit→preview
 * head-training loop. Presentational: orchestration lives in main.jsx.
 */
import React, { useRef, useEffect, useState } from 'react';

const BACKEND_CHIP = {
  'builtin-heuristic': { label: 'HEURISTIC', color: '#ffc832' },
  'builtin-classical': { label: 'ML', color: '#2ecc71' },
  onnx: { label: 'ONNX', color: '#4ec9d4' },
  remote: { label: 'REMOTE', color: '#b48ce0' },
};

const chipStyle = (color) => ({
  fontSize: '0.55rem', fontWeight: 600, letterSpacing: '0.5px',
  color, border: `1px solid ${color}44`, background: `${color}14`,
  borderRadius: 2, padding: '1px 5px', whiteSpace: 'nowrap',
});

const btnStyle = (enabled, color = 'var(--sardine-cyan, #4ec9d4)') => ({
  fontSize: '0.68rem', padding: '3px 9px', borderRadius: 2,
  background: 'transparent', cursor: enabled ? 'pointer' : 'not-allowed',
  color: enabled ? color : 'var(--sardine-text-disabled, #3a5070)',
  border: `1px solid ${enabled ? `${'#4ec9d4'}55` : 'var(--sardine-border, #1e3a5f)'}`,
  opacity: enabled ? 1 : 0.6,
});

function fmtPct(v) { return `${(v * 100).toFixed(0)}%`; }

/** Render a Float32 raster into a canvas, 2–98% dB-ish stretch. */
function RasterPreview({ data, width, height, label }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !data) return;
    const vals = [];
    for (let i = 0; i < data.length; i += Math.max(1, Math.floor(data.length / 5000))) {
      const v = data[i];
      if (Number.isFinite(v) && v > 0) vals.push(10 * Math.log10(v));
    }
    vals.sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * 0.02)] ?? -25;
    const hi = vals[Math.floor(vals.length * 0.98)] ?? 0;
    const span = hi - lo || 1;
    const canvas = ref.current;
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      const v = data[i];
      let g = 0;
      if (Number.isFinite(v) && v > 0) {
        g = Math.max(0, Math.min(255, ((10 * Math.log10(v) - lo) / span) * 255));
      }
      img.data[i * 4] = g; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = g;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [data, width, height]);
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <canvas ref={ref} style={{ width: '100%', imageRendering: 'pixelated', border: '1px solid var(--sardine-border)', borderRadius: 2 }} />
    </div>
  );
}

export default function ModelPanel({
  models,               // registry.list()
  hasData, hasRoi,
  busyId, progress,     // {phase, done, total} | null
  runInfo,              // {id, ep, weightsFrom, elapsedMs} | null
  onRun, onCancel,
  overlayActive, onClearOverlay,
  preview,              // {before, after, width, height} | null
  // head training
  canFit, fitHint,
  liveFit, onLiveFitChange,
  onFit, onApplyHead, onSaveHead,
  headManifest, headMetrics,
  onLoadManifestFile,
}) {
  const fileRef = useRef(null);
  const [showConfusion, setShowConfusion] = useState(false);

  return (
    <div style={{ fontSize: '0.72rem' }}>
      {!hasData && (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem', marginBottom: 6 }}>
          Load a scene, then Shift+drag an ROI to run models.
        </div>
      )}

      {/* Model list */}
      {models.map((m) => {
        const chip = BACKEND_CHIP[m['sardine:backend']] || BACKEND_CHIP.onnx;
        const busy = busyId === m.id;
        const runnable = hasData && hasRoi && !busyId;
        const acc = m.metrics?.accuracy;
        return (
          <div key={m.id} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px',
            border: '1px solid var(--sardine-border)', borderRadius: 3, marginBottom: 4,
            background: busy ? 'rgba(78,201,212,0.06)' : 'transparent',
          }}>
            <button
              title={hasRoi ? `Run on ROI (${m['mlm:tasks'].join(', ')})` : 'Shift+drag an ROI first'}
              disabled={!runnable}
              onClick={() => onRun(m)}
              style={{ ...btnStyle(runnable), padding: '2px 7px' }}
            >▷</button>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={`${m['mlm:architecture'] || ''}\n${m.provenance?.method || ''}`}>
              {m['mlm:name']}
            </span>
            {Number.isFinite(acc) && (
              <span style={{ fontSize: '0.6rem', color: '#2ecc71' }} title="held-out test accuracy">
                {fmtPct(acc)}
              </span>
            )}
            <span style={chipStyle(chip.color)}>{chip.label}</span>
          </div>
        );
      })}

      {/* Progress / result line */}
      {busyId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0' }}>
          <span style={{ color: 'var(--sardine-cyan)', fontSize: '0.62rem', flex: 1 }}>
            {progress?.phase === 'weights' ? 'downloading weights…'
              : progress?.phase === 'session' ? 'warming session…'
              : progress?.phase === 'tiles' ? `tile ${progress.done}/${progress.total}`
              : 'running…'}
          </span>
          <button onClick={onCancel} style={btnStyle(true, '#e74c3c')}>Cancel</button>
        </div>
      )}
      {!busyId && runInfo && (
        <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', margin: '2px 0 4px' }}>
          {runInfo.id} · {Math.round(runInfo.elapsedMs)} ms
          {runInfo.ep ? ` · ${runInfo.ep.toUpperCase()} EP` : ''}
          {runInfo.weightsFrom ? ` · weights: ${runInfo.weightsFrom}` : ''}
          {overlayActive && (
            <button onClick={onClearOverlay} style={{ ...btnStyle(true, 'var(--text-muted)'), marginLeft: 6, padding: '0 6px', fontSize: '0.58rem' }}>
              clear overlay
            </button>
          )}
        </div>
      )}

      {/* Enhancement preview (before / after) */}
      {preview && (
        <div style={{ display: 'flex', gap: 6, margin: '4px 0' }}>
          <RasterPreview data={preview.before} width={preview.width} height={preview.height} label="input (ROI)" />
          <RasterPreview data={preview.after} width={preview.width} height={preview.height} label="model output" />
        </div>
      )}

      {/* Load model manifest */}
      <div style={{ display: 'flex', gap: 4, margin: '6px 0' }}>
        <button onClick={() => fileRef.current?.click()} style={{ ...btnStyle(true, 'var(--sardine-text-secondary, #8fa4c4)'), flex: 1 }}>
          Load model…
        </button>
        <input
          ref={fileRef} type="file" accept=".json,.sardine-model.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onLoadManifestFile(f);
            e.target.value = '';
          }}
        />
      </div>

      {/* Train-a-head loop */}
      <div style={{ borderTop: '1px solid var(--sardine-border)', paddingTop: 6, marginTop: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: '0.62rem', letterSpacing: 1, color: 'var(--text-muted)', flex: 1 }}>TRAIN A HEAD</span>
          <label title="Refit + repaint on every label change (classical head only — milliseconds)"
            style={{ fontSize: '0.6rem', color: liveFit ? 'var(--sardine-cyan)' : 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={liveFit} disabled={!canFit}
              onChange={(e) => onLiveFitChange(e.target.checked)} style={{ marginRight: 3 }} />
            live
          </label>
        </div>
        {!canFit && (
          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginBottom: 4 }}>
            {fitHint}
          </div>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          <button disabled={!canFit} onClick={onFit} style={{ ...btnStyle(canFit), flex: 1 }}>Fit</button>
          <button disabled={!headManifest} onClick={onApplyHead} style={{ ...btnStyle(!!headManifest), flex: 1 }}>Apply</button>
          <button disabled={!headManifest} onClick={onSaveHead} style={{ ...btnStyle(!!headManifest), flex: 1 }}
            title="Download .sardine-model.json (STAC-MLM-aligned, loads back into any SARdine)">Save</button>
        </div>
        {headMetrics && (
          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: '0.62rem', color: '#2ecc71' }}>
              acc {fmtPct(headMetrics.accuracy)} · F1 {headMetrics.macroF1.toFixed(2)} · IoU {headMetrics.meanIoU.toFixed(2)}
              <span style={{ color: 'var(--text-muted)' }}> · test n={headMetrics.n}</span>
              <button onClick={() => setShowConfusion(s => !s)}
                style={{ ...btnStyle(true, 'var(--text-muted)'), marginLeft: 6, padding: '0 5px', fontSize: '0.55rem' }}>
                {showConfusion ? 'hide' : 'confusion'}
              </button>
            </div>
            {showConfusion && (
              <table style={{ fontSize: '0.58rem', marginTop: 3, borderCollapse: 'collapse', color: 'var(--text-secondary)' }}>
                <tbody>
                  {headMetrics.confusion.map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td key={j} style={{
                          padding: '1px 7px', textAlign: 'right',
                          border: '1px solid var(--sardine-border)',
                          background: i === j ? 'rgba(46,204,113,0.10)' : v > 0 ? 'rgba(231,76,60,0.10)' : 'transparent',
                        }}>{v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
