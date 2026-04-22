/**
 * InundationApp — guided ATBD app for NISAR inundation classification.
 *
 * Stripped-down UI for applications users. Explorer-style controls
 * (histogram, contrast, colormap, stretch, composite pickers) are
 * intentionally absent per S292 scope.
 *
 * Flow:
 *   1. Location     — paste lon,lat (map click = D296 follow-up).
 *   2. Auto-stack   — CMR → group → rank → pick stack.
 *   3. ROI          — optional; default = stack bbox.
 *   4. Run          — runATBD({ algorithm: 'inundation' }).
 *   5. View/Export  — classification overlay + GeoTIFF / PNG.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { selectATBDStack, ALGORITHM_POL_REQUIREMENTS } from '@src/utils/atbd-auto-stack.js';
import { loadNISARTimeSeriesFromUrls } from '@src/loaders/nisar-loader.js';
import { runATBD } from '@src/utils/atbd-runner.js';
import { classifiedToRGBA } from '@src/utils/atbd-palettes.js';
import { writeRGBAGeoTIFF, downloadBuffer } from '@src/utils/geotiff-writer.js';
import { readSearchQuery, writeSearchQuery } from '../shared/urlState.js';

const DEFAULT_MAX_FRAMES = 6;

const stepColor = (active, done) =>
  done ? 'var(--sardine-cyan, #4ec9d4)'
       : active ? 'var(--sardine-amber, #f5a623)'
                : 'var(--sardine-muted, #9aa5b8)';

function Step({ num, title, active, done, children }) {
  return (
    <section
      data-testid={`inundation-step-${num}`}
      style={{
        border: `1px solid ${active ? 'var(--sardine-amber, #f5a623)' : 'var(--sardine-border, #2a3140)'}`,
        borderRadius: '6px',
        padding: '1rem 1.25rem',
        marginBottom: '0.8rem',
        background: 'var(--sardine-panel, #151a24)',
        opacity: done || active ? 1 : 0.6,
      }}
    >
      <h3 style={{ margin: '0 0 0.6rem', fontSize: '0.95rem', color: stepColor(active, done) }}>
        {done ? '✓' : active ? '▸' : '·'} Step {num}: {title}
      </h3>
      {children}
    </section>
  );
}

// Ensure ROI bounds and stack bounds overlap + produce a valid intersection.
// Returns null if no overlap.
function intersectBounds(a, b) {
  if (!a || !b) return null;
  const [aw, as, ae, an] = a;
  const [bw, bs, be, bn] = b;
  const w = Math.max(aw, bw);
  const s = Math.max(as, bs);
  const e = Math.min(ae, be);
  const n = Math.min(an, bn);
  if (w >= e || s >= n) return null;
  return [w, s, e, n];
}

export default function InundationApp() {
  // Hydrate from search-query on mount. See `app/shared/urlState.js` — with
  // hash routing, per-page state travels in `location.search`, not the hash.
  const initial = readSearchQuery();
  const [lon, setLon] = useState(initial.lon ? String(initial.lon) : '');
  const [lat, setLat] = useState(initial.lat ? String(initial.lat) : '');
  const [maxFrames, setMaxFrames] = useState(
    Number.isFinite(Number(initial.n)) && Number(initial.n) > 0
      ? Number(initial.n)
      : DEFAULT_MAX_FRAMES
  );
  const [startDate, setStartDate] = useState(initial.start || '');
  const [endDate, setEndDate] = useState(initial.end || '');
  const [edlToken, setEdlToken] = useState(() => {
    try { return localStorage.getItem('sardine_edl_token') || ''; } catch { return ''; }
  });
  const [roiText, setRoiText] = useState(initial.roi || '');

  const [stackState, setStackState] = useState({ status: 'idle', winner: null, alternatives: [], error: null });
  const [framesState, setFramesState] = useState({ status: 'idle', frames: [], errors: [], progress: 0, error: null });
  const [resultState, setResultState] = useState({ status: 'idle', result: null, error: null });

  // Persist state to URL whenever core params change.
  useEffect(() => {
    writeSearchQuery({
      lon: lon || null,
      lat: lat || null,
      n: Number(maxFrames) === DEFAULT_MAX_FRAMES ? null : maxFrames,
      start: startDate || null,
      end: endDate || null,
      roi: roiText || null,
    });
  }, [lon, lat, maxFrames, startDate, endDate, roiText]);

  // Persist EDL token locally — same pattern as the explorer's NISARSearch.
  useEffect(() => {
    try {
      if (edlToken) localStorage.setItem('sardine_edl_token', edlToken);
      else localStorage.removeItem('sardine_edl_token');
    } catch { /* localStorage can throw in private mode */ }
  }, [edlToken]);

  // Derived: is the point valid?
  // Empty strings coerce to 0 via `Number('')`, so we require non-empty text
  // first — otherwise an unedited form would look valid at (0, 0).
  const pointValid = useMemo(() => {
    if (lon === '' || lat === '') return false;
    const lo = Number(lon);
    const la = Number(lat);
    return Number.isFinite(lo) && Number.isFinite(la)
      && lo >= -180 && lo <= 180 && la >= -90 && la <= 90;
  }, [lon, lat]);

  // Step 2 — auto-stack.
  const handleAutoStack = useCallback(async () => {
    if (!pointValid) return;
    setStackState({ status: 'loading', winner: null, alternatives: [], error: null });
    setFramesState({ status: 'idle', frames: [], errors: [], progress: 0, error: null });
    setResultState({ status: 'idle', result: null, error: null });
    try {
      const { winner, alternatives } = await selectATBDStack({
        lon: Number(lon),
        lat: Number(lat),
        algorithm: 'inundation',
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        maxFrames: Number(maxFrames) || DEFAULT_MAX_FRAMES,
      });
      if (!winner) {
        setStackState({
          status: 'error',
          winner: null,
          alternatives,
          error: 'No viable dual-pol (HH+HV) stack found at this location. Try another point or widen the date range.',
        });
        return;
      }
      setStackState({ status: 'done', winner, alternatives, error: null });
    } catch (e) {
      setStackState({ status: 'error', winner: null, alternatives: [], error: e.message || String(e) });
    }
  }, [lon, lat, startDate, endDate, maxFrames, pointValid]);

  // Step 4 — stream frames + run ATBD.
  const handleRun = useCallback(async () => {
    if (stackState.status !== 'done' || !stackState.winner) return;
    const { winner } = stackState;
    const urls = winner.granules.map((g) => g.dataUrl).filter(Boolean);
    if (urls.length < 2) {
      setFramesState({ status: 'error', frames: [], errors: [], progress: 0, error: 'Selected stack has no downloadable URLs' });
      return;
    }
    setFramesState({ status: 'loading', frames: [], errors: [], progress: 0, error: null });
    setResultState({ status: 'idle', result: null, error: null });

    try {
      const fetchHeaders = edlToken ? { Authorization: `Bearer ${edlToken}` } : undefined;
      const { frames, errors } = await loadNISARTimeSeriesFromUrls(urls, {
        compositeId: 'dual-pol-h',
        fetchHeaders,
        onProgress: (i, total) => {
          setFramesState((s) => ({ ...s, progress: i / total }));
        },
      });
      if (frames.length < 2) {
        setFramesState({
          status: 'error', frames, errors, progress: 1,
          error: `Loaded ${frames.length}/${urls.length} frames; Inundation needs >=2. Errors: ${errors.map(e => e.error).join('; ') || 'none'}`,
        });
        return;
      }
      setFramesState({ status: 'done', frames, errors, progress: 1, error: null });

      // Compute ROI bounds: explicit ROI (x0,y0,x1,y1) intersected with stack bbox,
      // else the stack bbox itself.
      let bounds = winner.bbox;
      if (roiText) {
        const nums = roiText.split(',').map((v) => Number(v.trim()));
        if (nums.length === 4 && nums.every(Number.isFinite)) {
          const intersection = intersectBounds([nums[0], nums[1], nums[2], nums[3]], winner.bbox);
          if (intersection) bounds = intersection;
        }
      }
      if (!bounds) throw new Error('No valid bounds for classification');

      setResultState({ status: 'loading', result: null, error: null });
      const result = await runATBD(frames, bounds, { algorithm: 'inundation' });
      setResultState({ status: 'done', result, error: null });
    } catch (e) {
      // If frames loaded but runATBD failed, still show the frame state.
      setResultState({ status: 'error', result: null, error: e.message || String(e) });
    }
  }, [stackState, edlToken, roiText]);

  // Step 5 — exports.
  const handleExportGeoTIFF = useCallback(() => {
    if (resultState.status !== 'done' || !resultState.result) return;
    const { result } = resultState;
    const rgba = classifiedToRGBA(result.classMap, result.width, result.height, result.palette);
    // crs fallback: frames carry CRS; if absent, EPSG:4326 is the documented default.
    const crs = framesState.frames[0]?.crs || 'EPSG:4326';
    const buf = writeRGBAGeoTIFF(rgba, result.width, result.height, result.bounds, crs);
    const when = new Date().toISOString().slice(0, 10);
    downloadBuffer(buf, `inundation_${when}.tif`);
  }, [resultState, framesState]);

  // ─── Render ──────────────────────────────────────────────────────────────
  const step1Done = pointValid;
  const step2Done = stackState.status === 'done';
  const step3Done = step2Done;  // ROI is optional; step is "done" as soon as a stack exists.
  const step4Done = resultState.status === 'done';

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--sardine-bg, #0f1419)',
        color: 'var(--sardine-ink, #e0e0e0)',
        fontFamily: 'system-ui, sans-serif',
        padding: '1.5rem 2rem',
      }}
    >
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <header style={{ marginBottom: '1.25rem', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ fontSize: '1.6rem', margin: 0, color: 'var(--sardine-cyan, #4ec9d4)' }}>
              Inundation ATBD
            </h1>
            <p style={{ margin: '0.3rem 0 0', color: 'var(--sardine-muted, #9aa5b8)', fontSize: '0.9rem' }}>
              Pick a location → auto-select a NISAR GCOV stack → classify open-water / flooded-vegetation / flooded-bare.
            </p>
          </div>
          <Link href="/">
            <a style={{ color: 'var(--sardine-muted, #9aa5b8)', fontSize: '0.85rem', textDecoration: 'none' }}>← All workflows</a>
          </Link>
        </header>

        <EDLBanner token={edlToken} onChange={setEdlToken} />

        <Step num={1} title="Location" active={!step1Done} done={step1Done}>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.88rem' }}>
            <label>
              Lon<br />
              <input
                data-testid="inundation-lon"
                type="number" step="any" value={lon}
                onChange={(e) => setLon(e.target.value)}
                placeholder="-73.8"
                style={inputStyle}
              />
            </label>
            <label>
              Lat<br />
              <input
                data-testid="inundation-lat"
                type="number" step="any" value={lat}
                onChange={(e) => setLat(e.target.value)}
                placeholder="-8.4"
                style={inputStyle}
              />
            </label>
            <label>
              Max frames<br />
              <input
                type="number" min="2" max="20" value={maxFrames}
                onChange={(e) => setMaxFrames(Math.max(2, Math.min(20, Number(e.target.value) || DEFAULT_MAX_FRAMES)))}
                style={{ ...inputStyle, width: '5rem' }}
              />
            </label>
            <label>
              Start date<br />
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
            </label>
            <label>
              End date<br />
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
            </label>
          </div>
          <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--sardine-muted, #9aa5b8)' }}>
            Required pols: {ALGORITHM_POL_REQUIREMENTS.inundation.join(' + ')}. Map-click selection is a follow-up (D296).
          </p>
        </Step>

        <Step num={2} title="Auto-stack (ASF CMR)" active={step1Done && !step2Done} done={step2Done}>
          <button
            data-testid="inundation-autostack"
            onClick={handleAutoStack}
            disabled={!pointValid || stackState.status === 'loading'}
            style={buttonStyle(pointValid && stackState.status !== 'loading')}
          >
            {stackState.status === 'loading' ? 'Searching ASF…' : 'Find best stack'}
          </button>

          {stackState.error && (
            <p data-testid="inundation-autostack-error" style={errorStyle}>{stackState.error}</p>
          )}
          {stackState.winner && (
            <div data-testid="inundation-autostack-result" style={{ marginTop: '0.6rem', fontSize: '0.85rem' }}>
              <div>
                <strong>Selected:</strong> {stackState.winner.numFrames} frames,{' '}
                {stackState.winner.startDate?.slice(0, 10)} → {stackState.winner.endDate?.slice(0, 10)},{' '}
                orbit {stackState.winner.direction}/{stackState.winner.track}/F{stackState.winner.frame}
              </div>
              {stackState.alternatives.length > 0 && (
                <details style={{ marginTop: '0.4rem', color: 'var(--sardine-muted, #9aa5b8)' }}>
                  <summary>{stackState.alternatives.length} other stack(s) rejected</summary>
                  <ul style={{ margin: '0.3rem 0 0 1rem', padding: 0 }}>
                    {stackState.alternatives.slice(0, 5).map((a) => (
                      <li key={a.key}>
                        {a.numFrames} frames · {a.direction}/{a.track}/F{a.frame} · {a.startDate?.slice(0, 10)} → {a.endDate?.slice(0, 10)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </Step>

        <Step num={3} title="ROI (optional)" active={step2Done && !step3Done} done={step3Done}>
          <label style={{ fontSize: '0.85rem' }}>
            Bbox (west,south,east,north) — leave empty to use the full stack footprint.<br />
            <input
              type="text" value={roiText}
              onChange={(e) => setRoiText(e.target.value)}
              placeholder="-74.0,-8.6,-73.6,-8.2"
              style={{ ...inputStyle, width: '22rem' }}
            />
          </label>
        </Step>

        <Step num={4} title="Run classification" active={step3Done && !step4Done} done={step4Done}>
          <button
            data-testid="inundation-run"
            onClick={handleRun}
            disabled={!step2Done || framesState.status === 'loading' || resultState.status === 'loading'}
            style={buttonStyle(step2Done && framesState.status !== 'loading' && resultState.status !== 'loading')}
          >
            {framesState.status === 'loading' ? `Streaming frames… ${Math.round(framesState.progress * 100)}%`
              : resultState.status === 'loading' ? 'Classifying…'
              : 'Run ATBD'}
          </button>
          {framesState.errors.length > 0 && (
            <p style={{ ...errorStyle, background: 'transparent' }}>
              Skipped {framesState.errors.length} frame(s): {framesState.errors[0].error}
            </p>
          )}
          {framesState.error && <p style={errorStyle}>{framesState.error}</p>}
          {resultState.error && <p data-testid="inundation-run-error" style={errorStyle}>{resultState.error}</p>}
        </Step>

        <Step num={5} title="View + Export" active={step4Done} done={step4Done}>
          {resultState.status !== 'done' && (
            <p style={{ fontSize: '0.85rem', color: 'var(--sardine-muted, #9aa5b8)' }}>Classification will appear here.</p>
          )}
          {resultState.status === 'done' && resultState.result && (
            <ResultPanel result={resultState.result} onExportGeoTIFF={handleExportGeoTIFF} />
          )}
        </Step>
      </div>
    </div>
  );
}

function EDLBanner({ token, onChange }) {
  const [expanded, setExpanded] = useState(!token);
  if (token && !expanded) {
    return (
      <div data-testid="edl-banner" style={bannerStyle}>
        <span>Earthdata token set. </span>
        <button style={linkButtonStyle} onClick={() => setExpanded(true)}>Edit</button>
      </div>
    );
  }
  return (
    <div data-testid="edl-banner" style={bannerStyle}>
      <div style={{ marginBottom: '0.4rem' }}>
        Earthdata Login bearer token (needed to stream from ASF). Get one at{' '}
        <a href="https://urs.earthdata.nasa.gov" target="_blank" rel="noreferrer" style={{ color: 'var(--sardine-cyan, #4ec9d4)' }}>urs.earthdata.nasa.gov</a>.
      </div>
      <input
        data-testid="edl-token"
        type="password"
        value={token}
        onChange={(e) => onChange(e.target.value)}
        placeholder="eyJ…"
        style={{ ...inputStyle, width: '100%', maxWidth: '32rem' }}
      />
      {token && (
        <button style={linkButtonStyle} onClick={() => setExpanded(false)}>Done</button>
      )}
    </div>
  );
}

function ResultPanel({ result, onExportGeoTIFF }) {
  // Render classMap → RGBA → <canvas>. Tiny helper; no deck.gl needed for
  // the ATBD result — the classification is a fixed raster + fixed bounds.
  const canvasRef = React.useRef(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = result.width;
    canvas.height = result.height;
    const ctx = canvas.getContext('2d');
    const rgba = classifiedToRGBA(result.classMap, result.width, result.height, result.palette);
    const img = new ImageData(new Uint8ClampedArray(rgba.buffer), result.width, result.height);
    ctx.putImageData(img, 0, 0);
  }, [result]);

  return (
    <div data-testid="inundation-result">
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
        <button
          data-testid="inundation-export-geotiff"
          onClick={onExportGeoTIFF}
          style={buttonStyle(true)}
        >
          Export GeoTIFF
        </button>
      </div>
      <canvas
        data-testid="inundation-canvas"
        ref={canvasRef}
        style={{
          imageRendering: 'pixelated',
          maxWidth: '100%',
          height: 'auto',
          border: '1px solid var(--sardine-border, #2a3140)',
          background: 'var(--sardine-bg, #0f1419)',
        }}
      />
      <Legend palette={result.palette} labels={result.classLabels} />
      <details style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--sardine-muted, #9aa5b8)' }}>
        <summary>Details</summary>
        <pre style={{ fontSize: '0.75rem', margin: '0.4rem 0' }}>{JSON.stringify(result.metadata, null, 2)}</pre>
        <div>Bounds: {result.bounds.join(', ')}</div>
        <div>Size: {result.width} × {result.height}</div>
      </details>
    </div>
  );
}

function Legend({ palette, labels }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.4rem', fontSize: '0.8rem' }}>
      {labels.map((lab, i) => {
        const c = palette[i] || [0, 0, 0, 0];
        return (
          <div key={lab} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <span style={{
              display: 'inline-block', width: '14px', height: '14px',
              background: `rgba(${c[0]},${c[1]},${c[2]},${(c[3] || 0) / 255})`,
              border: '1px solid var(--sardine-border, #2a3140)',
            }} />
            {lab}
          </div>
        );
      })}
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────

const inputStyle = {
  background: 'var(--sardine-bg, #0f1419)',
  color: 'var(--sardine-ink, #e0e0e0)',
  border: '1px solid var(--sardine-border, #2a3140)',
  borderRadius: '3px',
  padding: '0.35rem 0.5rem',
  fontFamily: 'monospace',
  fontSize: '0.85rem',
};

const buttonStyle = (enabled) => ({
  padding: '0.45rem 0.9rem',
  background: enabled ? 'var(--sardine-cyan, #4ec9d4)' : 'var(--sardine-border, #2a3140)',
  color: enabled ? '#0f1419' : 'var(--sardine-muted, #9aa5b8)',
  border: 'none',
  borderRadius: '3px',
  cursor: enabled ? 'pointer' : 'not-allowed',
  fontWeight: 600,
  fontSize: '0.85rem',
});

const linkButtonStyle = {
  background: 'transparent',
  color: 'var(--sardine-cyan, #4ec9d4)',
  border: 'none',
  cursor: 'pointer',
  fontSize: '0.8rem',
  padding: 0,
  marginLeft: '0.5rem',
};

const bannerStyle = {
  background: 'var(--sardine-panel, #151a24)',
  border: '1px solid var(--sardine-border, #2a3140)',
  borderRadius: '6px',
  padding: '0.6rem 0.9rem',
  marginBottom: '0.8rem',
  fontSize: '0.85rem',
};

const errorStyle = {
  marginTop: '0.5rem',
  color: 'var(--sardine-amber, #f5a623)',
  fontSize: '0.85rem',
};
