/**
 * COGExplorer — /explore/cog
 *
 * Minimal Cloud-Optimized GeoTIFF viewer. Strips every NISAR-specific panel
 * (frequency, polarization, product-type detection, HDF5 tree). What remains:
 * URL/file load, contrast + colormap + stretch controls, and a SARViewer.
 *
 * Accepts inputs from three sources:
 *   1. `url` prop        (LocalExplorer delegation or programmatic mount)
 *   2. `localFile` prop  (LocalExplorer delegation with a dropped .tif)
 *   3. `?url=` query param (direct navigation to /explore/cog?url=...)
 *
 * Shares `src/loaders/cog-loader.js` and `src/viewers/SARViewer.jsx` with
 * GCOVExplorer (S290 R4 — one canonical entry point per loader).
 */
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Link } from 'wouter';
import {
  SARViewer,
  MapViewer,
  loadCOG,
  loadLocalTIF,
  loadCOGFullImage,
  autoContrastLimits,
} from '@src/index.js';
import 'maplibre-gl/dist/maplibre-gl.css';

const COLORMAPS = ['grayscale', 'viridis', 'inferno', 'plasma', 'sardine', 'flood'];
const STRETCH_MODES = ['linear', 'sqrt', 'gamma', 'sigmoid'];

const panelStyle = {
  padding: '0.75rem 1rem',
  background: 'var(--sardine-panel, #151a24)',
  border: '1px solid var(--sardine-border, #2a3140)',
  borderRadius: '6px',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const labelStyle = {
  fontSize: '0.75rem',
  color: 'var(--sardine-muted, #9aa5b8)',
  fontFamily: 'monospace',
};

const inputStyle = {
  background: 'var(--sardine-bg, #0f1419)',
  color: 'var(--sardine-ink, #e0e0e0)',
  border: '1px solid var(--sardine-border, #2a3140)',
  borderRadius: '4px',
  padding: '0.35rem 0.5rem',
  fontSize: '0.85rem',
  fontFamily: 'monospace',
};

const buttonStyle = {
  ...inputStyle,
  cursor: 'pointer',
  padding: '0.4rem 0.75rem',
};

export default function COGExplorer({ url: propUrl = null, localFile = null } = {}) {
  const [cogUrl, setCogUrl] = useState(propUrl || '');
  const [imageData, setImageData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Visual controls
  const [contrastMin, setContrastMin] = useState(-25);
  const [contrastMax, setContrastMax] = useState(0);
  const [useDecibels, setUseDecibels] = useState(true);
  const [colormap, setColormap] = useState('grayscale');
  const [stretchMode, setStretchMode] = useState('linear');
  const [gamma, setGamma] = useState(1.0);
  const [basemap, setBasemap] = useState(false);

  // View state (OrthographicView) — one load generation per request so stale
  // loads don't clobber the current viewer.
  const [viewCenter, setViewCenter] = useState([0, 0]);
  const [viewZoom, setViewZoom] = useState(0);
  const loadGenRef = useRef(0);

  // Read `url=` query param on mount. Hash router embeds query params inside
  // the hash (`/#/explore/cog?url=…`), not in window.location.search. Fall
  // back to window.location.search for the S291 legacy redirect path where
  // the router may have navigated to /explore/cog?url=… during this same tick.
  useEffect(() => {
    if (propUrl || localFile) return;
    const hash = window.location.hash || '';
    const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
    const hashParams = new URLSearchParams(hashQuery);
    const searchParams = new URLSearchParams(window.location.search);
    const q = hashParams.get('url') || hashParams.get('cog') || searchParams.get('url') || searchParams.get('cog');
    if (q) setCogUrl(q);
  }, [propUrl, localFile]);

  // Load a COG from a URL
  const loadFromUrl = useCallback(async (url) => {
    if (!url) {
      setError('Please enter a COG URL');
      return;
    }
    try {
      new URL(url);
    } catch {
      setError('Invalid URL format');
      return;
    }
    const gen = ++loadGenRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await loadCOG(url);
      if (gen !== loadGenRef.current) return;
      setImageData({ ...data, cogUrl: url });
      await applyAutoContrast(url);
      fitToBounds(data.bounds);
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      setError(`Failed to load COG: ${e.message}`);
      setImageData(null);
    } finally {
      if (gen === loadGenRef.current) setLoading(false);
    }
  }, [useDecibels]);

  // Load a COG from a File (for /local delegation)
  const loadFromFile = useCallback(async (file) => {
    const gen = ++loadGenRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await loadLocalTIF(file);
      if (gen !== loadGenRef.current) return;
      setImageData(data);
      // Auto-contrast from the tile data isn't as simple for a local TIF; skip
      // unless the loader returned samples. The default contrast window works
      // well enough for typical SAR backscatter.
      fitToBounds(data.bounds);
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      setError(`Failed to load local TIF: ${e.message}`);
      setImageData(null);
    } finally {
      if (gen === loadGenRef.current) setLoading(false);
    }
  }, []);

  // Auto-contrast: pull a small decimated sample from a middle overview
  async function applyAutoContrast(url) {
    try {
      const sample = await loadCOGFullImage(url, 512);
      if (sample?.data) {
        const limits = autoContrastLimits(sample.data, useDecibels);
        setContrastMin(Math.round(limits[0]));
        setContrastMax(Math.round(limits[1]));
      }
    } catch (_) {
      // Auto-contrast failure is non-fatal — the user can adjust the sliders.
    }
  }

  function fitToBounds(bounds) {
    if (!bounds) return;
    const [minX, minY, maxX, maxY] = bounds;
    setViewCenter([(minX + maxX) / 2, (minY + maxY) / 2]);
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const isProjected = Math.abs(bounds[0]) > 180 || Math.abs(bounds[2]) > 180;
    const maxSpan = Math.max(spanX, spanY) || 1;
    const zoom = isProjected
      ? Math.log2(1000 / maxSpan)
      : Math.log2(360 / maxSpan) - 1;
    setViewZoom(zoom);
  }

  // Auto-load on mount when a prop URL / localFile is supplied (LocalExplorer path)
  useEffect(() => {
    if (localFile) loadFromFile(localFile);
    else if (propUrl) loadFromUrl(propUrl);
  }, [localFile, propUrl, loadFromFile, loadFromUrl]);

  // Kick off auto-load once the cogUrl state is populated from the query param.
  // Guarded so a user typing in the URL box doesn't trigger a fetch on every keystroke.
  const autoTriggered = useRef(false);
  useEffect(() => {
    if (autoTriggered.current) return;
    if (!cogUrl || propUrl || localFile) return;
    const hash = window.location.hash || '';
    const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
    const hashParams = new URLSearchParams(hashQuery);
    const searchParams = new URLSearchParams(window.location.search);
    const q = hashParams.get('url') || hashParams.get('cog') || searchParams.get('url') || searchParams.get('cog');
    if (q && q === cogUrl) {
      autoTriggered.current = true;
      loadFromUrl(cogUrl);
    }
  }, [cogUrl, propUrl, localFile, loadFromUrl]);

  const contrastLimits = useMemo(() => [contrastMin, contrastMax], [contrastMin, contrastMax]);

  const initialViewState = useMemo(
    () => ({ target: [viewCenter[0], viewCenter[1], 0], zoom: viewZoom }),
    [viewCenter, viewZoom]
  );

  const onSubmit = (e) => {
    e.preventDefault();
    loadFromUrl(cogUrl);
  };

  return (
    <main
      data-testid="cog-explorer"
      style={{
        minHeight: '100vh',
        background: 'var(--sardine-bg, #0f1419)',
        color: 'var(--sardine-ink, #e0e0e0)',
        fontFamily: 'system-ui, sans-serif',
        display: 'grid',
        gridTemplateColumns: '320px 1fr',
        gap: '0.75rem',
        padding: '0.75rem',
      }}
    >
      {/* Sidebar */}
      <aside style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', overflow: 'auto' }}>
        <header>
          <h2 style={{ margin: 0, color: 'var(--sardine-cyan, #4ec9d4)', fontSize: '1.1rem' }}>
            COG Explorer
          </h2>
          <p style={labelStyle}>
            <Link href="/">← chooser</Link> · Cloud-Optimized GeoTIFF viewer
          </p>
        </header>

        <form onSubmit={onSubmit} style={panelStyle}>
          <label style={labelStyle}>COG URL</label>
          <input
            data-testid="cog-url-input"
            type="text"
            value={cogUrl}
            placeholder="https://…/image.tif  or  s3://bucket/key.tif"
            onChange={(e) => setCogUrl(e.target.value)}
            style={inputStyle}
            disabled={!!localFile}
          />
          <button
            data-testid="cog-load-btn"
            type="submit"
            style={{ ...buttonStyle, background: 'var(--sardine-cyan, #4ec9d4)', color: '#000' }}
            disabled={loading || !!localFile}
          >
            {loading ? 'Loading…' : 'Load COG'}
          </button>
          {localFile && (
            <div style={labelStyle}>
              Local: <code>{localFile.name}</code> ({(localFile.size / 1e6).toFixed(1)} MB)
            </div>
          )}
          {error && (
            <div data-testid="cog-error" style={{ ...labelStyle, color: 'var(--sardine-red, #ff6b6b)' }}>
              {error}
            </div>
          )}
          {imageData && (
            <div style={labelStyle}>
              {imageData.width}×{imageData.height} · bounds [{imageData.bounds.map((b) => b.toFixed(3)).join(', ')}]
            </div>
          )}
        </form>

        <div style={panelStyle}>
          <label style={labelStyle}>Display</label>
          <label style={{ ...labelStyle, display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <input type="checkbox" checked={useDecibels} onChange={(e) => setUseDecibels(e.target.checked)} />
            dB scale (power → 10·log₁₀)
          </label>
          <label style={{ ...labelStyle, display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <input type="checkbox" checked={basemap} onChange={(e) => setBasemap(e.target.checked)} />
            MapLibre basemap
          </label>

          <label style={labelStyle}>Colormap</label>
          <select value={colormap} onChange={(e) => setColormap(e.target.value)} style={inputStyle}>
            {COLORMAPS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>

          <label style={labelStyle}>Stretch mode</label>
          <select value={stretchMode} onChange={(e) => setStretchMode(e.target.value)} style={inputStyle}>
            {STRETCH_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>

          <label style={labelStyle}>Gamma: {gamma.toFixed(2)}</label>
          <input
            type="range" min="0.3" max="3" step="0.05"
            value={gamma} onChange={(e) => setGamma(Number(e.target.value))}
          />
        </div>

        <div style={panelStyle}>
          <label style={labelStyle}>Contrast window ({useDecibels ? 'dB' : 'linear'})</label>
          <label style={labelStyle}>min: {contrastMin}</label>
          <input
            type="range" min={useDecibels ? -60 : 0} max={useDecibels ? 20 : 100}
            step={useDecibels ? 1 : 0.5}
            value={contrastMin} onChange={(e) => setContrastMin(Number(e.target.value))}
          />
          <label style={labelStyle}>max: {contrastMax}</label>
          <input
            type="range" min={useDecibels ? -60 : 0} max={useDecibels ? 20 : 100}
            step={useDecibels ? 1 : 0.5}
            value={contrastMax} onChange={(e) => setContrastMax(Number(e.target.value))}
          />
        </div>
      </aside>

      {/* Viewer */}
      <section
        data-testid="cog-viewer-container"
        style={{
          position: 'relative',
          background: '#000',
          borderRadius: '6px',
          overflow: 'hidden',
          minHeight: 0,
        }}
      >
        {!imageData && !loading && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: 'var(--sardine-muted, #9aa5b8)',
            flexDirection: 'column', gap: '0.5rem', textAlign: 'center', padding: '2rem',
          }}>
            <div style={{ fontSize: '1.1rem', color: 'var(--sardine-cyan, #4ec9d4)' }}>Drop a COG URL in the sidebar.</div>
            <div style={{ fontSize: '0.8rem' }}>
              HTTPS, S3 (<code>s3://bucket/key</code>), or pass <code>?url=</code> in the address bar.
            </div>
          </div>
        )}
        {loading && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: 'var(--sardine-cyan, #4ec9d4)', fontFamily: 'monospace',
          }}>
            Loading COG…
          </div>
        )}
        {imageData && !basemap && (
          <SARViewer
            cogUrl={imageData.cogUrl}
            getTile={imageData.getTile}
            imageData={imageData.data ? imageData : null}
            bounds={imageData.bounds}
            contrastLimits={contrastLimits}
            useDecibels={useDecibels}
            colormap={colormap}
            gamma={gamma}
            stretchMode={stretchMode}
            width="100%"
            height="100%"
            initialViewState={initialViewState}
            onViewStateChange={({ viewState }) => {
              if (viewState?.target) setViewCenter([viewState.target[0], viewState.target[1]]);
              if (typeof viewState?.zoom === 'number') setViewZoom(viewState.zoom);
            }}
          />
        )}
        {imageData && basemap && (
          <MapViewer
            getTile={imageData.getTile}
            bounds={imageData.bounds}
            contrastLimits={contrastLimits}
            useDecibels={useDecibels}
            colormap={colormap}
            width="100%"
            height="100%"
          />
        )}
      </section>
    </main>
  );
}
