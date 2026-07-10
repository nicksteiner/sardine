import React, {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { GeoJsonLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { SARViewer } from './SARViewer.jsx';
import { loadLocalTIFs } from '../loaders/cog-loader.js';
import { loadNISARGCOV, listNISARDatasets } from '../loaders/nisar-loader.js';
import { autoContrastWithDbDetect, sampleViewportStats } from '../utils/stats.js';

/**
 * CompareGrid — load up to 4 GeoTIFF/COG files into an adaptive grid of GPU
 * SARViewer panels that all track the same area (synced pan/zoom).
 *
 * Layout: 1 → full, 2 → side-by-side, 3-4 → 2×2.
 * Each panel keeps its own contrast / colormap / dB toggle, computed
 * independently from its data, while sharing one world-coordinate viewState.
 *
 * Per-panel SARViewer refs are exposed via the imperative handle so the parent
 * can stitch all panels into a single figure PNG (exportFigureGrid).
 *
 * Files over different areas/CRS only co-register where their bounds overlap —
 * the shared view fits the union of all panel bounds.
 */

const MAX_PANELS = 4;
const COLORMAPS = ['grayscale', 'sardine', 'viridis', 'inferno', 'plasma', 'magma', 'cividis', 'turbo'];
const STRETCH_MODE_KEYS = ['linear', 'sqrt', 'cbrt', 'log', 'gamma', 'sigmoid'];
// Chip swatch colors — mirror the overlay layer line colors (see overlayLayers).
const OVERLAY_CHIP_COLORS = ['#ffc800', '#00c8ff', '#ff64c8', '#64ff64', '#ff8c00'];

let panelSeq = 0;
const nextPanelId = () => `cmp-panel-${++panelSeq}`;

const H5_RE = /\.(h5|hdf5|he5)$/i;
const TIF_RE = /\.(tif|tiff)$/i;

/**
 * dB auto-contrast from NISAR metadata stats (mean ± 2·std), matching
 * app/main.jsx's NISAR path. Falls back to a sane dB range.
 */
function nisarAutoContrast(stats) {
  if (stats?.mean_value > 0 && stats?.sample_stddev > 0) {
    const meanDb = 10 * Math.log10(stats.mean_value);
    const stdDb = Math.abs(10 * Math.log10(stats.sample_stddev / stats.mean_value));
    return [Math.round(meanDb - 2 * stdDb), Math.round(meanDb + 2 * stdDb)];
  }
  return [-25, 0];
}

/** Fit a viewState to the union of panel bounds (assumes ~1000px viewport). */
function fitViewState(panels) {
  const withBounds = panels.filter((p) => p.source?.bounds);
  if (withBounds.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of withBounds) {
    const [a, b, c, d] = p.source.bounds;
    minX = Math.min(minX, a);
    minY = Math.min(minY, b);
    maxX = Math.max(maxX, c);
    maxY = Math.max(maxY, d);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const maxSpan = Math.max(maxX - minX, maxY - minY) || 1;
  return {
    target: [centerX, centerY],
    zoom: Math.log2(1000 / maxSpan),
    minZoom: -15,
    maxZoom: 25,
  };
}

/** Grid template (cols, rows) for n panels. */
function gridTemplate(n) {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  return { cols: 2, rows: 2 }; // 3 or 4
}

export const CompareGrid = forwardRef(function CompareGrid(
  { initialFiles = null, onStatus = () => {}, onExport = null, style = {} },
  ref
) {
  // panel: {id, name, source, contrastLimits, colormap, useDecibels, stretchMode, gamma}
  const [panels, setPanels] = useState([]);
  // Mirror of `panels` for handlers that must read latest state without
  // depending on it (keeps those useCallbacks stable so React.memo holds).
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const [viewState, setViewState] = useState(null);
  const [syncViews, setSyncViews] = useState(true);
  const [syncColormap, setSyncColormap] = useState(false);
  const [loading, setLoading] = useState(false);
  // Vector overlays (WGS84 GeoJSON), shown on every panel: [{id, name, data}]
  const [overlays, setOverlays] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);

  // Per-panel SARViewer refs (for canvas capture on export), keyed by panel id.
  const panelRefs = useRef(new Map());
  const setPanelRef = useCallback((id, el) => {
    if (el) panelRefs.current.set(id, el);
    else panelRefs.current.delete(id);
  }, []);

  // Expose panel data + refs so the parent can build a stitched figure.
  useImperativeHandle(ref, () => ({
    getPanels: () =>
      panels.map((p) => ({
        ...p,
        viewer: panelRefs.current.get(p.id) || null,
      })),
    getViewState: () => viewState,
    addFiles: (files) => loadFiles(files),
    clear: () => setPanels([]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }));

  /** Append a fully-built panel, reserving its slot immediately. */
  const addPanel = useCallback((panel) => {
    panelRefs.current.set(panel.id, null); // reserve slot (cap holds under concurrency)
    setPanels((prev) => [...prev, panel]);
  }, []);

  /** Load one GeoTIFF/COG as a panel. */
  const loadCOGPanel = useCallback(
    async (file) => {
      const data = await loadLocalTIFs([file]);
      const { useDecibels, contrastLimits } = autoContrastWithDbDetect(data.data);
      addPanel({
        id: nextPanelId(), name: file.name, kind: 'cog', file, source: data,
        contrastLimits, colormap: 'grayscale', useDecibels, stretchMode: 'linear', gamma: 1.0,
      });
      onStatus('success', `Compare: added ${file.name} (${data.width}×${data.height})`);
    },
    [addPanel, onStatus]
  );

  /** Load one NISAR .h5 as a panel — auto-picks the first freq/pol dataset. */
  const loadNISARPanel = useCallback(
    async (file) => {
      const datasets = await listNISARDatasets(file);
      if (!datasets || datasets.length === 0) throw new Error('no GCOV datasets found');
      const pick = datasets.find((d) => d.frequency === 'A') || datasets[0];
      const source = await loadNISARGCOV(file, { frequency: pick.frequency, polarization: pick.polarization });
      addPanel({
        id: nextPanelId(), name: file.name, kind: 'nisar', file, source,
        datasets, frequency: pick.frequency, polarization: pick.polarization,
        contrastLimits: nisarAutoContrast(pick.stats), colormap: 'grayscale',
        useDecibels: true, stretchMode: 'linear', gamma: 1.0,
      });
      onStatus('success', `Compare: added ${file.name} (freq${pick.frequency}/${pick.polarization})`);
    },
    [addPanel, onStatus]
  );

  /** Load 1+ raster files (.tif or .h5), each as its own panel (cap MAX_PANELS). */
  const loadFiles = useCallback(
    async (files) => {
      const list = Array.from(files || []);
      if (list.length === 0) return;

      setLoading(true);
      try {
        for (const file of list) {
          // Cap against the live panel count (refs are the source of truth,
          // since setPanels is async and several files load in one call).
          if (panelRefs.current.size >= MAX_PANELS) {
            onStatus('info', `Compare grid full — skipped ${file.name}`);
            continue;
          }
          try {
            onStatus('info', `Compare: loading ${file.name}`);
            if (H5_RE.test(file.name)) await loadNISARPanel(file);
            else await loadCOGPanel(file);
          } catch (e) {
            onStatus('error', `Compare: failed ${file.name}`, e.message);
          }
        }
      } finally {
        setLoading(false);
      }
    },
    [onStatus, loadCOGPanel, loadNISARPanel]
  );

  /** Parse dropped GeoJSON files (WGS84) and add them as overlays on all panels. */
  const loadGeoJSONFiles = useCallback(
    (files) => {
      const gjFiles = Array.from(files || []).filter((f) => /\.(geojson|json)$/i.test(f.name));
      for (const file of gjFiles) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const parsed = JSON.parse(evt.target.result);
            const t = parsed?.type;
            if (t !== 'FeatureCollection' && t !== 'Feature' && t !== 'GeometryCollection') {
              onStatus('error', `Not a GeoJSON object: ${file.name}`);
              return;
            }
            const data = t === 'Feature' ? { type: 'FeatureCollection', features: [parsed] } : parsed;
            setOverlays((prev) => [...prev, { id: `gj-${nextPanelId()}-${file.name}`, name: file.name, data }]);
            onStatus('success', `Overlay added: ${file.name}`);

            // GeoJSON is WGS84 by spec; warn if any panel raster is projected,
            // since we render vectors in LNGLAT and won't reproject.
            const projected = panelsRef.current.some((p) => {
              const crs = p.source?.crs;
              return crs && !/4326|WGS\s*84|CRS84/i.test(crs);
            });
            if (projected) {
              onStatus('warning', `${file.name}: overlay is WGS84; projected panels may not align (no reprojection)`);
            }
          } catch (e) {
            onStatus('error', `Failed to parse ${file.name}`, e.message);
          }
        };
        reader.readAsText(file);
      }
    },
    [onStatus]
  );

  const removeOverlay = useCallback((id) => {
    setOverlays((prev) => prev.filter((o) => o.id !== id));
  }, []);

  // Drop router: rasters → panels, GeoJSON → overlays.
  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't let main.jsx's app-level onDrop also fire
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length === 0) return;
      const rasters = files.filter((f) => TIF_RE.test(f.name) || H5_RE.test(f.name));
      const vectors = files.filter((f) => /\.(geojson|json)$/i.test(f.name));
      const other = files.filter((f) => !TIF_RE.test(f.name) && !H5_RE.test(f.name) && !/\.(geojson|json)$/i.test(f.name));
      if (rasters.length) loadFiles(rasters);
      if (vectors.length) loadGeoJSONFiles(vectors);
      if (other.length) onStatus('info', `Ignored ${other.length} unsupported file(s)`);
    },
    [loadFiles, loadGeoJSONFiles, onStatus]
  );

  // Load any files handed in at mount.
  useEffect(() => {
    if (initialFiles && initialFiles.length) loadFiles(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fit the shared view to the union of all panel bounds whenever a panel
  // is added or removed (boundsKey changes only on add/remove, not on pan/zoom
  // since each panel's bounds are stable). This guarantees a newly added file
  // is brought into view rather than left off-screen.
  const boundsKey = panels.map((p) => p.source?.bounds?.join(',')).join('|');
  useEffect(() => {
    if (panels.length === 0) {
      setViewState(null);
      return;
    }
    const fit = fitViewState(panels);
    if (fit) setViewState(fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey]);

  const handleViewStateChange = useCallback(
    (panelId) =>
      ({ viewState: vs }) => {
        // With sync on, any panel drives the shared view. With sync off,
        // we still keep a single state (panels stay locked to same area by
        // design); the toggle is reserved for future independent control.
        if (syncViews) setViewState(vs);
      },
    [syncViews]
  );

  const removePanel = useCallback((id) => {
    panelRefs.current.delete(id);
    setPanels((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const updatePanel = useCallback((id, patch) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  // Switch a NISAR panel to a different frequency/polarization: reload the
  // GCOV source and re-derive dB auto-contrast from that dataset's stats.
  const changePanelDataset = useCallback(
    async (id, frequency, polarization) => {
      const panel = panelsRef.current.find((p) => p.id === id);
      if (!panel || panel.kind !== 'nisar' || !panel.file) return;
      try {
        onStatus('info', `Compare: ${panel.name} → freq${frequency}/${polarization}`);
        const source = await loadNISARGCOV(panel.file, { frequency, polarization });
        const ds = panel.datasets?.find((d) => d.frequency === frequency && d.polarization === polarization);
        setPanels((prev) => prev.map((p) => (p.id === id
          ? { ...p, source, frequency, polarization, contrastLimits: nisarAutoContrast(ds?.stats) }
          : p)));
      } catch (e) {
        onStatus('error', `Compare: dataset switch failed for ${panel.name}`, e.message);
      }
    },
    [onStatus]
  );

  // Colormap change — applies to all panels when syncColormap is on.
  const changeColormap = useCallback(
    (id, colormap) => {
      setPanels((prev) =>
        prev.map((p) => (syncColormap || p.id === id ? { ...p, colormap } : p))
      );
    },
    [syncColormap]
  );

  // Auto-stretch a panel's contrast to p2/p98 of WHAT'S CURRENTLY IN VIEW.
  // Derives the panel's visible world rectangle from its viewState + canvas
  // size (deck.gl OrthographicView: visible world extent = canvasPx / 2^zoom),
  // clamps to the panel's bounds, then samples a 3×3 tile grid over that region
  // via sampleViewportStats — so zooming into a bright/dark area restretches to
  // that area, matching the main viewer's "viewport" histogram scope.
  const autoStretchPanel = useCallback(
    async (id) => {
      const panel = panelsRef.current.find((p) => p.id === id);
      if (!panel?.source?.getTile || !panel.source.bounds) return;

      const [bMinX, bMinY, bMaxX, bMaxY] = panel.source.bounds;
      let regionX = bMinX, regionY = bMinY;
      let regionW = bMaxX - bMinX, regionH = bMaxY - bMinY;
      let scope = 'scene';

      // Read the panel's current view to compute the visible rectangle.
      const viewer = panelRefs.current.get(id);
      const vs = viewer?.getViewState?.();
      const canvas = viewer?.getCanvas?.();
      if (vs && Array.isArray(vs.target) && typeof vs.zoom === 'number' && canvas) {
        const ppu = Math.pow(2, vs.zoom); // screen px per world unit
        const halfW = (canvas.clientWidth || 900) / 2 / ppu;
        const halfH = (canvas.clientHeight || 700) / 2 / ppu;
        const [cx, cy] = vs.target;
        const vpLeft = Math.max(bMinX, cx - halfW);
        const vpRight = Math.min(bMaxX, cx + halfW);
        const vpTop = Math.max(bMinY, cy - halfH);
        const vpBottom = Math.min(bMaxY, cy + halfH);
        if (vpRight > vpLeft && vpBottom > vpTop) {
          regionX = vpLeft; regionY = vpTop;
          regionW = vpRight - vpLeft; regionH = vpBottom - vpTop;
          scope = 'viewport';
        }
      }

      try {
        const stats = await sampleViewportStats(
          panel.source.getTile, regionW, regionH, panel.useDecibels, 128,
          regionX, regionY,
        );
        if (!stats) {
          onStatus('info', `Auto-stretch: no data sampled for ${panel.name}`);
          return;
        }
        const contrastLimits = [stats.p2, stats.p98];
        setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, contrastLimits } : p)));
        const u = panel.useDecibels ? ' dB' : '';
        const fx = panel.useDecibels ? 1 : 3;
        onStatus('success', `Auto-stretch (${scope}) ${panel.name}: ${stats.p2.toFixed(fx)} to ${stats.p98.toFixed(fx)}${u}`);
      } catch (e) {
        onStatus('error', `Auto-stretch failed for ${panel.name}`, e.message);
      }
    },
    [onStatus]
  );

  // Vector overlay layers — WGS84 GeoJSON, rendered in lon/lat (no reprojection).
  // One set shared across all panels (each panel gets the same deck.gl layers).
  const overlayLayers = useMemo(() => {
    const colors = [
      [255, 200, 0], [0, 200, 255], [255, 100, 200], [100, 255, 100], [255, 140, 0],
    ];
    return overlays.map((o, i) => {
      const color = colors[i % colors.length];
      return new GeoJsonLayer({
        id: o.id,
        data: o.data,
        coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
        pickable: false,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 2,
        pointRadiusMinPixels: 5,
        getLineColor: [...color, 220],
        getFillColor: [...color, 40],
        getLineWidth: 2,
        getPointRadius: 5,
      });
    });
  }, [overlays]);

  const { cols, rows } = gridTemplate(panels.length || 1);

  const containerStyle = useMemo(
    () => ({
      position: 'relative',
      width: '100%',
      height: '100%',
      display: 'grid',
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gridTemplateRows: `repeat(${rows}, 1fr)`,
      gap: '2px',
      backgroundColor: 'var(--sardine-border, #1e3a5f)',
      ...style,
    }),
    [cols, rows, style]
  );

  // Empty state — prompt to drop/select files.
  if (panels.length === 0) {
    return (
      <div
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '14px',
          color: 'var(--text-muted, #5a7099)',
          background: 'var(--sardine-bg, #030201)',
          outline: dragActive ? '2px dashed var(--sardine-cyan, #4ec9d4)' : 'none',
          outlineOffset: '-8px',
          ...style,
        }}
      >
        <div style={{ fontSize: '0.95rem', fontFamily: 'var(--font-mono, monospace)' }}>
          Compare grid — drop up to {MAX_PANELS} GeoTIFFs or NISAR .h5 (+ .geojson overlays), or
        </div>
        <button type="button" onClick={() => fileInputRef.current?.click()} style={pickButtonStyle}>
          Select files…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".tif,.tiff,.h5,.hdf5,.he5"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => loadFiles(e.target.files)}
        />
      </div>
    );
  }

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragActive(false); }}
      onDrop={handleDrop}
    >
      <div style={containerStyle}>
        {panels.map((p) => (
          <Panel
            key={p.id}
            panel={p}
            viewState={viewState}
            extraLayers={overlayLayers}
            setPanelRef={setPanelRef}
            onViewStateChange={handleViewStateChange}
            onUpdate={updatePanel}
            onColormap={changeColormap}
            onAutoStretch={autoStretchPanel}
            onDataset={changePanelDataset}
            onRemove={removePanel}
          />
        ))}
      </div>

      {dragActive && (
        <div style={dropHintStyle}>Drop GeoTIFFs or .geojson overlays…</div>
      )}

      {/* Overlay chips */}
      {overlays.length > 0 && (
        <div style={overlayChipsStyle}>
          {overlays.map((o, i) => (
            <span key={o.id} style={overlayChipStyle}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: OVERLAY_CHIP_COLORS[i % OVERLAY_CHIP_COLORS.length] }} />
              <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</span>
              <button type="button" onClick={() => removeOverlay(o.id)} style={removeButtonStyle} title="Remove overlay">×</button>
            </span>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div style={toolbarStyle}>
        <label style={syncLabelStyle}>
          <input
            type="checkbox"
            checked={syncViews}
            onChange={(e) => setSyncViews(e.target.checked)}
          />
          Sync pan/zoom
        </label>
        <label style={syncLabelStyle}>
          <input
            type="checkbox"
            checked={syncColormap}
            onChange={(e) => {
              const on = e.target.checked;
              setSyncColormap(on);
              // On enable, push the first panel's colormap to all others.
              if (on) {
                setPanels((prev) =>
                  prev.length ? prev.map((p) => ({ ...p, colormap: prev[0].colormap })) : prev
                );
              }
            }}
          />
          Sync colormap
        </label>
        {panels.length < MAX_PANELS && (
          <button type="button" onClick={() => fileInputRef.current?.click()} style={addButtonStyle}>
            + Add panel
          </button>
        )}
        {onExport && (
          <button
            type="button"
            onClick={onExport}
            style={{ ...addButtonStyle, borderColor: 'var(--sardine-cyan, #4ec9d4)', color: 'var(--sardine-cyan, #4ec9d4)' }}
            title="Export all panels as one PNG"
          >
            Export PNG
          </button>
        )}
        {loading && <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>loading…</span>}
        <input
          ref={fileInputRef}
          type="file"
          accept=".tif,.tiff,.h5,.hdf5,.he5"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => loadFiles(e.target.files)}
        />
      </div>
    </div>
  );
});

/**
 * One grid cell: a GPU SARViewer + its control overlay. Memoized so editing
 * one panel (e.g. dragging its contrast slider) does NOT re-render the other
 * panels. The handler props (onUpdate/onColormap/onAutoStretch/onRemove,
 * onViewStateChange factory) are stable useCallbacks from the parent, and are
 * bound to this panel's id internally — keeping the memo effective.
 */
const Panel = React.memo(function Panel({
  panel,
  viewState,
  extraLayers,
  setPanelRef,
  onViewStateChange,
  onUpdate,
  onColormap,
  onAutoStretch,
  onDataset,
  onRemove,
}) {
  const id = panel.id;
  const refCb = useCallback((el) => setPanelRef(id, el), [setPanelRef, id]);
  const vsCb = useMemo(() => onViewStateChange(id), [onViewStateChange, id]);
  const change = useCallback((patch) => onUpdate(id, patch), [onUpdate, id]);
  const colormap = useCallback((cm) => onColormap(id, cm), [onColormap, id]);
  const autoStretch = useCallback(() => onAutoStretch(id), [onAutoStretch, id]);
  const dataset = useCallback((f, p) => onDataset(id, f, p), [onDataset, id]);
  const remove = useCallback(() => onRemove(id), [onRemove, id]);

  return (
    <div style={{ position: 'relative', overflow: 'hidden', background: 'var(--sardine-bg, #030201)' }}>
      <SARViewer
        ref={refCb}
        getTile={panel.source.getTile}
        imageData={panel.source.data ? panel.source : null}
        bounds={panel.source.bounds}
        contrastLimits={panel.contrastLimits}
        useDecibels={panel.useDecibels}
        colormap={panel.colormap}
        stretchMode={panel.stretchMode}
        gamma={panel.gamma}
        imageWidth={panel.source.sourceWidth || panel.source.width}
        imageHeight={panel.source.sourceHeight || panel.source.height}
        xCoords={panel.source.xCoords}
        yCoords={panel.source.yCoords}
        initialViewState={viewState || undefined}
        onViewStateChange={vsCb}
        extraLayers={extraLayers}
        showGrid={false}
      />
      <PanelControls
        panel={panel}
        onChange={change}
        onColormap={colormap}
        onAutoStretch={autoStretch}
        onDataset={dataset}
        onRemove={remove}
      />
    </div>
  );
});

/**
 * Editable numeric readout — shows `value` but lets the user type a new one.
 * Commits on blur or Enter (so partial entries like "-" or "1." don't fight
 * the slider mid-keystroke); Escape reverts. Reflects external changes when
 * not being edited.
 */
function NumField({ value, onCommit, format = (v) => v.toFixed(1), title, style }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const display = editing ? draft : format(value);

  const commit = () => {
    setEditing(false);
    const n = parseFloat(draft);
    if (!Number.isNaN(n)) onCommit(n);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={display}
      title={title}
      onFocus={(e) => { setEditing(true); setDraft(format(value)); e.target.select(); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); e.target.blur(); }
        else if (e.key === 'Escape') { setEditing(false); e.target.blur(); }
        e.stopPropagation(); // don't let the app's keyboard shortcuts fire
      }}
      style={{ ...numFieldStyle, ...style }}
    />
  );
}

/** Per-panel overlay: label + full stretch controls. */
function PanelControls({ panel, onChange, onColormap, onAutoStretch, onDataset, onRemove }) {
  // NISAR panels expose a freq/pol picker built from the file's dataset list.
  const isNISAR = panel.kind === 'nisar' && Array.isArray(panel.datasets);
  const freqs = isNISAR ? [...new Set(panel.datasets.map((d) => d.frequency))] : [];
  const polsForFreq = isNISAR
    ? panel.datasets.filter((d) => d.frequency === panel.frequency).map((d) => d.polarization)
    : [];
  const [lo, hi] = panel.contrastLimits || [0, 1];
  // Slider bounds: pad the current range so both handles stay draggable
  // across dB (negative) and linear (0–1+) data.
  const span = Math.max(Math.abs(hi - lo), 1e-3);
  const sMin = lo - span;
  const sMax = hi + span;
  const step = span / 200;

  // rAF-throttle contrast updates: a fast drag fires `input` many times per
  // frame; coalesce to ONE state commit per animation frame (latest value
  // wins). `pendingRef` holds the in-flight [lo,hi] so successive events in
  // the same frame build on each other, not on the stale prop.
  const pendingRef = useRef(null);
  const rafRef = useRef(0);
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const scheduleCommit = useCallback(
    (next) => {
      pendingRef.current = next;
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        if (pendingRef.current) {
          onChange({ contrastLimits: pendingRef.current });
          pendingRef.current = null;
        }
      });
    },
    [onChange]
  );

  const setLo = (v) => {
    const curHi = pendingRef.current ? pendingRef.current[1] : hi;
    const nv = Math.min(Number(v), curHi - step);
    scheduleCommit([nv, curHi]);
  };
  const setHi = (v) => {
    const curLo = pendingRef.current ? pendingRef.current[0] : lo;
    const nv = Math.max(Number(v), curLo + step);
    scheduleCommit([curLo, nv]);
  };

  return (
    <div style={panelLabelStyle}>
      {/* Row 1 — filename + remove */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%' }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {panel.name}
        </span>
        <button type="button" onClick={onRemove} style={removeButtonStyle} title="Remove panel">×</button>
      </div>

      {/* Row 1b — NISAR frequency + polarization (only for .h5 panels) */}
      {isNISAR && (
        <div style={ctrlRowStyle}>
          <select
            value={panel.frequency}
            onChange={(e) => {
              const f = e.target.value;
              // Pick a valid polarization for the new frequency.
              const pols = panel.datasets.filter((d) => d.frequency === f).map((d) => d.polarization);
              const pol = pols.includes(panel.polarization) ? panel.polarization : pols[0];
              onDataset(f, pol);
            }}
            style={miniSelectStyle}
            title="NISAR frequency"
          >
            {freqs.map((f) => <option key={f} value={f}>freq{f}</option>)}
          </select>
          <select
            value={panel.polarization}
            onChange={(e) => onDataset(panel.frequency, e.target.value)}
            style={miniSelectStyle}
            title="Polarization"
          >
            {polsForFreq.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      )}

      {/* Row 2 — colormap, stretch mode, dB */}
      <div style={ctrlRowStyle}>
        <select
          value={panel.colormap}
          onChange={(e) => onColormap(e.target.value)}
          style={miniSelectStyle}
          title="Colormap"
        >
          {COLORMAPS.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          value={panel.stretchMode}
          onChange={(e) => onChange({ stretchMode: e.target.value })}
          style={miniSelectStyle}
          title="Stretch mode"
        >
          {STRETCH_MODE_KEYS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <label style={dbToggleStyle} title="Decibel scaling">
          <input
            type="checkbox"
            checked={panel.useDecibels}
            onChange={(e) => onChange({ useDecibels: e.target.checked })}
          />
          dB
        </label>
      </div>

      {/* Row 3 — gamma (only in gamma mode) */}
      {panel.stretchMode === 'gamma' && (
        <div style={ctrlRowStyle}>
          <span style={{ ...sliderLabelStyle, minWidth: '14px' }}>γ</span>
          <input
            type="range"
            min={0.2}
            max={3}
            step={0.05}
            value={panel.gamma}
            onChange={(e) => onChange({ gamma: Number(e.target.value) })}
            style={{ flex: 1 }}
          />
          <NumField
            value={panel.gamma}
            onCommit={(v) => onChange({ gamma: Math.max(0.05, v) })}
            format={(v) => v.toFixed(2)}
            title="Gamma exponent"
          />
        </div>
      )}

      {/* Row 4 — contrast min/max sliders + editable numbers + auto-stretch */}
      <div style={ctrlRowStyle}>
        <NumField
          value={lo}
          onCommit={(v) => setLo(v)}
          title="Contrast minimum (editable)"
        />
        <input
          type="range"
          min={sMin}
          max={sMax}
          step={step}
          value={lo}
          onChange={(e) => setLo(e.target.value)}
          style={{ flex: 1 }}
          title="Contrast min"
        />
        <input
          type="range"
          min={sMin}
          max={sMax}
          step={step}
          value={hi}
          onChange={(e) => setHi(e.target.value)}
          style={{ flex: 1 }}
          title="Contrast max"
        />
        <NumField
          value={hi}
          onCommit={(v) => setHi(v)}
          title="Contrast maximum (editable)"
        />
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onAutoStretch(); }}
          style={autoStretchBtnStyle}
          title="Auto-stretch (p2–p98)"
        >
          auto
        </button>
      </div>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────
const pickButtonStyle = {
  background: 'var(--sardine-bg-raised, #0f1f38)',
  border: '1px solid var(--sardine-border, #1e3a5f)',
  color: 'var(--text-primary, #e8edf5)',
  padding: '8px 18px',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: '0.8rem',
};

const panelLabelStyle = {
  position: 'absolute',
  top: '6px',
  left: '6px',
  right: '6px',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  background: 'rgba(15, 31, 56, 0.88)',
  border: '1px solid var(--sardine-border, #1e3a5f)',
  color: 'var(--text-primary, #e8edf5)',
  padding: '4px 6px',
  borderRadius: 'var(--radius-sm, 4px)',
  fontSize: '0.7rem',
  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
  zIndex: 1000,
};

const ctrlRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '5px',
  width: '100%',
};

const sliderLabelStyle = {
  fontSize: '0.62rem',
  color: 'var(--text-muted, #9bb0d0)',
  minWidth: '34px',
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
};

const autoStretchBtnStyle = {
  background: 'var(--sardine-bg, #030201)',
  border: '1px solid var(--sardine-border, #1e3a5f)',
  color: 'var(--text-primary, #e8edf5)',
  borderRadius: '3px',
  fontSize: '0.6rem',
  padding: '1px 5px',
  cursor: 'pointer',
};

const numFieldStyle = {
  width: '46px',
  background: 'var(--sardine-bg, #030201)',
  color: 'var(--text-primary, #e8edf5)',
  border: '1px solid var(--sardine-border, #1e3a5f)',
  borderRadius: '3px',
  fontSize: '0.62rem',
  fontVariantNumeric: 'tabular-nums',
  textAlign: 'center',
  padding: '1px 2px',
  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
};

const miniSelectStyle = {
  background: 'var(--sardine-bg, #030201)',
  color: 'var(--text-primary, #e8edf5)',
  border: '1px solid var(--sardine-border, #1e3a5f)',
  borderRadius: '3px',
  fontSize: '0.65rem',
  padding: '1px 2px',
};

const dbToggleStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '2px',
  fontSize: '0.65rem',
  cursor: 'pointer',
};

const removeButtonStyle = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-muted, #5a7099)',
  cursor: 'pointer',
  fontSize: '1rem',
  lineHeight: 1,
  padding: '0 2px',
};

const toolbarStyle = {
  position: 'absolute',
  bottom: '10px',
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  background: 'rgba(15, 31, 56, 0.92)',
  border: '1px solid var(--sardine-border, #1e3a5f)',
  borderRadius: 'var(--radius-sm, 4px)',
  padding: '5px 12px',
  zIndex: 1500,
};

const syncLabelStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '5px',
  color: 'var(--text-primary, #e8edf5)',
  fontSize: '0.72rem',
  fontFamily: 'var(--font-mono, monospace)',
  cursor: 'pointer',
};

const addButtonStyle = {
  background: 'var(--sardine-bg, #030201)',
  border: '1px solid var(--sardine-border, #1e3a5f)',
  color: 'var(--text-primary, #e8edf5)',
  padding: '3px 10px',
  borderRadius: '3px',
  cursor: 'pointer',
  fontSize: '0.72rem',
  fontFamily: 'var(--font-mono, monospace)',
};

const dropHintStyle = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(3, 15, 30, 0.55)',
  border: '2px dashed var(--sardine-cyan, #4ec9d4)',
  color: 'var(--sardine-cyan, #4ec9d4)',
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: '0.95rem',
  pointerEvents: 'none',
  zIndex: 1800,
};

const overlayChipsStyle = {
  position: 'absolute',
  top: '10px',
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  maxWidth: '80%',
  justifyContent: 'center',
  zIndex: 1500,
};

const overlayChipStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '5px',
  background: 'rgba(15, 31, 56, 0.92)',
  border: '1px solid var(--sardine-border, #1e3a5f)',
  borderRadius: 'var(--radius-sm, 4px)',
  padding: '2px 6px',
  color: 'var(--text-primary, #e8edf5)',
  fontSize: '0.68rem',
  fontFamily: 'var(--font-mono, monospace)',
};

export default CompareGrid;
