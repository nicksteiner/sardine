import React, { useState, useCallback, useEffect, useMemo, useRef, Component } from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
// The single stylesheet. app/theme/sardine-theme.css used to hold a byte-identical
// copy of this file and was the one the app actually loaded, so edits to the
// canonical src/theme/ copy silently did nothing. Import the real one (W030).
import '../src/theme/sardine-theme.css';
import { SARViewer, loadCOG, loadLocalTIF, loadLocalTIFs, loadCOGFullImage, autoContrastLimits, loadNISARGCOV, listNISARDatasets, loadMultiBandCOG, loadCOGRGBComposite, loadTemporalCOGs, ComparisonViewer, CompareGrid } from '../src/index.js';
import { loadNISARRGBComposite, loadNISARIndex, listNISARDatasetsFromUrl, loadNISARGCOVFromUrl, wktToROI } from '../src/loaders/nisar-loader.js';
import { listNISARGUNWDatasets, loadNISARGUNW, GUNW_LAYER_LABELS, GUNW_DATASET_LABELS } from '../src/loaders/nisar-gunw-loader.js';
import { detectNISARProduct, openNISARReader } from '../src/loaders/nisar-product.js';
import { loadNITF, isNITFFile, listNITFDatasets, loadNITFDataset } from '../src/loaders/nitf-loader.js';
import { URLFile } from '../src/loaders/url-file.js';
import { listLocalCOGDatasets, loadLocalCOGDataset } from '../src/loaders/cog-loader.js';
import { bucketByFormat, detectFormat } from '../src/loaders/types.js';
import { loadVRT, isVRTPath } from '../src/loaders/vrt-loader.js';
import { dirHandleSource, dirEntrySource, makeFolderResolver } from '../src/loaders/vrt-local-sources.js';
import { DatasetPicker } from '../src/components/DatasetPicker.jsx';
import { Button, CloseButton, Field, Section, Panel, Toolbar, Dialog } from '../src/components/ui/index.js';
import { setWorkerCount as setPoolWorkerCount, getWorkerPoolInfo } from '../src/loaders/h5chunk.js';
import { validateWKT } from '../src/utils/wkt.js';
import { computeSubsetBounds, reprojectBbox, bboxToPixelRange, roiIntersectsFile } from '../src/utils/roi-subset.js';
import { autoSelectComposite, getAvailableComposites, getRequiredDatasets, getRequiredComplexDatasets, SAR_COMPOSITES, rgbContrastFromBandStats } from '../src/utils/sar-composites.js';
import { getAvailableIndices, SAR_INDICES } from '../src/utils/sar-indices.js';
import { DataDiscovery } from '../src/components/DataDiscovery.jsx';
import { isNISARFile, isCOGFile } from '../src/utils/bucket-browser.js';
import { writeRGBAGeoTIFF, writeFloat32GeoTIFF, downloadBuffer } from '../src/utils/geotiff-writer.js';
import { annotationsToGeoJSON, geoJSONToAnnotations, downloadMarkupGeoJSON, isSardineMarkup } from '../src/utils/annotation-io.js';
import { buildExportSidecar, downloadSidecar } from '../src/utils/export-sidecar.js';
import { makeReproject, reprojectFeature } from '../src/utils/overture-projection.js';
import { createRGBTexture, computeRGBBands } from '../src/utils/sar-composites.js';
import { computeChannelStatsAuto, sampleViewportStatsAuto } from '../src/gpu/gpu-stats.js';
import { probeGPU } from '../src/utils/gpu-detect.js';
import { applySpeckleFilter, getFilterTypes } from '../src/gpu/spatial-filter.js';
import { StatusWindow } from '../src/components/StatusWindow.jsx';
import { MetadataPanel } from '../src/components/MetadataPanel.jsx';
import { OverviewMap } from '../src/components/OverviewMap.jsx';
import { SatelliteMap } from '../src/components/SatelliteMap.jsx';
import { HistogramPanel } from '../src/components/Histogram.jsx';
import { HistogramOverlay } from '../src/components/HistogramOverlay.jsx';
import { exportFigure, exportFigureWithOverlays, exportFigureSideBySide, exportFigureGrid, exportRGBColorbar, downloadBlob, detectVendor, buildAttribution, VENDOR_OPTIONS, DEFAULT_PROCESSOR } from '../src/utils/figure-export.js';
import {
  proxyUrl as proxyUrlShared,
  unproxyUrl,
  isHostedBuild,
  getProxyUrl,
  setProxyUrl,
  getEDLToken,
  setEDLToken,
  validateEDLToken,
} from '../src/utils/proxy.js';
import { parseShareLink, buildShareLink, buildCompareLink, clearShareLinkParams } from '../src/utils/deep-link.js';
import { connectAgentBridge, captureCanvas } from '../src/utils/agent-bridge-client.js';
import { buildGrounding } from '../src/utils/sar-grounding.js';
import { buildClassPalette, seedLegendFromNames } from '../src/viewers/CompareGrid.jsx';
import { resolveGranulesForBbox } from '../src/utils/granule-resolve.js';
import { STRETCH_MODES, createStretchFn } from '../src/utils/stretch.js';
import { getColormap } from '../src/utils/colormap.js';
import { OVERTURE_THEMES, fetchAllOvertureThemes, projectedToWGS84 } from '../src/loaders/overture-loader.js';
import { createOvertureLayers } from '../src/layers/OvertureLayer.js';
import { OpticalPeekLayer } from '../src/layers/OpticalPeekLayer.js';
import { GeoJsonLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { SceneCatalog } from '../src/components/SceneCatalog.jsx';
import { NISARSearch } from '../src/components/NISARSearch.jsx';
import { ROIProfilePlot } from '../src/components/ROIProfilePlot.jsx';
import { ROIProfilePanel } from '../src/components/ROIProfilePanel.jsx';
import { TransectProfilePanel } from '../src/components/TransectProfilePanel.jsx';
import { ANNOTATION_COLORS, ANNOTATION_COLOR_KEYS } from '../src/utils/annotation-render.js';
import { CommandPalette } from '../src/components/CommandPalette.jsx';
import { ActivityRail } from '../src/components/ActivityRail.jsx';
import { ContextMenu } from '../src/components/ContextMenu.jsx';
import { ScrubNumber } from '../src/components/ScrubNumber.jsx';
import ScatterClassifier from '../src/components/ScatterClassifier.jsx';
import ClassificationOverlay from '../src/components/ClassificationOverlay.jsx';
import { IncidenceScatter, sampleScatterData } from '../src/components/IncidenceScatter.jsx';
import { loadMetadataCube } from '../src/utils/metadata-cube.js';
import { loadAllCorrections, CORRECTION_TYPES } from '../src/utils/phase-corrections.js';
import { embedStateInPNG, extractStateFromPNG } from '../src/utils/png-state.js';
import ModelPanel from '../src/components/ModelPanel.jsx';
import { createModelRegistry, runModel, buildHeadManifest } from '../src/ml/registry.js';
import { manifestDefaults, serializeManifest, deserializeManifest } from '../src/ml/manifest.js';
import { trainLogistic, evaluateModel, predictLogistic } from '../src/ml/trainer.js';
import { datasetFromClassRegions, stratifiedSplit } from '../src/ml/dataset.js';
import { debugLog } from '../src/utils/debug-log.js';
import { toDb } from '../src/utils/stats.js';

/**
 * NxN box-filter smoothing for a Float32Array image band.
 * Operates in linear power space (correct for SAR multiplicative speckle).
 * NaN/zero values are excluded from the average to preserve no-data masks.
 *
 * Used in rendered exports to reduce residual speckle that's visible at the
 * export multilook factor but not in the on-screen display (which implicitly
 * averages many more pixels at overview zoom levels).
 */
function smoothBand(data, width, height, kernel) {
  const half = Math.floor(kernel / 2);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const yMin = Math.max(0, y - half);
    const yMax = Math.min(height - 1, y + half);
    for (let x = 0; x < width; x++) {
      const xMin = Math.max(0, x - half);
      const xMax = Math.min(width - 1, x + half);
      let sum = 0, count = 0;
      for (let ky = yMin; ky <= yMax; ky++) {
        const rowOff = ky * width;
        for (let kx = xMin; kx <= xMax; kx++) {
          const v = data[rowOff + kx];
          if (v > 0 && !isNaN(v)) { sum += v; count++; }
        }
      }
      const idx = y * width + x;
      out[idx] = count > 0 ? sum / count : data[idx];
    }
  }
  return out;
}

/**
 * Parse markdown state into object
 * @param {string} markdown - Markdown state string
 * @returns {Object} Parsed state object
 */
function parseMarkdownState(markdown) {
  const state = {
    source: 'cog',
    file: '',
    dataset: null,
    contrastMin: -25,
    contrastMax: 0,
    colormap: 'grayscale',
    useDecibels: true,
    view: { center: [0, 0], zoom: 0 },
    toneMapEnabled: false,
    toneMapMethod: 'auto',
    toneMapGamma: 0.5,
    toneMapStrength: 0.3,
  };

  const lines = markdown.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // Parse source type
    const sourceMatch = trimmed.match(/\*\*Source:\*\*\s*(\w+)/);
    if (sourceMatch) {
      state.source = sourceMatch[1].toLowerCase();
    }

    // Parse file
    const fileMatch = trimmed.match(/\*\*File:\*\*\s*(.+)/);
    if (fileMatch) {
      state.file = fileMatch[1].trim();
    }

    // Parse dataset (for NISAR: A/HHHH)
    const datasetMatch = trimmed.match(/\*\*Dataset:\*\*\s*([AB])\/(\w+)/);
    if (datasetMatch) {
      state.dataset = {
        frequency: datasetMatch[1],
        polarization: datasetMatch[2],
      };
    }

    // Parse contrast
    const contrastMatch = trimmed.match(/\*\*Contrast:\*\*\s*([-\d.]+)\s*to\s*([-\d.]+)\s*(dB)?/);
    if (contrastMatch) {
      state.contrastMin = parseFloat(contrastMatch[1]);
      state.contrastMax = parseFloat(contrastMatch[2]);
      state.useDecibels = contrastMatch[3] === 'dB';
    }

    // Parse colormap
    const colormapMatch = trimmed.match(/\*\*Colormap:\*\*\s*(\w+)/);
    if (colormapMatch) {
      state.colormap = colormapMatch[1].toLowerCase();
    }

    // Parse dB mode
    const dbMatch = trimmed.match(/\*\*dB Mode:\*\*\s*(on|off)/i);
    if (dbMatch) {
      state.useDecibels = dbMatch[1].toLowerCase() === 'on';
    }

    // Parse view
    const viewMatch = trimmed.match(/\*\*View:\*\*\s*\[([-\d.]+),\s*([-\d.]+)\],?\s*zoom\s*([-\d.]+)/);
    if (viewMatch) {
      state.view = {
        center: [parseFloat(viewMatch[1]), parseFloat(viewMatch[2])],
        zoom: parseFloat(viewMatch[3]),
      };
    }

    // Parse tone mapping
    const toneMapMatch = trimmed.match(/\*\*Tone Mapping:\*\*\s*(on|off)/i);
    if (toneMapMatch) {
      state.toneMapEnabled = toneMapMatch[1].toLowerCase() === 'on';
    }

    const toneMapMethodMatch = trimmed.match(/\*\*Tone Map Method:\*\*\s*(\w+)/);
    if (toneMapMethodMatch) {
      state.toneMapMethod = toneMapMethodMatch[1];
    }

    const toneMapGammaMatch = trimmed.match(/\*\*Tone Map Gamma:\*\*\s*([\d.]+)/);
    if (toneMapGammaMatch) {
      state.toneMapGamma = parseFloat(toneMapGammaMatch[1]);
    }

    const toneMapStrengthMatch = trimmed.match(/\*\*Tone Map Strength:\*\*\s*([\d.]+)/);
    if (toneMapStrengthMatch) {
      state.toneMapStrength = parseFloat(toneMapStrengthMatch[1]);
    }
  }

  return state;
}

/**
 * Generate markdown state from object
 * @param {Object} state - State object
 * @returns {string} Markdown string
 */
function generateMarkdownState(state) {
  const lines = [
    '## State',
    '',
    `- **Source:** ${state.source || 'cog'}`,
    `- **File:** ${state.file || '(none)'}`,
  ];

  // Add dataset/composite lines for NISAR files
  if (state.source === 'nisar') {
    if (state.displayMode === 'rgb' && state.composite) {
      lines.push(`- **Composite:** ${state.composite}`);
    } else if (state.displayMode === 'index' && state.indexId) {
      lines.push(`- **Index:** ${state.indexId.toUpperCase()} (${state.indexForm}-pol)`);
    } else if (state.dataset) {
      lines.push(`- **Dataset:** ${state.dataset.frequency}/${state.dataset.polarization}`);
    }
  }

  lines.push(
    `- **Contrast:** ${state.contrastMin} to ${state.contrastMax}${state.useDecibels ? ' dB' : ''}`,
  );

  if (state.displayMode !== 'rgb') {
    lines.push(`- **Colormap:** ${state.colormap}`);
  }

  lines.push(
    `- **dB Mode:** ${state.useDecibels ? 'on' : 'off'}`,
    `- **Tone Mapping:** ${state.toneMapEnabled ? 'on' : 'off'}`,
  );

  if (state.toneMapEnabled) {
    lines.push(`- **Tone Map Method:** ${state.toneMapMethod}`);
    lines.push(`- **Tone Map Gamma:** ${state.toneMapGamma.toFixed(2)}`);
    lines.push(`- **Tone Map Strength:** ${state.toneMapStrength.toFixed(2)}`);
  }

  lines.push(`- **View:** [${state.view.center[0].toFixed(4)}, ${state.view.center[1].toFixed(4)}], zoom ${state.view.zoom.toFixed(2)}`);

  return lines.join('\n');
}

// CollapsibleSection was defined here and used 21 times; W028 promoted it
// verbatim to src/components/ui/Section.jsx (which also absorbed
// MetadataPanel's private copy) and gave it a keyboard-operable heading.
// The alias keeps the 21 call sites reading the way they always did.
const CollapsibleSection = Section;

// Activity rail groups — each id gates a cluster of control sections in the
// panel (one group visible at a time, VS Code activity-bar style).
const RAIL_GROUPS = [
  { id: 'data', title: 'Data', icon: 'database' },
  { id: 'display', title: 'Display', icon: 'sliders' },
  { id: 'analysis', title: 'Analyze', icon: 'target' },
  { id: 'layers', title: 'Layers', icon: 'layers' },
  { id: 'export', title: 'Export', icon: 'share' },
];

/**
 * Compute a synthetic per-channel histogram using a log-normal model with
 * log-spaced bins.  SAR power is log-normal: uniform bins in log space turn
 * the distribution into a symmetric Gaussian bell.  Linear bins over
 * [min, max] compress almost all data into the leftmost few pixels.
 *
 * Returns logX:true so ChannelHistogram positions limit lines in log space.
 */
function computeLogNormalHist(mean, std, numBins = 128, syntheticCount = 100000) {
  const cv2 = (std * std) / (mean * mean);
  const sigmaLog = Math.sqrt(Math.log(1 + cv2));
  const muLog = Math.log(mean) - 0.5 * sigmaLog * sigmaLog;

  // ±3.5 σ in log space — covers >99.9 % of the distribution and keeps the
  // bell well-centred in the panel without extreme tails dominating.
  const loLog = muLog - 3.5 * sigmaLog;
  const hiLog = muLog + 3.5 * sigmaLog;
  const logBinWidth = (hiLog - loLog) / numBins;
  const sq2pi = Math.sqrt(2 * Math.PI);
  const bins = new Array(numBins).fill(0);
  for (let b = 0; b < numBins; b++) {
    // In log space the log-normal PDF is just a Gaussian
    const logX = loLog + (b + 0.5) * logBinWidth;
    const z = (logX - muLog) / sigmaLog;
    bins[b] = Math.round(syntheticCount * Math.exp(-0.5 * z * z) / (sigmaLog * sq2pi) * logBinWidth);
  }
  // Log-normal quantiles: Φ⁻¹(0.02) ≈ −2.054, Φ⁻¹(0.98) ≈ +2.054
  const p2  = Math.exp(muLog - 2.054 * sigmaLog);
  const p98 = Math.exp(muLog + 2.054 * sigmaLog);
  return {
    bins,
    min: Math.exp(loLog), max: Math.exp(hiLog),  // linear, used only for slider bounds
    logMin: loLog, logMax: hiLog,                 // log range, used for bar/limit rendering
    logX: true,                                   // tells renderer to position in log space
    mean, count: syntheticCount, p2, p98,
  };
}

/**
 * Banner shown only on the GitHub Pages deployment, pointing users at
 * `npm run dev` for features that need the dev-server CORS proxy
 * (Earthdata-authenticated NISAR streaming, some STAC endpoints).
 * Dismissible; remembered in localStorage.
 */
// ─── W030: load-progress + empty-state copy ─────────────────────────────────

/** Human label for the current load phase. */
function loadPhaseLabel(detail) {
  switch (detail?.phase) {
    case 'opening':  return 'Opening file';
    case 'metadata': return 'Reading metadata';
    case 'index':    return 'Building chunk index';
    case 'chunks':   return detail.fromCache ? 'Reading cached chunks' : 'Streaming chunks';
    case 'done':     return 'Ready';
    default:         return 'Loading';
  }
}

/** "142 / 380 chunks · 412 MB" — the counts, not just a percentage. */
function loadDetailText(pct, detail) {
  const rounded = `${Math.round(pct)}%`;
  if (!detail || detail.chunksTotal <= 0) return rounded;
  const parts = [`${detail.chunksDone} / ${detail.chunksTotal} chunks`];
  if (detail.bytes > 0) {
    const mb = detail.bytes / (1024 * 1024);
    parts.push(mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`);
  }
  // A warm L2 (IndexedDB) cache means no network fetch happened — saying so
  // keeps a near-instant reload from looking like a broken progress bar.
  if (detail.cachedChunks > 0) {
    parts.push(detail.fromCache ? 'from cache' : `${detail.cachedChunks} cached`);
  }
  return `${rounded} · ${parts.join(' · ')}`;
}

/** What to do next, per source — instructions, not a description of the app. */
const EMPTY_STATE_HINTS = {
  nisar: 'Drop a NISAR L2 GCOV .h5 file here, or paste a URL to one. Nothing uploads — it streams from your disk (or by HTTP range) straight to the GPU.',
  'local-tif': 'Drop one or more SAR GeoTIFFs here, or choose them below. Multiple files load as a mosaic.',
  remote: 'Paste a direct URL to a GCOV granule or a Cloud Optimized GeoTIFF. Only the chunks in view are fetched.',
  cog: 'Paste a URL to a Cloud Optimized GeoTIFF. Only the tiles in view are fetched.',
  catalog: 'Load a GeoJSON scene catalog, then pick a scene from it.',
  cmr: 'Search NASA CMR for a granule, pick one, then load a dataset from it.',
};

/**
 * Deep link to the hosted hero scene (Pacaya-Samiria floodplain, dual-pol
 * L-band RGB). Same parameters as the README hero image, so the demo the docs
 * advertise is one click from the empty viewer.
 */
const HERO_DEMO_QUERY = '?cog=https%3A%2F%2Fhuggingface.co%2Fdatasets%2Fnicksteiner%2Fsardine-demo-data%2Fresolve%2Fmain%2Fpacaya_full_hh.tif,https%3A%2F%2Fhuggingface.co%2Fdatasets%2Fnicksteiner%2Fsardine-demo-data%2Fresolve%2Fmain%2Fpacaya_full_hv.tif&comp=dual-pol-h&mode=rgb&db=1&stretch=sigmoid&c=12233,7038&z=-1.5';

function PagesBanner() {
  const isPages = import.meta.env.VITE_DEPLOY_TARGET === 'github-pages';
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('sardine.pages-banner.dismissed') === '1'; } catch { return false; }
  });
  if (!isPages || dismissed) return null;
  const close = () => {
    setDismissed(true);
    try { localStorage.setItem('sardine.pages-banner.dismissed', '1'); } catch {}
  };
  return (
    <div className="pages-banner">
      <strong className="u-accent">SARdine</strong>{' '}
      runs entirely in your browser — drop a GeoTIFF, NISAR HDF5, or GeoJSON file to start.{' '}
      Earthdata-authenticated streaming and the STAC catalog browser need the local dev server (
      <a href="https://github.com/nicksteiner/sardine#getting-started" target="_blank" rel="noopener noreferrer" className="u-accent">
        npm run dev
      </a>
      ).
      <CloseButton onClick={close} label="Dismiss" className="pages-banner__close" />
    </div>
  );
}

/**
 * SARdine - SAR Data INspection and Exploration
 * Phase 1: Basic Viewer + Phase 2: State as Markdown
 */
function App() {
  // UI theme: '' (dark, default) | 'sardine' (navy) | 'light'
  const [uiTheme, setUiTheme] = useState(() => {
    try {
      const t = localStorage.getItem('sardine.theme');
      return t === 'sardine' || t === 'light' ? t : '';
    } catch { return ''; }
  });
  useEffect(() => {
    if (uiTheme) document.documentElement.dataset.theme = uiTheme;
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('sardine.theme', uiTheme); } catch {}
  }, [uiTheme]);

  // GPU capability detection (cached, runs once)
  const gpuInfo = useMemo(() => probeGPU(), []);

  // Worker pool state
  const workerInfo = useMemo(() => getWorkerPoolInfo(), []);
  const [workerCount, setWorkerCount] = useState(workerInfo.size);

  // Unified load mode — single selector replaces old format × source matrix
  const [fileType, setFileType] = useState('nisar'); // 'nisar' | 'local-tif' | 'remote' | 'cog' | 'catalog' | 'cmr'
  const [cogUrl, setCogUrl] = useState('');
  // Deep-link multi-band RGB COG load request: {urls: string[], compositeId}
  // (?cog=hh.tif,hv.tif&comp=dual-pol-h) — consumed by an effect below.
  const [cogRgbRequest, setCogRgbRequest] = useState(null);
  const [imageData, setImageData] = useState(null);
  const [tileVersion, setTileVersion] = useState(0); // bumped on progressive tile refinement
  // Tiles currently streaming. The viewport histogram calls getTile itself, so
  // recomputing while tiles are still arriving competes with the load for chunk
  // fetches and decode workers — and the result is stale the moment the next
  // tile lands. Wait for streaming to settle instead.
  const [tilesLoading, setTilesLoading] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  // W030: the counts behind the bar — {phase, chunksDone, chunksTotal, bytes,
  // cachedChunks, fromCache}. "142 / 380 chunks · 412 MB" tells a SAR user more
  // than a percentage, and a warm L2 reload must not imply a network fetch.
  const [loadDetail, setLoadDetail] = useState(null);

  // W030: errors accumulate instead of overwriting each other. A dozen async
  // paths used to race on one string, so the last failure to land was the only
  // one anybody saw. setError(msg) is kept as-is for the ~32 existing call
  // sites; setError(null) still clears, which is the established "starting a
  // load" idiom.
  const [errors, setErrors] = useState([]);
  const errorIdRef = useRef(0);
  const setError = useCallback((message) => {
    if (message == null) { setErrors([]); return; }
    const text = String(message);
    setErrors(prev => {
      // Repeated identical failures (a retried tile, a re-entered effect) stack
      // a count rather than a wall of duplicates.
      const existing = prev.findIndex(e => e.message === text);
      if (existing >= 0) {
        const next = prev.slice();
        next[existing] = { ...next[existing], count: next[existing].count + 1, at: Date.now() };
        return next;
      }
      const entry = { id: ++errorIdRef.current, message: text, count: 1, at: Date.now() };
      return [...prev, entry].slice(-5); // oldest fall off; five is already a lot
    });
  }, []);
  const dismissError = useCallback((id) => {
    setErrors(prev => prev.filter(e => e.id !== id));
  }, []);
  // Most-recent error, for the many `!error` / `error &&` guards downstream.
  const error = errors.length > 0 ? errors[errors.length - 1].message : null;

  // Load generation counter — incremented on each new load to discard stale results
  const loadGenRef = useRef(0);

  // Forward-ref to handleRemoteFileSelect so the share-link effect (which runs
  // before that handler is defined) can call it after mount.
  const handleRemoteFileSelectRef = useRef(null);
  // Same idea for the NITF handler, so ?nitf=<url> can dispatch into it after
  // mount via a URLFile adapter.
  const handleNITFFileSelectRef = useRef(null);
  // And for VRTs, which ride the COG URL path: handleLoadCOG (defined before
  // the VRT handler) hands .vrt URLs over through this ref.
  const handleLoadVRTRef = useRef(null);
  // Folders the user granted for local VRT sources (picked or dropped), most
  // recent first. Kept for the session so every VRT from the same archive
  // resolves without asking again.
  const vrtSourceFoldersRef = useRef([]);
  // {file, companions, missing, total} while a local VRT waits for its source folder
  const [vrtSourcePrompt, setVrtSourcePrompt] = useState(null);

  // Remote source state
  const [remoteUrl, setRemoteUrl] = useState(null);
  const [remoteName, setRemoteName] = useState(null);
  const [directUrl, setDirectUrl] = useState('');
  // Raw (un-proxied) URL of the currently-loaded remote source. Kept separately
  // so the "Copy share link" button hands out the original DAAC URL rather
  // than a proxy-rewritten one that would only work with this user's token.
  const [sharedRawUrl, setSharedRawUrl] = useState(null);

  // NISAR-specific state
  const [nisarFile, setNisarFile] = useState(null);
  const [nisarDatasets, setNisarDatasets] = useState([]);
  const [selectedFrequency, setSelectedFrequency] = useState('B');
  const [selectedPolarization, setSelectedPolarization] = useState('HHHH');

  // NISAR product type detection (auto-detected on file open)
  const [nisarProductType, setNisarProductType] = useState('GCOV'); // 'GCOV' | 'GUNW'

  // GUNW-specific state
  const [gunwDatasets, setGunwDatasets] = useState(null); // listNISARGUNWDatasets result
  const [selectedLayer, setSelectedLayer] = useState('unwrappedInterferogram');
  const [selectedGunwDataset, setSelectedGunwDataset] = useState('unwrappedPhase');
  const [useCoherenceMask, setUseCoherenceMask] = useState(false);
  const [coherenceThreshold, setCoherenceThreshold] = useState(0.3);
  const [losDisplacement, setLosDisplacement] = useState(false); // radians → meters
  const [verticalDisplacement, setVerticalDisplacement] = useState(false); // LOS → vertical via cos(θ)
  const [gunwIncidenceAngleGrid, setGunwIncidenceAngleGrid] = useState(null); // {data, width, height}
  const [gunwPairedView, setGunwPairedView] = useState(null); // {left, right} image configs for ComparisonViewer

  // Compare grid — up to 4 GeoTIFFs in an adaptive grid, synced pan/zoom.
  const [compareMode, setCompareMode] = useState(false);
  const [compareInitialFiles, setCompareInitialFiles] = useState(null); // files to seed the grid on open
  const [compareInitialUrls, setCompareInitialUrls] = useState(null); // ?compare= URLs to seed the grid on open
  const [compareInitialBbox, setCompareInitialBbox] = useState(null); // ?bbox=/?wkt= WGS84 region to fit the grid to
  const compareGridRef = useRef(null);

  // GUNW phase corrections — individual layers uploaded to GPU as separate textures
  const [correctionLayers, setCorrectionLayers] = useState(null); // {ionosphere, troposphereWet, ...}
  const [enabledCorrections, setEnabledCorrections] = useState(new Set()); // Set of enabled correction keys
  // rampCoefficients state removed — planar ramp correction removed

  // NITF state — multi-image NITF support via DatasetPicker
  const [nitfFile, setNitfFile] = useState(null);
  const [nitfDatasets, setNitfDatasets] = useState([]);
  const [selectedNitfId, setSelectedNitfId] = useState(null);

  // COG state — multi-band TIFs surface a band picker via DatasetPicker
  const [cogDatasets, setCogDatasets] = useState([]);
  const [selectedCogId, setSelectedCogId] = useState(null);

  // Drag-and-drop state
  const [dragOver, setDragOver] = useState(false);

  // RGB composite state
  const [displayMode, setDisplayMode] = useState('single'); // 'single' | 'rgb' | 'multi-temporal'
  const [compositeId, setCompositeId] = useState(null);
  const [availableComposites, setAvailableComposites] = useState([]);

  // Scalar-index state (RVI, etc.) — displayMode === 'index'
  const [availableIndices, setAvailableIndices] = useState([]);
  const [indexId, setIndexId] = useState('rvi');
  const [indexForm, setIndexForm] = useState('dual');

  // True for any RGB-flavoured display mode (standard composite or multi-temporal)
  const isRGBDisplayMode = displayMode === 'rgb' || displayMode === 'multi-temporal';

  // Per-channel contrast for RGB mode (linear values)
  const [rgbContrastLimits, setRgbContrastLimits] = useState(null);
  // Histogram data: {single: stats} or {R: stats, G: stats, B: stats}
  const [histogramData, setHistogramData] = useState(null);

  // Multi-file state (COG multi-band / temporal)
  const [multiFileMode, setMultiFileMode] = useState(false);
  const [multiFileModeType, setMultiFileModeType] = useState('multi-band'); // 'multi-band' or 'temporal'
  const [fileList, setFileList] = useState(['']); // Array of URLs
  const [bandNames, setBandNames] = useState([]); // Auto-detected or manual

  // Multi-temporal RGB: same dataset from 3 separate NISAR files → R / G / B
  const [nisarFile2, setNisarFile2] = useState(null);
  const [nisarFile3, setNisarFile3] = useState(null);

  // Mosaic: list of local TIF files currently in the active mosaic.
  // When length > 1 these files are loaded together via loadLocalTIFs,
  // which produces a single Float32 raster with union bounds. Adding /
  // removing a file rebuilds the mosaic.
  const [mosaicFiles, setMosaicFiles] = useState([]);

  // GCOV mosaic: secondary NISAR GCOV files rendered alongside the primary.
  // Each entry is a File. Render layers are derived from these by an effect
  // that re-loads whenever the primary frequency/polarization changes.
  const [gcovMosaicFiles, setGcovMosaicFiles] = useState([]);
  // Render-ready handles: [{id, label, getTile, bounds, crs, width, height}]
  const [gcovMosaicLayers, setGcovMosaicLayers] = useState([]);

  // Drop the mosaic file list whenever the active source type leaves local-tif.
  // imageData is reset by the relevant handlers; we just keep the file list
  // consistent so the UI doesn't show a stale mosaic count.
  useEffect(() => {
    if (fileType !== 'local-tif' && mosaicFiles.length > 0) {
      setMosaicFiles([]);
    }
  }, [fileType, mosaicFiles.length]);

  // Drop the GCOV mosaic when the active source type leaves NISAR GCOV.
  useEffect(() => {
    if (fileType !== 'nisar' && (gcovMosaicFiles.length > 0 || gcovMosaicLayers.length > 0)) {
      setGcovMosaicFiles([]);
      setGcovMosaicLayers([]);
    }
  }, [fileType, gcovMosaicFiles.length, gcovMosaicLayers.length]);

  // Viewer settings
  const [colormap, setColormap] = useState('grayscale');
  const [reverseColormap, setReverseColormap] = useState(false);
  const [useDecibels, setUseDecibels] = useState(true);
  // GUNW data is in radians/meters — dB conversion is never valid.
  // Scalar indices (RVI, etc.) are linear ratios — dB is never valid either.
  const effectiveUseDecibels = (nisarProductType === 'GUNW' || displayMode === 'index') ? false : useDecibels;
  const [showGrid, setShowGrid] = useState(false);
  const [pixelExplorer, setPixelExplorer] = useState(false);
  const [pixelWindowSize, setPixelWindowSize] = useState(1);
  // Analytical / medical-imaging mode — black void, NEAREST filter, drag-to-W/L,
  // persistent readout, σ-stretch presets, integer zoom snaps. Toggled with 'M'.
  const [medicalMode, setMedicalMode] = useState(false);
  const [medicalInverted, setMedicalInverted] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Activity rail: which control-panel group is showing, whether the panel
  // is visible at all (desktop collapse), and the mobile bottom-sheet detent.
  const [activePanel, setActivePanel] = useState('data');
  const [panelOpen, setPanelOpen] = useState(true);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  // Viewer context menu (right-click / long-press): {x, y} or null
  const [contextMenu, setContextMenu] = useState(null);
  const [contrastMin, setContrastMin] = useState(-25);
  const [contrastMax, setContrastMax] = useState(0);
  const [gamma, setGamma] = useState(1.0);
  const [rgbSaturation, setRgbSaturation] = useState(1.0);
  const [colorblindMode, setColorblindMode] = useState('off');
  // Attribution stamp for PNG exports. Processor defaults to Nick Steiner but
  // any user can override; both vendor and processor persist in localStorage.
  const [attributionEnabled, setAttributionEnabled] = useState(false);
  // Figure export theme: 'publication' (light, default) or 'dark' (presentation).
  const [figureTheme, setFigureTheme] = useState(() => {
    try { return localStorage.getItem('sardine.figureTheme') || 'publication'; } catch { return 'publication'; }
  });
  // Figure coordinate grid: 'lines' (full gridlines), 'ticks' (edge ticks +
  // labels only), or 'off'.
  const [figureGridMode, setFigureGridMode] = useState(() => {
    try { return localStorage.getItem('sardine.figureGrid') || 'lines'; } catch { return 'lines'; }
  });
  // Custom colorbar caption for figure exports; empty → auto ('dB' / 'linear').
  const [colorbarLabel, setColorbarLabel] = useState(() => {
    try { return localStorage.getItem('sardine.colorbarLabel') || ''; } catch { return ''; }
  });
  const [attributionVendor, setAttributionVendor] = useState(() => {
    try { return localStorage.getItem('sardine.attribution.vendor') || ''; } catch { return ''; }
  });
  const [attributionProcessor, setAttributionProcessor] = useState(() => {
    try { return localStorage.getItem('sardine.attribution.processor') || ''; } catch { return ''; }
  });
  // Earthdata Login proxy settings — required on the hosted Pages build for
  // streaming NASA DAAC data (NISAR, Sentinel-1 via ASF, OPERA via PO.DAAC).
  // No-op in dev (the Vite dev plugin handles CORS without auth).
  const [edlProxyUrl, setEdlProxyUrl] = useState(() => getProxyUrl());
  const [edlToken, setEdlTokenState] = useState(() => getEDLToken());
  const [edlValidation, setEdlValidation] = useState(null); // {ok, username}|{ok:false,error}|null
  const [edlValidating, setEdlValidating] = useState(false);

  // Annotations — arrows + text labels drawn over the viewer and into PNG exports
  const [annotations, setAnnotations] = useState([]);
  const [annotationMode, setAnnotationMode] = useState('off');     // 'off'|'arrow'|'text'
  const [annotationColor, setAnnotationColor] = useState('red');  // see ANNOTATION_COLOR_KEYS
  const [annotationSize, setAnnotationSize] = useState('medium');  // small|medium|large
  const [selectedAnnotationId, setSelectedAnnotationId] = useState(null);
  const [stretchMode, setStretchMode] = useState('linear');
  const [multiLook, setMultiLook] = useState(false);
  const [maskInvalid, setMaskInvalid] = useState(false);
  const [maskLayoverShadow, setMaskLayoverShadow] = useState(false);
  const [useIncidenceAngleMask, setUseIncidenceAngleMask] = useState(false);
  const [incAngleMin, setIncAngleMin] = useState(30);  // degrees
  const [incAngleMax, setIncAngleMax] = useState(47);  // degrees
  const [incidenceAngleGrid, setIncidenceAngleGrid] = useState(null); // {data, width, height}
  const [incidenceScatterData, setIncidenceScatterData] = useState(null);
  const [speckleFilterType, setSpeckleFilterType] = useState('none'); // 'none' | 'boxcar' | 'lee' | 'enhanced-lee' | 'frost' | 'gamma-map'
  const [speckleKernelSize, setSpeckleKernelSize] = useState(7);      // 3, 5, 7, 9, 11
  const [exportMultilookWindow, setExportMultilookWindow] = useState(4); // Multilook window for export (1, 2, 4, 8, 16)
  const [exportMode, setExportMode] = useState('raw'); // 'raw' (Float32) | 'rendered' (RGBA with dB/colormap)
  const [roi, setROI] = useState(null); // ROI rectangle { left, top, width, height } in image pixels, or null
  const [roiProfile, setRoiProfile] = useState(null); // Computed profile data for ROIProfilePlot
  const [roiRGBData, setRoiRGBData] = useState(null);       // RGB composite data loaded for ROI overlay
  const [roiRGBBounds, setRoiRGBBounds] = useState(null);   // [minX,minY,maxX,maxY] world coords for ROI RGB
  const [roiRGBLoading, setRoiRGBLoading] = useState(false);
  const [roiCompositeId, setRoiCompositeId] = useState(null); // composite preset for ROI RGB overlay
  const [roiRGBContrastLimits, setRoiRGBContrastLimits] = useState(null); // per-channel {R,G,B} contrast for ROI overlay
  const [roiRGBHistogramData, setRoiRGBHistogramData] = useState(null); // histogram data for ROI RGB viewer
  const [activeViewer, setActiveViewer] = useState('main'); // 'main' | 'roi-rgb' | 'roi-ts' — which viewer the sidebar controls

  // ROI Time-Series state
  const [roiTSFiles, setRoiTSFiles] = useState([]);           // Array of File objects for time-series
  const [roiTSFrames, setRoiTSFrames] = useState(null);       // [{getTile, bounds, label, date, identification}, ...]
  const [roiTSBounds, setRoiTSBounds] = useState(null);       // [minX,minY,maxX,maxY] world coords for ROI
  const [roiTSLoading, setRoiTSLoading] = useState(false);
  const [roiTSIndex, setRoiTSIndex] = useState(0);            // Current frame index
  const [roiTSPlaying, setRoiTSPlaying] = useState(false);    // Animation playing
  const [roiTSContrastLimits, setRoiTSContrastLimits] = useState(null); // [min, max] shared across frames
  const [roiTSHistogramData, setRoiTSHistogramData] = useState(null);   // Histogram for current frame
  const [wktInput, setWktInput] = useState('');       // WKT text input value
  const [wktError, setWktError] = useState(null);     // WKT validation error message
  const [profileShow, setProfileShow] = useState({ v: true, h: true, i: true }); // V/H/I visibility
  const [transectEnabled, setTransectEnabled] = useState(false); // Free profile-line tool armed
  const [transectLine, setTransectLine] = useState(null);        // { x0, y0, x1, y1 } image px
  const [transectData, setTransectData] = useState(null);        // { dist, values, lenPx, angleDeg }
  const [transectWidth, setTransectWidth] = useState(0);         // perpendicular half-width (px); 0 = centerline

  // Feature space classifier state
  const [classifierOpen, setClassifierOpen] = useState(false);
  const [classRegions, setClassRegions] = useState([]); // [{name, color, xMin, xMax, yMin, yMax}]
  const [classifierData, setClassifierData] = useState(null); // {x: Float32Array, y: Float32Array, valid: Uint8Array, w, h}
  const [classifierBands, setClassifierBands] = useState({ x: 'HHHH', y: 'HVHV' });
  const [classificationMap, setClassificationMap] = useState(null); // Uint8Array per ROI pixel

  // ── Model plugins (W025) ──────────────────────────────────────────
  const modelRegistry = useMemo(() => createModelRegistry(), []);
  const [modelListVersion, setModelListVersion] = useState(0);
  const modelList = useMemo(() => modelRegistry.list(), [modelRegistry, modelListVersion]);
  const [modelBusyId, setModelBusyId] = useState(null);
  const [modelProgress, setModelProgress] = useState(null); // {phase, done, total}
  const [modelRunInfo, setModelRunInfo] = useState(null);   // {id, ep, weightsFrom, elapsedMs}
  const [modelPreview, setModelPreview] = useState(null);   // {before, after, width, height}
  const [modelOverlay, setModelOverlay] = useState(null);   // {map, dims:{w,h}, regions}
  const [headManifest, setHeadManifest] = useState(null);
  const [headMetrics, setHeadMetrics] = useState(null);
  const [liveFit, setLiveFit] = useState(false);
  const modelAbortRef = useRef(null);
  const [classifierRoiDims, setClassifierRoiDims] = useState(null); // {w, h} of classifier grid
  const [incidenceRange, setIncidenceRange] = useState([0, 90]); // min/max incidence angle filter (degrees)

  const [histogramScope, setHistogramScope] = useState('global'); // 'global' | 'viewport' | 'roi'
  const [showHistogramOverlay, setShowHistogramOverlay] = useState(false);
  const [viewCenter, setViewCenter] = useState([0, 0]);
  const [viewZoom, setViewZoom] = useState(0);
  const prevBoundsRef = useRef(null); // Track previous data bounds for view-lock

  // Tone mapping settings — hidden, see tone mapping NOTE in JSX below
  // const [toneMapEnabled, setToneMapEnabled] = useState(false);
  // const [toneMapMethod, setToneMapMethod] = useState('auto');
  // const [toneMapGamma, setToneMapGamma] = useState(0.5);
  // const [toneMapStrength, setToneMapStrength] = useState(0.3);

  // Markdown state
  const [markdownState, setMarkdownState] = useState('');
  const [isMarkdownEdited, setIsMarkdownEdited] = useState(false);

  // Scene catalog overlay layers (from SceneCatalog component)
  const [catalogLayers, setCatalogLayers] = useState([]);

  // STAC search overlay layers
  const [stacLayers, setStacLayers] = useState([]);

  // Dropped GeoJSON overlay data and popup state
  const [droppedGeoJSON, setDroppedGeoJSON] = useState([]);  // array of {id, name, data}
  const [geojsonPopup, setGeojsonPopup] = useState(null);    // {x, y, properties, geometry}

  // CMR footprints for OverviewMap (lat/lon geometry from CMR search results)
  const [cmrFootprints, setCmrFootprints] = useState([]);
  // Earthdata token shared between NISARSearch and OverviewMap footprint clicks
  const [earthdataToken, setEarthdataToken] = useState('');
  // Overview map visible extent for CMR bbox filtering [west, south, east, north]
  const [overviewBounds, setOverviewBounds] = useState(null);

  // Overture Maps overlay state
  const [overtureEnabled, setOvertureEnabled] = useState(false);
  const [overtureThemes, setOvertureThemes] = useState(['transportation', 'buildings', 'base_water']); // enabled themes
  const [overtureData, setOvertureData] = useState(null);
  const [overtureLoading, setOvertureLoading] = useState(false);
  const [overtureOpacity, setOvertureOpacity] = useState(0.7);
  const overtureDebounceRef = useRef(null);

  // Optical Peek overlay state — uses the warp-grid GPU pathway in OpticalPeekLayer
  const [opticalPeekEnabled, setOpticalPeekEnabled] = useState(false);
  const [opticalPeekProvider, setOpticalPeekProvider] = useState('esri');
  const [opticalPeekOpacity, setOpticalPeekOpacity] = useState(0.7);

  // Memoize initialViewState to prevent infinite re-renders
  const initialViewState = useMemo(
    () => ({
      target: viewCenter,
      zoom: viewZoom,
    }),
    [viewCenter, viewZoom]
  );
  const markdownUpdateRef = useRef(false);
  const viewerRef = useRef(null);
  const roiRGBViewerRef = useRef(null);
  const roiTSViewerRef = useRef(null);

  // Status window state
  const [statusLogs, setStatusLogs] = useState([]);
  const [statusCollapsed, setStatusCollapsed] = useState(true);
  const [bottomTab, setBottomTab] = useState('status'); // active tab in the lower dock
  useEffect(() => { if (!transectEnabled && bottomTab === 'transect') setBottomTab('status'); }, [transectEnabled, bottomTab]);

  // Overview map state
  const [overviewMapVisible, setOverviewMapVisible] = useState(false);
  const [satelliteMapVisible, setSatelliteMapVisible] = useState(false);

  // Clear ROI and classifier when image data changes (new file/dataset loaded).
  // Exception (W016): when a deep-link region was just applied for this very
  // load, keep the ROI/WKT — applyDeepLinkRoi sets them moments before
  // setImageData commits, and this effect would otherwise wipe them.
  useEffect(() => {
    if (consumeDeepLinkPin('roi')) {
      // Keep ROI + WKT from the deep link; still reset the classifier state
      // below (it belongs to the previous scene either way).
    } else {
      setROI(null);
      setRoiProfile(null);
      setWktInput('');
      setWktError(null);
    }
    setClassifierOpen(false);
    setClassRegions([]);
    setClassifierData(null);
    setClassificationMap(null);
    setClassifierRoiDims(null);
    setRoiRGBData(null);
    setRoiRGBBounds(null);
    setRoiCompositeId(null);
    setRoiRGBContrastLimits(null);
    setRoiRGBHistogramData(null);
    setRoiTSFiles([]);
    setRoiTSFrames(null);
    setRoiTSBounds(null);
    setRoiTSContrastLimits(null);
    setRoiTSHistogramData(null);
    setRoiTSPlaying(false);
    setRoiTSIndex(0);
    setActiveViewer('main');
  }, [imageData]);

  // Deep-link support (W008): ?url=<remote .h5/.tif/.ntf> (type inferred from
  // extension) or explicit ?cog=/?nisar=/?nitf= auto-loads on mount, plus
  // optional render params in short (cmap, min, max, db, …) or long
  // (colormap, contrastMin, contrastMax, useDecibels, …) form. See
  // src/utils/deep-link.js for the full schema and docs/DEEP_LINKS.md.
  //
  // The recipient still needs to paste their own EDL token if the link points
  // at a DAAC URL — tokens never travel in share links.
  //
  // W017: ?bbox=/?wkt= WITHOUT a data param resolves its own granule via CMR
  // spatial search (granule-resolve.js) and feeds the winner through the same
  // NISAR staging path (stageNisarUrl below). Optional t=/col= refine it.
  const urlCogTriggered = useRef(false);
  const [shareLinkPending, setShareLinkPending] = useState(false);
  // Fields the deep link pinned explicitly. The load handlers auto-derive
  // contrast / pol / freq / view-fit after data arrives, which would clobber
  // the pinned values — each guarded site consumes its pin (one-shot) so the
  // first post-load derivation is suppressed and later loads behave normally.
  const deepLinkPins = useRef(new Set());
  const consumeDeepLinkPin = useCallback((field) => deepLinkPins.current.delete(field), []);
  // W016: deep-link spatial subset (?bbox=/?wkt=), staged until the raster
  // loads. One-shot like the pins: applyDeepLinkRoi consumes it. The loader
  // reads it (pre-consumption) to scope chunk prefetch to the region.
  const deepLinkRoiRef = useRef(null);
  // W016: a bbox/wkt deep link bounds the fetch to the region, so the
  // click-to-load guard (NISAR files are large) doesn't apply — auto-load.
  const deepLinkAutoLoad = useRef(false);
  const handleLoadRemoteNISARRef = useRef(null);
  useEffect(() => {
    const { dataUrl, dataUrls, dataType, view, compare, localFile } = parseShareLink();

    // Multi-panel compare link (?compare=): open the synced grid and seed its
    // panels from the URL list. Same-origin/CORS-friendly COG URLs load
    // directly; others route through the shared proxy so hosted builds work.
    if (Array.isArray(compare) && compare.length > 0) {
      setCompareInitialUrls(compare.map(({ url, label }) => ({ url: proxyUrlShared(url), label })));
      // ?bbox=/?wkt= apply to compare links too — the grid reprojects the WGS84
      // bbox into each panel's CRS and fits the shared view to it. Without this
      // the region params parse fine and are then silently dropped.
      if (Array.isArray(view.roiBbox)) setCompareInitialBbox(view.roiBbox);
      setCompareMode(true);
      addStatusLog?.('info',
        `Opening ${compare.length}-panel compare from link${Array.isArray(view.roiBbox) ? ' (zoomed to bbox)' : ''}`);
      return;
    }

    // W017: spatial params ALONE are a valid link — the granule is resolved
    // from the region via CMR below (region-first deep links).
    const regionOnly = !dataUrl && Array.isArray(view.roiBbox);
    // Local-file state link (?file=): no URL travels — the render/view params
    // are the payload, applied now and pinned so the file load doesn't clobber
    // them; the user drops the named local file to reproduce the view.
    const localOnly = !dataUrl && !regionOnly && !!localFile;
    if (!dataUrl && !regionOnly && !localOnly) return;

    if (Number.isFinite(view.contrastMin) || Number.isFinite(view.contrastMax)) deepLinkPins.current.add('contrast');
    if (view.selectedPolarization) deepLinkPins.current.add('pol');
    if (view.selectedFrequency) deepLinkPins.current.add('freq');
    if (view.compositeId || view.displayMode) deepLinkPins.current.add('comp');
    if (Array.isArray(view.viewCenter) || Number.isFinite(view.viewZoom)) deepLinkPins.current.add('view');
    if (Array.isArray(view.roiBbox)) {
      deepLinkRoiRef.current = {
        bbox: view.roiBbox,               // [w, s, e, n] WGS84
        wkt: view.roiWkt || null,          // original WKT (polygon fidelity for the input)
        // Explicit c/z in the link wins over the region fit.
        fitView: !(Array.isArray(view.viewCenter) || Number.isFinite(view.viewZoom)),
      };
      deepLinkAutoLoad.current = true;    // bounded fetch → skip click-to-load
    }

    // Apply view-state synchronously so the auto-loaded data renders with the
    // sharer's settings the first time the layer mounts.
    if (view.colormap) setColormap(view.colormap);
    if (view.reverseColormap != null) setReverseColormap(view.reverseColormap);
    if (view.useDecibels != null) setUseDecibels(view.useDecibels);
    if (Number.isFinite(view.contrastMin)) setContrastMin(view.contrastMin);
    if (Number.isFinite(view.contrastMax)) setContrastMax(view.contrastMax);
    if (view.stretchMode) setStretchMode(view.stretchMode);
    if (Number.isFinite(view.gamma)) setGamma(view.gamma);
    if (view.selectedPolarization) setSelectedPolarization(view.selectedPolarization);
    if (view.selectedFrequency) setSelectedFrequency(view.selectedFrequency);
    if (Number.isFinite(view.multiLook)) setMultiLook(view.multiLook);
    if (view.compositeId) setCompositeId(view.compositeId);
    if (view.displayMode) setDisplayMode(view.displayMode);
    if (Array.isArray(view.viewCenter)) setViewCenter(view.viewCenter);
    if (Number.isFinite(view.viewZoom)) setViewZoom(view.viewZoom);

    // Local-file state link: state is applied and pinned — nothing to fetch.
    if (localOnly) {
      addStatusLog?.('info', `Link state applied — load local file "${localFile}" to reproduce the view`);
      return;
    }

    // Shared NISAR staging (W008/W016): EDL-token gate on hosted builds, then
    // the same handleRemoteFileSelect path used by the discovery UI. Both an
    // explicit ?nisar=/?url= link and a W017 region-resolved URL end here so
    // token attach + W016 auto-load/chunk-scoping behave identically.
    const stageNisarUrl = (nisarUrl) => {
      const pathOnly = nisarUrl.split('?')[0];
      const name = pathOnly.split('/').pop() || 'shared-nisar';
      if (isHostedBuild() && !getEDLToken()) {
        setShareLinkPending(true);
        addStatusLog?.('warning', 'Share link requires Earthdata Login — paste your token below to continue');
        // Stash the pending URL on a ref so we can fire after the token is set.
        urlCogTriggered.current = { pendingNisar: { url: nisarUrl, name } };
      } else {
        // Defer to the next tick so handleRemoteFileSelect is bound.
        // Attach the stored EDL token — the dev proxy and direct fetches
        // authenticate via the Authorization header, not the proxy URL.
        setTimeout(() => {
          handleRemoteFileSelectRef.current?.({ url: nisarUrl, name, size: 0, type: 'nisar', token: getEDLToken() });
        }, 0);
      }
    };

    if (dataType === 'cog') {
      urlCogTriggered.current = true;
      setFileType('cog');
      // Pre-proxy if needed (share links carry raw URLs; loaders need proxy).
      setSharedRawUrl(dataUrl);
      if (Array.isArray(dataUrls) && dataUrls.length >= 2) {
        // Multi-band RGB COG list (?cog=hh.tif,hv.tif&comp=dual-pol-h):
        // assembled into one RGB composite by the cogRgbRequest effect.
        setCogRgbRequest({ urls: dataUrls, compositeId: view.compositeId || 'dual-pol-h' });
      } else {
        setCogUrl(proxyUrlShared(dataUrl));
      }
    } else if (dataType === 'nitf') {
      // NITF/SICD via HTTP Range. Build a URLFile and hand it to the existing
      // local-file handler so the rest of the load flow (datasets, picker,
      // render) stays identical to drag-drop.
      setSharedRawUrl(dataUrl);
      setFileType('nitf');
      const resolved = proxyUrlShared(dataUrl);
      const pathOnly = dataUrl.split('?')[0];
      const name = pathOnly.split('/').pop() || 'shared.ntf';
      setTimeout(async () => {
        try {
          const urlFile = await URLFile.open(resolved);
          urlFile.name = name;
          handleNITFFileSelectRef.current?.(urlFile);
        } catch (e) {
          addStatusLog?.('error', `Failed to open shared NITF: ${e.message}`);
        }
      }, 0);
    } else if (dataType === 'nisar') {
      // DAAC URLs need an EDL token on hosted builds. If we have one already,
      // route through the same handler used by the discovery UI. If not, park
      // the URL in state and open the EDL panel so the user can paste a token.
      stageNisarUrl(dataUrl);
    } else if (regionOnly) {
      // W017: region-first link — resolve the granule from the bbox via CMR
      // spatial search, then feed the winner through the exact same staging
      // as an explicit ?nisar= link (EDL gate + W016 auto-load included).
      const bbox = view.roiBbox;
      addStatusLog?.('info', `Region link: searching CMR for NISAR GCOV granules over [${bbox.join(', ')}]`,
        view.dateRange ? `Date range: ${view.dateRange.start || '…'}/${view.dateRange.end || '…'}` : null);
      (async () => {
        try {
          const candidates = await resolveGranulesForBbox(bbox, {
            dateRange: view.dateRange || null,
            collections: view.collection ? [view.collection] : undefined,
          });
          const top = candidates[0];
          const listing = candidates.slice(0, 5).map((c, i) =>
            `${i + 1}. ${c.granuleId} — ${c.coveragePct.toFixed(0)}% coverage`
            + `${c.fullFrame ? ', full-frame' : ''}${c.polMode ? `, ${c.polMode}` : ''}`
            + `${c.startTime ? `, ${String(c.startTime).slice(0, 10)}` : ''}`).join('\n');
          addStatusLog?.('info', `Region link: ${candidates.length} candidate granule(s) ranked`, listing);
          const nearTie = candidates.length > 1
            && (top.coveragePct - candidates[1].coveragePct) < 1;
          if (top.coveragePct < 90) {
            addStatusLog?.('warning',
              `Region link: best candidate covers only ${top.coveragePct.toFixed(0)}% of the region — auto-loading ${top.name}`,
              'Pin a specific granule with ?nisar=<url> (or narrow with t=/col=) for a different pick');
          } else if (nearTie) {
            addStatusLog?.('info',
              `Region link: multiple granules cover the region — picked ${top.name}`,
              'Tie broken by full-frame > dual-pol (DHDH) > newest; pin with ?nisar=<url> to override');
          } else {
            addStatusLog?.('success',
              `Region link: resolved to ${top.name} (${top.coveragePct.toFixed(0)}% coverage, ${top.collection})`);
          }
          stageNisarUrl(top.url);
        } catch (e) {
          addStatusLog?.('error', `Region link: granule resolution failed — ${e.message}`);
          setError(`Region link: ${e.message}`);
        }
      })();
    }

    // Don't clear the params yet — keep them in the URL until the data has
    // loaded so the user can refresh. We strip them after a successful load
    // (see effect tied to imageData below).
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select classifier bands when datasets change
  useEffect(() => {
    if (nisarDatasets.length < 2) return;
    const pols = nisarDatasets.map(d => d.polarization);
    if (pols.includes('HHHH') && pols.includes('HVHV')) {
      setClassifierBands({ x: 'HHHH', y: 'HVHV' });
    } else if (pols.includes('VVVV') && pols.includes('VHVH')) {
      setClassifierBands({ x: 'VVVV', y: 'VHVH' });
    } else if (pols.length >= 2) {
      setClassifierBands({ x: pols[0], y: pols[1] });
    }
  }, [nisarDatasets]);

  // Compute ROI profile data (row/col means + histogram) when ROI or imageData changes
  useEffect(() => {
    if (!roi || !imageData?.getExportStripe) {
      if (roi) debugLog('[ROI Profile] Skipping:', { roi: !!roi, hasGetExportStripe: !!imageData?.getExportStripe });
      setRoiProfile(null);
      return;
    }
    debugLog('[ROI Profile] Computing for ROI:', roi);
    let cancelled = false;

    const run = async () => {
      try {
        const sourceW = imageData.width;
        const sourceH = imageData.height;
        // Choose subsample factor to target ~128 output pixels on the longer axis
        const ml = Math.max(1, Math.ceil(Math.max(roi.width, roi.height) / 128));
        const startCol = Math.floor(Math.max(0, roi.left) / ml);
        const startRow = Math.floor(Math.max(0, roi.top) / ml);
        const endCol = Math.floor(Math.min(roi.left + roi.width, sourceW) / ml);
        const endRow = Math.floor(Math.min(roi.top + roi.height, sourceH) / ml);
        const exportW = Math.max(1, endCol - startCol);
        const exportH = Math.max(1, endRow - startRow);

        const result = await imageData.getExportStripe({
          startRow,
          numRows: exportH,
          ml,
          exportWidth: exportW,
          startCol,
          numCols: exportW,
        });
        if (cancelled) return;

        const bandName = Object.keys(result.bands)[0];
        const raw = result.bands[bandName];

        // Convert to dB / linear and collect valid values
        const vals = new Float32Array(raw.length);
        let vMin = Infinity, vMax = -Infinity, vSum = 0, vCount = 0;
        for (let i = 0; i < raw.length; i++) {
          const r = raw[i];
          if (!isNaN(r) && r > 0) {
            const v = effectiveUseDecibels ? toDb(r, 0) : r;
            vals[i] = v;
            if (v < vMin) vMin = v;
            if (v > vMax) vMax = v;
            vSum += v; vCount++;
          } else {
            vals[i] = NaN;
          }
        }
        if (vCount === 0 || cancelled) return;
        const mean = vSum / vCount;

        // Row means (one per export row)
        const rowMeans = new Float32Array(exportH).fill(NaN);
        for (let r = 0; r < exportH; r++) {
          let s = 0, n = 0;
          for (let c = 0; c < exportW; c++) {
            const v = vals[r * exportW + c];
            if (!isNaN(v)) { s += v; n++; }
          }
          rowMeans[r] = n > 0 ? s / n : NaN;
        }

        // Col means
        const colMeans = new Float32Array(exportW).fill(NaN);
        for (let c = 0; c < exportW; c++) {
          let s = 0, n = 0;
          for (let r = 0; r < exportH; r++) {
            const v = vals[r * exportW + c];
            if (!isNaN(v)) { s += v; n++; }
          }
          colMeans[c] = n > 0 ? s / n : NaN;
        }

        // Histogram (64 bins)
        const NUM_BINS = 64;
        const hist = new Uint32Array(NUM_BINS);
        const range = vMax - vMin || 1;
        for (let i = 0; i < vals.length; i++) {
          const v = vals[i];
          if (isNaN(v)) continue;
          const bin = Math.max(0, Math.min(NUM_BINS - 1, Math.floor((v - vMin) / range * NUM_BINS)));
          hist[bin]++;
        }

        if (!cancelled) {
          debugLog('[ROI Profile] Computed:', { exportW, exportH, vCount, mean: mean.toFixed(2), vMin: vMin.toFixed(2), vMax: vMax.toFixed(2) });
          setRoiProfile({ rowMeans, colMeans, hist, histMin: vMin, histMax: vMax, mean, count: vCount, exportW, exportH, useDecibels: effectiveUseDecibels });
        }
      } catch (e) {
        console.error('[ROI Profile] Error:', e);
        if (!cancelled) setRoiProfile(null);
      }
    };

    run();
    return () => { cancelled = true; };
  }, [roi, imageData, useDecibels]);

  // Sample pixel values along the free transect line whenever it moves/rotates.
  // Evenly spaced samples (capped) along the segment via bilinear-ish nearest
  // getPixelValue reads. Values converted to dB when the display is in dB.
  useEffect(() => {
    if (!transectEnabled || !transectLine || !imageData?.getPixelValue) {
      setTransectData(null);
      return;
    }
    let cancelled = false;
    const { x0, y0, x1, y1 } = transectLine;
    const lenPx = Math.hypot(x1 - x0, y1 - y0);
    let angleDeg = Math.atan2(-(y1 - y0), x1 - x0) * 180 / Math.PI;
    if (angleDeg < 0) angleDeg += 360;
    if (lenPx < 1) { setTransectData(null); return; }

    const getPixelValue = imageData.getPixelValue;
    const db = effectiveUseDecibels;

    // Perpendicular unit vector (image px) for cross-line averaging.
    // Line dir = (x1-x0, y1-y0); perpendicular = (-dy, dx) normalized.
    const perpX = -(y1 - y0) / lenPx;
    const perpY = (x1 - x0) / lenPx;
    const w = Math.max(0, Math.round(transectWidth)); // half-width in px; 0 = centerline only
    const offsets = [];
    for (let k = -w; k <= w; k++) offsets.push(k);

    // Bound total getPixelValue reads to a fixed budget so wide strips on long
    // lines don't stall the UI. Each read can decompress an HDF5 chunk.
    const MAX_READS = 768;
    const maxN = Math.max(2, Math.floor(MAX_READS / offsets.length));
    const N = Math.max(2, Math.min(256, maxN, Math.round(lenPx)));

    const pickScalar = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'number') return v;
      if (typeof v === 'object') {
        if (typeof v[selectedPolarization] === 'number') return v[selectedPolarization];
        if (typeof v.value === 'number') return v.value;
        if (typeof v.mean === 'number') return v.mean;
        for (const k in v) { if (typeof v[k] === 'number') return v[k]; }
      }
      return null;
    };

    const run = async () => {
      const dist = new Float32Array(N);
      const M = offsets.length;
      const nums = new Array(N).fill(NaN);
      let sawNegative = false;

      // Sample with BOUNDED concurrency, processed in small batches with an
      // abort check between them. Firing all N×M reads via one Promise.all
      // fans out hundreds of concurrent decompress jobs — which, stacked on
      // top of RGB tile loading, exhausts workers/memory and crashes the tab.
      const BATCH = 24;

      const flushBatch = async (fromI, toI) => {
        const reqs = [];
        for (let i = fromI; i < toI; i++) {
          const t = i / (N - 1);
          dist[i] = t * lenPx;
          const cx = x0 + t * (x1 - x0);
          const cy = y0 + t * (y1 - y0);
          const strip = [];
          for (const k of offsets) {
            const col = Math.round(cx + k * perpX);
            const row = Math.round(cy + k * perpY);
            strip.push(getPixelValue(row, col, 1).catch(() => null));
          }
          reqs.push(Promise.all(strip).then(vals => {
            let sum = 0, cnt = 0;
            for (const raw of vals) {
              const s = pickScalar(raw);
              if (s === null || !Number.isFinite(s)) continue;
              sum += s; cnt++;
            }
            const v = cnt > 0 ? sum / cnt : NaN;
            nums[i] = v;
            if (Number.isFinite(v) && v < 0) sawNegative = true;
          }));
        }
        await Promise.all(reqs);
      };

      for (let batchStart = 0; batchStart < N; batchStart += BATCH) {
        if (cancelled) return;
        await flushBatch(batchStart, Math.min(N, batchStart + BATCH));
      }
      if (cancelled) return;

      // If any sampled value is negative, the source already holds dB/signed
      // data — pass through untouched. Otherwise it's linear power: mask
      // nodata (0 / NaN) and apply 10·log10 when the display is in dB.
      const isAlreadyDb = sawNegative;
      const values = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const v = nums[i];
        if (!Number.isFinite(v)) { values[i] = NaN; continue; }
        if (isAlreadyDb) { values[i] = v; continue; }
        if (v === 0) { values[i] = NaN; continue; } // power nodata
        values[i] = db ? toDb(v, 0) : v;
      }
      setTransectData({ dist, values, lenPx, angleDeg });
    };

    // Debounce: sampling issues up to N×(2w+1) getPixelValue reads, each of
    // which can pull/decompress whole HDF5 chunks. Firing that on every drag
    // frame freezes the UI, so wait until the line settles (~140 ms idle).
    const timer = setTimeout(run, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [transectEnabled, transectLine, imageData, effectiveUseDecibels, selectedPolarization, transectWidth]);

  // Fetch multi-band ROI data for feature space classifier
  useEffect(() => {
    if (!classifierOpen || !roi || !imageData?.getExportStripe) {
      setClassifierData(null);
      setClassificationMap(null);
      setClassifierRoiDims(null);
      return;
    }
    let cancelled = false;

    const fetchClassifierData = async () => {
      try {
        const sourceW = imageData.width;
        const sourceH = imageData.height;
        // Target ~256 output pixels on longest axis for scatter fidelity
        const ml = Math.max(1, Math.ceil(Math.max(roi.width, roi.height) / 256));
        const startCol = Math.floor(Math.max(0, roi.left) / ml);
        const startRow = Math.floor(Math.max(0, roi.top) / ml);
        const endCol = Math.floor(Math.min(roi.left + roi.width, sourceW) / ml);
        const endRow = Math.floor(Math.min(roi.top + roi.height, sourceH) / ml);
        const exportW = Math.max(1, endCol - startCol);
        const exportH = Math.max(1, endRow - startRow);

        const result = await imageData.getExportStripe({
          startRow,
          numRows: exportH,
          ml,
          exportWidth: exportW,
          startCol,
          numCols: exportW,
        });
        if (cancelled) return;

        const bandNames = Object.keys(result.bands);
        const xBand = classifierBands.x;
        const yBand = classifierBands.y;

        // Find the requested bands in the result
        let xData = result.bands[xBand];
        let yData = result.bands[yBand];

        // Fallback: use first two available bands
        if (!xData && bandNames.length >= 1) xData = result.bands[bandNames[0]];
        if (!yData && bandNames.length >= 2) yData = result.bands[bandNames[1]];
        // If only one band, try using it as both (degenerate but shows the scatter)
        if (!yData && xData) yData = xData;

        if (!xData || !yData) {
          console.warn('[Classifier] No band data available:', bandNames);
          return;
        }
        if (xData === yData) {
          console.warn('[Classifier] Only 1 band available. Switch to RGB composite mode for 2D scatter classification.');
        }

        const n = xData.length;
        const x = new Float32Array(n);
        const y = new Float32Array(n);
        const valid = new Uint8Array(n);

        for (let i = 0; i < n; i++) {
          const xr = xData[i], yr = yData[i];
          if (!isNaN(xr) && xr > 0 && !isNaN(yr) && yr > 0) {
            x[i] = toDb(xr, 0);
            y[i] = toDb(yr, 0);
            valid[i] = 1;
          }
        }

        // Evaluate incidence angle over ROI if metadata cube available
        let incidence = null;
        debugLog('[Classifier] metadataCube:', !!imageData.metadataCube, 'xCoords:', !!imageData.xCoords, 'yCoords:', !!imageData.yCoords);
        if (imageData.metadataCube && imageData.xCoords && imageData.yCoords) {
          incidence = new Float32Array(n);
          for (let oy = 0; oy < exportH; oy++) {
            const srcRow = Math.min((startRow + oy) * ml, sourceH - 1);
            const northing = imageData.yCoords[srcRow];
            for (let ox = 0; ox < exportW; ox++) {
              const srcCol = Math.min((startCol + ox) * ml, sourceW - 1);
              const easting = imageData.xCoords[srcCol];
              const val = imageData.metadataCube.getIncidenceAngle(easting, northing);
              incidence[oy * exportW + ox] = val ?? NaN;
            }
          }
        }

        if (!cancelled) {
          const validCount = valid.reduce((a, b) => a + b, 0);
          debugLog('[Classifier] Scatter data ready:', { exportW, exportH, validCount, hasIncidence: !!incidence });
          setClassifierData({ x, y, valid, w: exportW, h: exportH, incidence, singleChannel: xData === yData });
          setClassifierRoiDims({ w: exportW, h: exportH });
          // Set initial incidence range from data
          if (incidence) {
            let minInc = 90, maxInc = 0;
            for (let i = 0; i < n; i++) {
              if (valid[i] && !isNaN(incidence[i])) {
                if (incidence[i] < minInc) minInc = incidence[i];
                if (incidence[i] > maxInc) maxInc = incidence[i];
              }
            }
            setIncidenceRange([Math.floor(minInc), Math.ceil(maxInc)]);
          }
        }
      } catch (e) {
        console.error('[Classifier] Error fetching ROI data:', e);
      }
    };

    fetchClassifierData();
    return () => { cancelled = true; };
  }, [classifierOpen, roi, imageData, classifierBands]);

  // Helper to add status log (must be before any callback that uses it)
  const addStatusLog = useCallback((type, message, details = null) => {
    const timestamp = new Date().toLocaleTimeString();
    setStatusLogs(prev => {
      const next = [...prev, { type, message, details, timestamp }];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  // ── W030: load-scoped cancellation ────────────────────────────────────────
  // One AbortController per load operation, aborted when the user presses
  // Cancel or when a new load supersedes it. This is NOT the per-tile deck.gl
  // signal: W003 established that forwarding that one into readChunksBatch
  // breaks tiles during viewport stabilisation and poisons the adaptive
  // concurrency estimator. This signal cancels a whole load and reaches the
  // h5chunk range reads, which is the only way Cancel can be honest — a cancel
  // that stops the spinner while bytes keep arriving is worse than none.
  const loadAbortRef = useRef(null);
  const [loadCancellable, setLoadCancellable] = useState(false);

  /** Register a load's controller as the active one, superseding any previous. */
  const beginLoadAbort = useCallback((controller) => {
    loadAbortRef.current?.abort();
    loadAbortRef.current = controller;
    setLoadCancellable(true);
    return controller.signal;
  }, []);

  /** Retire a load's controller (success or failure) if it is still current. */
  const endLoadAbort = useCallback((controller) => {
    if (loadAbortRef.current === controller) {
      loadAbortRef.current = null;
      setLoadCancellable(false);
    }
  }, []);

  /** Progress sink shared by every load path — pct plus the real counts. */
  const handleLoadProgress = useCallback((pct, detail) => {
    setLoadProgress(pct);
    if (detail) setLoadDetail(detail);
  }, []);

  /** Reset the progress surface once a load settles. */
  const resetLoadProgress = useCallback(() => {
    setLoadProgress(0);
    setLoadDetail(null);
  }, []);

  const cancelActiveLoad = useCallback(() => {
    const controller = loadAbortRef.current;
    if (!controller) return;
    controller.abort();
    loadAbortRef.current = null;
    setLoadCancellable(false);
    setLoading(false);
    resetLoadProgress();
    addStatusLog('warn', 'Load cancelled', 'In-flight range reads were aborted');
  }, [addStatusLog, resetLoadProgress]);

  /** True when an error is just this cancellation coming back up the stack. */
  const isAbortError = (e) => e?.name === 'AbortError';

  // ── W030: mobile bottom-sheet drag ────────────────────────────────────────
  // sardine-theme.css already declares cursor:grab, touch-action:none and two
  // detents (45dvh / 82dvh) on .controls-panel — but the handle was a plain
  // onClick, so the sheet looked draggable and was not. These handlers make the
  // affordance true; a tap still toggles between the same two detents.
  const controlsPanelRef = useRef(null);
  const sheetDragRef = useRef(null);
  const sheetTapSuppressedRef = useRef(false);
  const SHEET_DETENTS = [0.45, 0.82]; // must match sardine-theme.css
  const SHEET_DRAG_SLOP = 8;          // px before a tap counts as a drag

  const handleSheetPointerDown = useCallback((e) => {
    // The sheet only exists in the mobile layout; desktop keeps the toggle.
    if (!window.matchMedia('(max-width: 768px)').matches) return;
    const el = controlsPanelRef.current;
    if (!el) return;
    const height = el.getBoundingClientRect().height;
    sheetDragRef.current = { startY: e.clientY, startH: height, lastH: height, moved: 0 };
    el.style.transition = 'none';
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not captureable */ }
  }, []);

  const handleSheetPointerMove = useCallback((e) => {
    const drag = sheetDragRef.current;
    const el = controlsPanelRef.current;
    if (!drag || !el) return;
    const dy = drag.startY - e.clientY; // up is positive, sheet grows
    drag.moved = Math.max(drag.moved, Math.abs(dy));
    const vh = window.innerHeight;
    // Clamp a little outside the detents so the drag has somewhere to go.
    const h = Math.min(vh * 0.92, Math.max(vh * 0.2, drag.startH + dy));
    drag.lastH = h;
    el.style.height = `${h}px`;
  }, []);

  const handleSheetPointerUp = useCallback((e) => {
    const drag = sheetDragRef.current;
    const el = controlsPanelRef.current;
    sheetDragRef.current = null;
    if (!drag || !el) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    el.style.transition = '';
    el.style.height = ''; // hand height back to the CSS detent
    if (drag.moved < SHEET_DRAG_SLOP) return; // a tap — let onClick toggle
    sheetTapSuppressedRef.current = true;
    const frac = drag.lastH / window.innerHeight;
    const midpoint = (SHEET_DETENTS[0] + SHEET_DETENTS[1]) / 2;
    setSheetExpanded(frac >= midpoint);
  }, []);

  const handleSheetClick = useCallback(() => {
    // A drag already chose a detent; don't toggle back on the trailing click.
    if (sheetTapSuppressedRef.current) {
      sheetTapSuppressedRef.current = false;
      return;
    }
    setSheetExpanded(v => !v);
  }, []);

  /** W030 empty state: open the hosted hero scene via its deep link. */
  const openHeroDemo = useCallback(() => {
    addStatusLog('info', 'Opening the demo scene (Pacaya-Samiria dual-pol RGB)');
    window.location.search = HERO_DEMO_QUERY;
  }, [addStatusLog]);

  // One-time status log of which histogram compute path is active (W007).
  // Emitted the first time histogram stats are actually computed.
  const histogramPathLoggedRef = useRef(false);
  const logHistogramPathOnce = useCallback(() => {
    if (histogramPathLoggedRef.current) return;
    histogramPathLoggedRef.current = true;
    addStatusLog('info', `histogram: ${gpuInfo.webgpu ? 'WebGPU' : 'CPU'}`);
  }, [addStatusLog, gpuInfo.webgpu]);

  // WKT ROI: track sync source to avoid loops between WKT input and Shift+drag
  const wktSyncSource = useRef('');

  // WKT ROI: apply WKT string to set pixel ROI
  const handleWktApply = useCallback(() => {
    if (!wktInput.trim() || !imageData) return;

    try {
      const pixelRoi = wktToROI(wktInput.trim(), imageData);
      if (!pixelRoi) {
        setWktError('ROI does not intersect the image');
        return;
      }
      setWktError(null);
      wktSyncSource.current = 'wkt'; // prevent reverse-sync from overwriting input
      setROI(pixelRoi);
      addStatusLog('info', `WKT ROI applied: ${pixelRoi.width} x ${pixelRoi.height} px`,
        `at (${pixelRoi.left}, ${pixelRoi.top})`);
    } catch (e) {
      setWktError(e.message);
      addStatusLog('error', `WKT error: ${e.message}`);
    }
  }, [wktInput, imageData, addStatusLog]);

  // W016: apply a deep-link ?bbox=/?wkt= region once the raster is loaded.
  // Same pathway as handleWktApply (bbox → file CRS → pixel ROI → setROI +
  // WKT input), plus a view fit to the region unless the link pinned explicit
  // c/z. Takes the freshly-loaded data object directly (imageData state has
  // not committed yet when the load handlers call this). One-shot: consumes
  // deepLinkRoiRef so later loads behave normally (W008 pin pattern).
  // Returns { bboxFileCrs } (clamped to the scene) or null on no-op/fallback.
  const applyDeepLinkRoi = useCallback((data) => {
    const pending = deepLinkRoiRef.current;
    if (!pending || !data?.width || !data?.height || !data?.bounds) return null;
    deepLinkRoiRef.current = null;
    try {
      const fileCrs = data.crs || 'EPSG:4326';
      const bboxFileCrs = reprojectBbox(pending.bbox, fileCrs);
      const fileBbox = data.worldBounds || data.bounds;
      if (!roiIntersectsFile(bboxFileCrs, fileBbox)) {
        addStatusLog('warning', 'Deep-link region does not intersect the scene — showing full scene',
          `bbox ${pending.bbox.map(v => v.toFixed(4)).join(', ')} (WGS84)`);
        return null;
      }
      const px = bboxToPixelRange(bboxFileCrs, {
        worldBounds: fileBbox,
        width: data.width,
        height: data.height,
        xCoords: data.xCoords || null,
        yCoords: data.yCoords || null,
      });
      if (!px) {
        addStatusLog('warning', 'Deep-link region maps to an empty pixel range — showing full scene');
        return null;
      }
      wktSyncSource.current = 'wkt'; // prevent reverse-sync from overwriting the input
      // Pin so the imageData-change cleanup effect doesn't wipe this ROI the
      // moment the freshly loaded scene commits (one-shot, like the others).
      deepLinkPins.current.add('roi');
      setROI({ left: px.startCol, top: px.startRow, width: px.numCols, height: px.numRows });
      const [w, s, e, n] = pending.bbox;
      setWktInput(pending.wkt || `BBOX(${w}, ${s}, ${e}, ${n})`);
      setWktError(null);

      // Clamp to the scene so a half-outside bbox still frames sensibly.
      const clamped = [
        Math.max(bboxFileCrs[0], fileBbox[0]),
        Math.max(bboxFileCrs[1], fileBbox[1]),
        Math.min(bboxFileCrs[2], fileBbox[2]),
        Math.min(bboxFileCrs[3], fileBbox[3]),
      ];
      if (pending.fitView) {
        const [minX, minY, maxX, maxY] = clamped;
        setViewCenter([(minX + maxX) / 2, (minY + maxY) / 2]);
        const maxSpan = Math.max(maxX - minX, maxY - minY) || 1;
        // Same zoom conventions as the load handlers: projected → fit ~1000 px,
        // geographic → degree-based formula (see handleLoadCOG / autoFitIfNewScene).
        const isProjected = fileCrs && fileCrs !== 'EPSG:4326';
        setViewZoom(isProjected ? Math.log2(1000 / maxSpan) : Math.log2(360 / maxSpan) - 1);
      }
      addStatusLog('success', `Deep-link region applied: ${px.numCols} × ${px.numRows} px ROI`,
        `bbox ${pending.bbox.map(v => v.toFixed(4)).join(', ')} (WGS84)${pending.fitView ? ', view fitted to region' : ''}`);
      return { bboxFileCrs: clamped };
    } catch (e) {
      addStatusLog('warning', `Deep-link region ignored: ${e.message}`);
      return null;
    }
  }, [addStatusLog]);

  // WKT ROI: reverse-sync — when ROI changes via Shift+drag, populate WKT input
  useEffect(() => {
    if (!roi || !imageData) {
      if (!roi) wktSyncSource.current = '';
      return;
    }
    // Only reverse-sync if the ROI was NOT set by WKT apply (avoid overwriting user input)
    if (wktSyncSource.current === 'wkt') {
      wktSyncSource.current = '';
      return;
    }
    const fileBbox = imageData.worldBounds || imageData.bounds;
    if (!fileBbox) return;
    const subBounds = computeSubsetBounds(
      { startRow: roi.top, startCol: roi.left, numRows: roi.height, numCols: roi.width },
      {
        worldBounds: fileBbox,
        width: imageData.width,
        height: imageData.height,
        xCoords: imageData.xCoords || null,
        yCoords: imageData.yCoords || null,
      }
    );
    const [w, s, e, n] = subBounds;
    setWktInput(`BBOX(${w.toFixed(6)}, ${s.toFixed(6)}, ${e.toFixed(6)}, ${n.toFixed(6)})`);
    setWktError(null);
  }, [roi, imageData]);

  // Clear ROI RGB overlay and time-series when ROI changes or is cleared
  useEffect(() => {
    setRoiRGBData(null);
    setRoiRGBBounds(null);
    setRoiRGBContrastLimits(null);
    setRoiRGBHistogramData(null);
    setRoiTSFrames(null);
    setRoiTSBounds(null);
    setRoiTSContrastLimits(null);
    setRoiTSHistogramData(null);
    setRoiTSPlaying(false);
    setRoiTSIndex(0);
    setActiveViewer('main');
  }, [roi]);

  // Load RGB composite into ROI overlay
  const handleLoadRoiRGB = useCallback(async () => {
    const nisarSource = nisarFile || remoteUrl;
    if (!nisarSource || !roi || !roiCompositeId || !imageData) return;

    setRoiRGBLoading(true);
    try {
      const requiredPols = getRequiredDatasets(roiCompositeId);
      const requiredComplexPols = getRequiredComplexDatasets(roiCompositeId);

      addStatusLog('info', `Loading ROI RGB composite: ${roiCompositeId} (${requiredPols.join(', ')})`);

      const data = await loadNISARRGBComposite(nisarSource, {
        frequency: 'frequencyA',
        compositeId: roiCompositeId,
        requiredPols,
        requiredComplexPols,
      });

      // Convert ROI pixel coords → world bounds
      const fileBbox = imageData.worldBounds || imageData.bounds;
      const subBounds = computeSubsetBounds(
        { startRow: roi.top, startCol: roi.left, numRows: roi.height, numCols: roi.width },
        {
          worldBounds: fileBbox,
          width: imageData.width,
          height: imageData.height,
          xCoords: imageData.xCoords || null,
          yCoords: imageData.yCoords || null,
        }
      );

      data.getTile = data.getRGBTile;

      // Auto-compute per-channel contrast + histogram from ROI region
      // Sample 3×3 grid of tiles (same pattern as main histogram)
      const [minX, minY, maxX, maxY] = subBounds;
      const regionW = maxX - minX;
      const regionH = maxY - minY;
      let lims = { R: [0, 0.1], G: [0, 0.1], B: [0, 0.1] };
      let roiHists = null;
      try {
        const rawValues = { R: [], G: [], B: [] };
        const gridSize = 3;
        const stepX = regionW / gridSize;
        const stepY = regionH / gridSize;

        for (let ty = 0; ty < gridSize; ty++) {
          for (let tx = 0; tx < gridSize; tx++) {
            const left = minX + tx * stepX;
            const right = minX + (tx + 1) * stepX;
            const top = minY + ty * stepY;
            const bottom = minY + (ty + 1) * stepY;

            const tileData = await data.getRGBTile({
              x: tx, y: ty, z: 0,
              bbox: { left, top, right, bottom },
              noCache: true,
            });

            if (tileData && tileData.bands) {
              const rgbBands = computeRGBBands(tileData.bands, roiCompositeId, tileData.width);
              for (const ch of ['R', 'G', 'B']) {
                const arr = rgbBands[ch];
                for (let i = 0; i < arr.length; i += 4) {
                  if (arr[i] > 0 && !isNaN(arr[i])) rawValues[ch].push(arr[i]);
                }
              }
            }
          }
        }

        addStatusLog('info', `ROI RGB sampled ${rawValues.R.length} pixels per channel`);
        logHistogramPathOnce();
        roiHists = {};
        for (const ch of ['R', 'G', 'B']) {
          const stats = await computeChannelStatsAuto(rawValues[ch], false, 128);
          if (stats) {
            roiHists[ch] = stats;
            lims[ch] = [stats.p2, stats.p98];
          }
        }
        addStatusLog('info', `ROI RGB contrast: R=[${lims.R.map(v=>v.toFixed(4))}] G=[${lims.G.map(v=>v.toFixed(4))}] B=[${lims.B.map(v=>v.toFixed(4))}]`);
      } catch (histErr) {
        addStatusLog('warning', `ROI RGB histogram error: ${histErr.message}`);
      }

      setRoiRGBContrastLimits(lims);
      setRoiRGBHistogramData(roiHists);
      setRoiRGBData(data);
      setRoiRGBBounds(subBounds);
      setActiveViewer('roi-rgb');

      addStatusLog('success', 'ROI RGB composite loaded',
        `${data.width}x${data.height}, bounds: ${subBounds.map(v => v.toFixed(4)).join(', ')}`);
    } catch (err) {
      addStatusLog('error', `ROI RGB load failed: ${err.message}`);
    } finally {
      setRoiRGBLoading(false);
    }
  }, [nisarFile, remoteUrl, roi, roiCompositeId, selectedFrequency, imageData, addStatusLog, logHistogramPathOnce]);

  // Load time-series into ROI side panel
  const handleLoadRoiTimeSeries = useCallback(async () => {
    if (!roiTSFiles.length || !roi || !imageData) return;

    setRoiTSLoading(true);
    setRoiTSPlaying(false);
    setRoiTSIndex(0);
    try {
      // Convert ROI pixel coords → world bounds
      const fileBbox = imageData.worldBounds || imageData.bounds;
      const subBounds = computeSubsetBounds(
        { startRow: roi.top, startCol: roi.left, numRows: roi.height, numCols: roi.width },
        {
          worldBounds: fileBbox,
          width: imageData.width,
          height: imageData.height,
          xCoords: imageData.xCoords || null,
          yCoords: imageData.yCoords || null,
        }
      );

      addStatusLog('info', `Loading time-series: ${roiTSFiles.length} files for ROI`);

      const isGUNW = nisarProductType === 'GUNW';
      const frames = [];
      for (let i = 0; i < roiTSFiles.length; i++) {
        const file = roiTSFiles[i];
        addStatusLog('info', `Loading file ${i + 1}/${roiTSFiles.length}: ${file.name}`);
        try {
          let data;
          if (isGUNW) {
            data = await loadNISARGUNW(file, {
              frequency: selectedFrequency,
              layer: selectedLayer,
              dataset: selectedGunwDataset,
              polarization: selectedPolarization,
            });
          } else if (isRGBDisplayMode) {
            const requiredPols = getRequiredDatasets(compositeId);
            const requiredComplexPols = getRequiredComplexDatasets(compositeId);
            data = await loadNISARRGBComposite(file, {
              frequency: selectedFrequency,
              compositeId,
              requiredPols,
              requiredComplexPols,
            });
          } else {
            data = await loadNISARGCOV(file, {
              frequency: selectedFrequency,
              polarization: selectedPolarization,
            });
          }
          // Extract date from identification metadata or filename
          let date, label;
          if (isGUNW) {
            // GUNW: use reference acquisition date from metadata, or parse from filename
            const ident = data.identification || {};
            date = ident.referenceZeroDopplerStartTime || ident.secondaryZeroDopplerStartTime || file.name;
            // GUNW filenames often contain date pairs; extract for label
            label = typeof date === 'string' && date.length > 10 ? date.slice(0, 10) : file.name.replace(/\.[^.]+$/, '');
          } else {
            const ident = data.identification || {};
            date = ident.zeroDopplerStartTime || ident.rangeBeginningDateTime || file.name;
            label = typeof date === 'string' && date.length > 10 ? date.slice(0, 10) : file.name.replace(/\.[^.]+$/, '');
          }
          const isRGBMode = isRGBDisplayMode && !!data.getRGBTile;
          frames.push({
            getTile: isRGBMode ? data.getRGBTile : data.getTile,
            getExportStripe: data.getExportStripe || null,
            crs: data.crs || null,
            requiredPols: isRGBMode ? (data.requiredPols || []) : (data.polarization ? [data.polarization] : []),
            requiredComplexPols: isRGBMode ? (data.requiredComplexPols || []) : [],
            bounds: data.bounds,
            label,
            date,
            fileName: file.name,
            identification: data.identification || null,
            width: data.width,
            height: data.height,
            renderMode: data.renderMode || null,
            isRGB: isRGBMode,
            compositeId: isRGBMode ? compositeId : null,
          });
        } catch (fileErr) {
          addStatusLog('warning', `Skipping ${file.name}: ${fileErr.message}`);
        }
      }

      if (frames.length === 0) {
        addStatusLog('error', 'No files loaded successfully');
        setRoiTSLoading(false);
        return;
      }

      // Sort by date label
      frames.sort((a, b) => a.label.localeCompare(b.label));

      // Compute per-frame histogram stats for auto-contrast
      const [minX, minY, maxX, maxY] = subBounds;
      const regionW = maxX - minX;
      const regionH = maxY - minY;
      const applyDeci = isGUNW ? false : useDecibels;

      const isRGBTS = frames.length > 0 && frames[0].isRGB;
      logHistogramPathOnce();
      for (let fi = 0; fi < frames.length; fi++) {
        try {
          if (isRGBTS) {
            // Sample center tile for per-channel stats
            const tileData = await frames[fi].getTile({
              x: 0, y: 0, z: 0,
              bbox: { left: minX, top: minY, right: maxX, bottom: maxY },
            });
            if (tileData && tileData.bands) {
              const rgbBands = computeRGBBands(tileData.bands, frames[fi].compositeId, tileData.width);
              const chStats = {};
              for (const ch of ['R', 'G', 'B']) {
                const arr = rgbBands[ch];
                const valid = [];
                for (let i = 0; i < arr.length; i++) {
                  if (arr[i] > 0 && !isNaN(arr[i])) valid.push(arr[i]);
                }
                chStats[ch] = (await computeChannelStatsAuto(valid, false, 128)) || null;
              }
              frames[fi].stats = chStats;
            } else {
              frames[fi].stats = null;
            }
          } else {
            const stats = await sampleViewportStatsAuto(
              frames[fi].getTile, regionW, regionH, applyDeci, 128,
              minX, minY, frames[fi].height,
            );
            frames[fi].stats = stats || null;
          }
        } catch {
          frames[fi].stats = null;
        }
      }

      // Set initial contrast from first frame
      const firstStats = frames[0].stats;
      let tsContrast;
      let tsHist = null;
      if (isRGBTS) {
        if (firstStats && firstStats.R) {
          tsContrast = {
            R: [firstStats.R.p2, firstStats.R.p98],
            G: firstStats.G ? [firstStats.G.p2, firstStats.G.p98] : [0, 0.1],
            B: firstStats.B ? [firstStats.B.p2, firstStats.B.p98] : [0, 0.1],
          };
          tsHist = firstStats;
        } else {
          tsContrast = { R: [0, 0.1], G: [0, 0.1], B: [0, 0.1] };
        }
      } else if (firstStats) {
        tsContrast = [Number(firstStats.p2.toFixed(1)), Number(firstStats.p98.toFixed(1))];
        tsHist = { single: firstStats };
      } else {
        const renderMode = frames[0].renderMode;
        tsContrast = isGUNW && renderMode?.defaultRange
          ? [...renderMode.defaultRange]
          : [-25, 0];
      }

      setRoiTSBounds(subBounds);
      setRoiTSFrames(frames);
      setRoiTSContrastLimits(tsContrast);
      setRoiTSHistogramData(tsHist);
      setActiveViewer('roi-ts');

      const dsLabel = isGUNW ? `${GUNW_DATASET_LABELS[selectedGunwDataset] || selectedGunwDataset}` : selectedPolarization;
      addStatusLog('success', `Time-series loaded: ${frames.length} frames (${dsLabel})`,
        frames.map(f => f.label).join(', '));
    } catch (err) {
      addStatusLog('error', `Time-series load failed: ${err.message}`);
    } finally {
      setRoiTSLoading(false);
    }
  }, [roiTSFiles, roi, imageData, selectedFrequency, selectedPolarization, nisarProductType, selectedLayer, selectedGunwDataset, useDecibels, displayMode, compositeId, addStatusLog, logHistogramPathOnce]);

  // Update histogram and contrast when time-series frame changes
  useEffect(() => {
    if (!roiTSFrames || !roiTSFrames[roiTSIndex]) return;
    const frame = roiTSFrames[roiTSIndex];
    if (!frame.stats) return;
    if (frame.isRGB) {
      const lims = {};
      for (const ch of ['R', 'G', 'B']) {
        if (frame.stats[ch]) lims[ch] = [frame.stats[ch].p2, frame.stats[ch].p98];
      }
      if (Object.keys(lims).length > 0) {
        setRoiTSContrastLimits(lims);
        setRoiTSHistogramData(frame.stats);
      }
    } else {
      setRoiTSHistogramData({ single: frame.stats });
      setRoiTSContrastLimits([Number(frame.stats.p2.toFixed(1)), Number(frame.stats.p98.toFixed(1))]);
    }
  }, [roiTSIndex, roiTSFrames]);

  // Animation timer for time-series playback
  useEffect(() => {
    if (!roiTSPlaying || !roiTSFrames) return;
    const interval = setInterval(() => {
      setRoiTSIndex(prev => (prev + 1) % roiTSFrames.length);
    }, 1000); // 1 fps
    return () => clearInterval(interval);
  }, [roiTSPlaying, roiTSFrames]);

  // Recompute classification map when class regions, scatter data, or incidence range changes
  useEffect(() => {
    if (!classifierData || !classRegions.length) {
      setClassificationMap(null);
      return;
    }
    const { x, y, valid, w, h, incidence } = classifierData;
    const [incMin, incMax] = incidenceRange;
    const map = new Uint8Array(x.length);

    for (let i = 0; i < x.length; i++) {
      if (!valid[i]) continue;
      // Filter by incidence angle if available
      if (incidence && !isNaN(incidence[i])) {
        if (incidence[i] < incMin || incidence[i] > incMax) continue;
      }
      const xv = x[i], yv = y[i];
      for (let c = 0; c < classRegions.length; c++) {
        const r = classRegions[c];
        if (xv >= r.xMin && xv <= r.xMax && yv >= r.yMin && yv <= r.yMax) {
          map[i] = c + 1; // 1-based class index
          break;
        }
      }
    }

    setClassificationMap(map);
  }, [classifierData, classRegions, incidenceRange]);

  // Class-map rendering for the main viewer: categorical rasters (embedded
  // color table / integer labels, e.g. WorldCover) render one authored color
  // per class instead of the continuous dB ramp. Mirrors the compare grid's
  // auto-enable; palette prefers the file's color table.
  const mainClassInfo = useMemo(() => {
    if (!imageData?.isCategorical) return null;
    const { palette, entries } = buildClassPalette(imageData.colorTable);
    return {
      palette, entries,
      names: imageData.classNames || null,
      legend: seedLegendFromNames(imageData.classNames, palette),
    };
  }, [imageData]);

  // Compute WGS84 bounds for overview map and context layers
  const wgs84Bounds = useMemo(() => {
    if (!imageData) return null;
    const bounds = imageData.worldBounds || imageData.bounds;
    const crs = imageData.crs || 'EPSG:4326';
    if (!bounds || !crs) return null;
    const arr = projectedToWGS84(bounds, crs);
    if (!arr || arr.length < 4) return null;
    return { minLon: arr[0], minLat: arr[1], maxLon: arr[2], maxLat: arr[3] };
  }, [imageData]);

  // Compute viewport bounds for STAC search
  const computedViewBounds = useMemo(() => {
    if (imageData?.bounds) return imageData.bounds;
    // Compute viewport bounds from viewCenter and viewZoom for STAC mode
    const [cx, cy] = viewCenter;
    const span = 360 / Math.pow(2, viewZoom + 1);
    // Clamp latitude to avoid poles (Web Mercator limit)
    const minLat = Math.max(-85, cy - span/2);
    const maxLat = Math.min(85, cy + span/2);
    return [cx - span/2, minLat, cx + span/2, maxLat];
  }, [imageData, viewCenter, viewZoom]);

  // Memoize arrays to prevent unnecessary re-renders
  const contrastLimits = useMemo(() => [contrastMin, contrastMax], [contrastMin, contrastMax]);

  // For RGB mode, use per-channel limits; for single-band, use uniform limits
  const effectiveContrastLimits = useMemo(() => {
    if (isRGBDisplayMode && rgbContrastLimits) {
      return rgbContrastLimits;
    }
    return contrastLimits;
  }, [isRGBDisplayMode, rgbContrastLimits, contrastLimits]);

  // Sidebar context: which viewer are the controls targeting?
  const sidebarIsRoiRGB = activeViewer === 'roi-rgb' && !!roiRGBData;
  const sidebarIsRoiTS = activeViewer === 'roi-ts' && !!roiTSFrames;
  const sidebarHistogramData = sidebarIsRoiTS ? roiTSHistogramData : (sidebarIsRoiRGB ? roiRGBHistogramData : histogramData);
  const currentTSIsRGB = sidebarIsRoiTS && !!roiTSFrames?.[roiTSIndex]?.isRGB;
  const sidebarDisplayMode = sidebarIsRoiRGB ? 'rgb' : (currentTSIsRGB ? 'rgb' : (sidebarIsRoiTS ? 'single' : displayMode));

  // Auto-stretch: reset to 2-98% percentiles from cached histogram
  const handleAutoStretch = useCallback(() => {
    // If ROI RGB viewer is active, auto-stretch its contrast
    // If ROI time-series viewer is active
    if (activeViewer === 'roi-ts') {
      if (roiTSHistogramData?.R) {
        // RGB frame — per-channel auto-stretch
        const newLimits = {};
        for (const ch of ['R', 'G', 'B']) {
          if (roiTSHistogramData[ch]) newLimits[ch] = [roiTSHistogramData[ch].p2, roiTSHistogramData[ch].p98];
        }
        if (Object.keys(newLimits).length > 0) {
          setRoiTSContrastLimits(newLimits);
          addStatusLog('success', 'Time-series RGB contrast reset to 2–98% percentiles');
        }
      } else if (roiTSHistogramData?.single) {
        const p2 = Number(roiTSHistogramData.single.p2.toFixed(1));
        const p98 = Number(roiTSHistogramData.single.p98.toFixed(1));
        setRoiTSContrastLimits([p2, p98]);
        addStatusLog('success', `Time-series contrast reset to ${p2} – ${p98}`);
      }
      return;
    }

    if (activeViewer === 'roi-rgb' && roiRGBData && roiRGBHistogramData) {
      const newLimits = {};
      for (const ch of ['R', 'G', 'B']) {
        if (roiRGBHistogramData[ch]) {
          newLimits[ch] = [roiRGBHistogramData[ch].p2, roiRGBHistogramData[ch].p98];
        }
      }
      if (Object.keys(newLimits).length > 0) {
        setRoiRGBContrastLimits(newLimits);
        addStatusLog('success', 'ROI RGB contrast reset to 2–98% percentiles');
      }
      return;
    }

    if (!histogramData) {
      addStatusLog('warning', 'No histogram data — load a dataset first');
      return;
    }

    if (isRGBDisplayMode) {
      const newLimits = {};
      for (const ch of ['R', 'G', 'B']) {
        if (histogramData[ch]) {
          let p2 = histogramData[ch].p2;
          let p98 = histogramData[ch].p98;
          // Metadata histograms (logX=true) store linear power p2/p98 — convert to dB for dB mode
          if (effectiveUseDecibels && histogramData[ch].logX) {
            p2 = toDb(p2);
            p98 = toDb(p98);
          }
          newLimits[ch] = [p2, p98];
        }
      }
      if (Object.keys(newLimits).length === 0) {
        addStatusLog('warning', 'No per-channel statistics available');
        return;
      }
      setRgbContrastLimits(newLimits);
      addStatusLog('success', 'RGB contrast reset to 2–98% percentiles',
        ['R', 'G', 'B'].map(ch => newLimits[ch] ? `${ch}: ${newLimits[ch][0].toExponential(2)}–${newLimits[ch][1].toExponential(2)}` : '').join(', '));
    } else if (histogramData.single) {
      // Keep decimal precision for dB values
      const p2 = Number(histogramData.single.p2.toFixed(1));
      const p98 = Number(histogramData.single.p98.toFixed(1));
      setContrastMin(p2);
      setContrastMax(p98);
      addStatusLog('success', `Contrast reset to ${p2} – ${p98} dB`);
    } else {
      addStatusLog('warning', 'No histogram data for current mode');
    }
  }, [histogramData, displayMode, effectiveUseDecibels, addStatusLog, activeViewer, roiRGBData, roiRGBHistogramData, roiTSHistogramData]);

  // Recompute histogram (viewport-aware)
  const handleRecomputeHistogram = useCallback(async () => {
    debugLog('[histogram] handleRecomputeHistogram called, scope:', histogramScope, 'displayMode:', displayMode, 'hasGetTile:', !!imageData?.getTile, 'hasGetRGBTile:', !!imageData?.getRGBTile, 'compositeId:', compositeId);
    if (!imageData || !imageData.getTile || !imageData.bounds) {
      addStatusLog('warning', 'No tile data available for histogram');
      return;
    }
    if (histogramScope === 'roi' && !roi) {
      addStatusLog('warning', 'No ROI drawn — draw a region with Shift+drag first');
      return;
    }

    // Skip histogram for GUNW datasets with fixed ranges (wrapped phase = always [-pi, pi])
    if (nisarProductType === 'GUNW' && imageData.renderMode?.defaultRange && imageData.renderMode?.isComplex) {
      const [lo, hi] = imageData.renderMode.defaultRange;
      addStatusLog('info', `Fixed range for ${selectedGunwDataset}: ${lo.toFixed(3)} to ${hi.toFixed(3)} ${imageData.renderMode.unit || ''}`);
      return;
    }

    addStatusLog('info', `Recomputing histogram (${histogramScope})...`);

    try {
      // Compute viewport region bounds (used for viewport scope)
      // viewCenter is in world coordinates (matches imageData.bounds).
      // viewZoom: 2^zoom = screen-pixels-per-world-unit (deck.gl OrthographicView).
      // Visible world extent = canvasPixels / 2^zoom.
      const ppu = Math.pow(2, viewZoom);
      const canvas = viewerRef.current?.getCanvas();
      const canvasW = canvas?.clientWidth || 900;
      const canvasH = canvas?.clientHeight || 700;
      const vpHalfW = (canvasW / 2) / ppu;
      const vpHalfH = (canvasH / 2) / ppu;
      const cx = viewCenter[0];
      const cy = viewCenter[1];
      // Clamp to image bounds (world coordinates, not pixel dimensions)
      const [bMinX, bMinY, bMaxX, bMaxY] = imageData.bounds;
      const vpLeft = Math.max(bMinX, cx - vpHalfW);
      const vpRight = Math.min(bMaxX, cx + vpHalfW);
      const vpTop = Math.max(bMinY, cy - vpHalfH);
      const vpBottom = Math.min(bMaxY, cy + vpHalfH);

      let regionX, regionY, regionW, regionH, scopeLabel;
      if (histogramScope === 'roi' && roi) {
        // ROI is in pixel coordinates — convert to world coordinates for getTile
        const roiWorldLeft = bMinX + (roi.left / imageData.width) * (bMaxX - bMinX);
        const roiWorldRight = bMinX + ((roi.left + roi.width) / imageData.width) * (bMaxX - bMinX);
        // ROI top/height are in image-row space (top=0 is north); convert to world Y
        const roiWorldTop = bMaxY - ((roi.top + roi.height) / imageData.height) * (bMaxY - bMinY);
        const roiWorldBottom = bMaxY - (roi.top / imageData.height) * (bMaxY - bMinY);
        regionX = roiWorldLeft;
        regionY = roiWorldTop;   // min world Y (south)
        regionW = roiWorldRight - roiWorldLeft;
        regionH = roiWorldBottom - roiWorldTop;
        scopeLabel = 'ROI';
      } else if (histogramScope === 'viewport') {
        regionX = vpLeft;
        regionY = vpTop;
        regionW = vpRight - vpLeft;
        regionH = vpBottom - vpTop;
        scopeLabel = 'Viewport';
      } else {
        // Global: use full bounds (world coordinates)
        regionX = bMinX;
        regionY = bMinY;
        regionW = bMaxX - bMinX;
        regionH = bMaxY - bMinY;
        scopeLabel = 'Global';
      }

      if (isRGBDisplayMode && histogramScope === 'global' && imageData.bandStats && Object.keys(imageData.bandStats).length > 0 && compositeId) {
        // Metadata histogram — log-normal model from HDF5 band stats
        // (avoids sampling 9 full-image tiles on a large GCOV file)
        const preset = SAR_COMPOSITES[compositeId];
        if (preset?.channels) {
          const hists = {};
          for (const ch of ['R', 'G', 'B']) {
            const chDef = preset.channels[ch];
            const s = chDef?.dataset && imageData.bandStats[chDef.dataset];
            if (s && s.mean_value > 0 && s.sample_stddev > 0) {
              hists[ch] = computeLogNormalHist(s.mean_value, s.sample_stddev);
            } else {
              const cl = rgbContrastLimits?.[ch] || [0, 1];
              const numBins = 128;
              const binWidth = (cl[1] - cl[0]) / numBins;
              const bins = new Array(numBins).fill(1000 / numBins);
              hists[ch] = { bins, min: cl[0], max: cl[1], mean: (cl[0] + cl[1]) / 2,
                binWidth, count: 1000, p2: cl[0], p98: cl[1] };
            }
          }
          setHistogramData(hists);
          // In dB mode, convert the linear log-normal p2/p98 to dB and apply as contrast limits
          if (effectiveUseDecibels) {
            const lims = {};
            for (const ch of ['R', 'G', 'B']) {
              if (hists[ch]) {
                lims[ch] = [
                  toDb(hists[ch].p2),
                  toDb(hists[ch].p98),
                ];
              }
            }
            if (Object.keys(lims).length > 0) setRgbContrastLimits(lims);
          }
          addStatusLog('info', 'Metadata histogram from HDF5 band statistics (log-normal model)');
        }
      } else if (isRGBDisplayMode && imageData.getRGBTile && compositeId) {
        // RGB histogram — sample 3×3 tiles from the region (concurrent)
        const tileSize = 256;
        const rawValues = { R: [], G: [], B: [] };
        const gridSize = 3;
        const stepX = regionW / gridSize;
        const stepY = regionH / gridSize;

        const tilePromises = [];
        for (let ty = 0; ty < gridSize; ty++) {
          for (let tx = 0; tx < gridSize; tx++) {
            const left = regionX + tx * stepX;
            const right = regionX + (tx + 1) * stepX;
            const top = regionY + ty * stepY;
            const bottom = regionY + (ty + 1) * stepY;
            tilePromises.push(imageData.getRGBTile({
              x: tx, y: ty, z: 0,
              bbox: { left, top, right, bottom },
              noCache: true,
            }));
          }
        }
        addStatusLog('info', `Histogram: sampling ${tilePromises.length} tiles...`);
        const tileResults = await Promise.allSettled(tilePromises);

        for (const result of tileResults) {
          if (result.status === 'fulfilled' && result.value?.bands) {
            const rgbBands = computeRGBBands(result.value.bands, compositeId, tileSize);
            for (const ch of ['R', 'G', 'B']) {
              const arr = rgbBands[ch];
              for (let i = 0; i < arr.length; i += 4) {
                if (arr[i] > 0 && !isNaN(arr[i])) rawValues[ch].push(arr[i]);
              }
            }
          }
        }

        logHistogramPathOnce();
        addStatusLog('info', 'Histogram: computing statistics...');
        const hists = {};
        let hasAnyStats = false;
        for (const ch of ['R', 'G', 'B']) {
          const arr = rawValues[ch] instanceof Float32Array ? rawValues[ch] : new Float32Array(rawValues[ch]);
          hists[ch] = await computeChannelStatsAuto(arr, effectiveUseDecibels);
          if (hists[ch]) hasAnyStats = true;
        }
        if (hasAnyStats) {
          setHistogramData(hists);
          addStatusLog('success', `${scopeLabel} histogram updated (RGB, ${effectiveUseDecibels ? 'dB' : 'linear'})`,
            ['R', 'G', 'B'].map(ch => hists[ch] ? `${ch}: ${hists[ch].p2.toExponential(2)}–${hists[ch].p98.toExponential(2)}` : '').join(', '));
        } else {
          addStatusLog('info', `${scopeLabel} histogram: no valid pixels in region`);
        }
      } else {
        // Single-band histogram
        // For global scope with HDF5 embedded stats, use synthetic histogram
        // instead of reading 9 full-extent tiles (avoids minutes-long stall on large files)
        const hasH5Stats = histogramScope === 'global' && imageData.stats
          && imageData.stats.mean_value > 0 && imageData.stats.sample_stddev > 0;

        if (hasH5Stats) {
          const { mean_value, sample_stddev } = imageData.stats;
          const meanDb = toDb(mean_value, 0);
          const stdDb = Math.abs(toDb(sample_stddev / mean_value, 0));
          const syntheticMin = meanDb - 4 * stdDb;
          const syntheticMax = meanDb + 4 * stdDb;
          const numBins = 128;
          const binWidth = (syntheticMax - syntheticMin) / numBins;
          const bins = new Array(numBins).fill(0);
          const syntheticCount = 100000;
          for (let b = 0; b < numBins; b++) {
            const binCenter = syntheticMin + (b + 0.5) * binWidth;
            const z = (binCenter - meanDb) / stdDb;
            bins[b] = Math.round(syntheticCount * Math.exp(-0.5 * z * z) / (stdDb * Math.sqrt(2 * Math.PI)) * binWidth);
          }
          const p2 = meanDb - 2 * stdDb;
          const p98 = meanDb + 2 * stdDb;
          setHistogramData({ single: { bins, min: syntheticMin, max: syntheticMax, mean: meanDb, binWidth, count: syntheticCount, p2, p98 } });
          addStatusLog('success', `Global histogram from HDF5 statistics: ${p2.toFixed(1)} to ${p98.toFixed(1)} dB`);
        } else {
          // Viewport/ROI scope or no HDF5 stats — sample tiles
          debugLog('[histogram] single-band path: region', { regionX, regionY, regionW, regionH }, 'useDecibels:', effectiveUseDecibels);
          logHistogramPathOnce();
          const stats = await sampleViewportStatsAuto(
            imageData.getTile, regionW, regionH, effectiveUseDecibels, 128,
            regionX, regionY, imageData.height,
            (done, total) => addStatusLog('info', `Histogram: sampling tile ${done}/${total}`),
          );
          debugLog('[histogram] single-band stats:', stats ? { p2: stats.p2, p98: stats.p98, count: stats.count } : null);
          if (stats) {
            debugLog('[histogram] CALLING setHistogramData, new min:', stats.min.toFixed(2), 'max:', stats.max.toFixed(2), 'count:', stats.count);
            setHistogramData({ single: stats });
            addStatusLog('success', `${scopeLabel} histogram: ${stats.p2.toFixed(1)} to ${stats.p98.toFixed(1)}`);
          } else {
            debugLog('[histogram] single-band: no stats returned');
          }
        }
      }
    } catch (e) {
      console.error('[histogram] recompute error:', e);
      addStatusLog('warning', 'Histogram recompute failed', e.message);
    }
  }, [imageData, histogramScope, viewCenter, viewZoom, displayMode, compositeId, effectiveUseDecibels, nisarProductType, selectedGunwDataset, roi, addStatusLog, logHistogramPathOnce]);

  // Recompute histogram when scope changes — but skip on initial load if
  // metadata-based contrast was already applied (avoids redundant tile reads).
  const skipInitialHistogramRef = useRef(false);
  // Separate flag for the viewport auto-refresh timer — persists across the debounce delay.
  const skipViewportRefreshRef = useRef(false);
  useEffect(() => {
    if (!imageData) return;
    if (skipInitialHistogramRef.current) {
      skipInitialHistogramRef.current = false;
      return;
    }
    recomputeRef.current();
  }, [histogramScope, imageData]);

  // Auto-show histogram overlay when histogram data becomes available
  useEffect(() => {
    if (histogramData) setShowHistogramOverlay(true);
  }, [histogramData]);

  // Fall back to global scope if ROI is cleared while in ROI scope
  useEffect(() => {
    if (!roi && histogramScope === 'roi') setHistogramScope('global');
  }, [roi, histogramScope]);

  const recomputeRef = useRef(handleRecomputeHistogram);
  recomputeRef.current = handleRecomputeHistogram;
  // Auto-recompute histogram when viewport changes (viewport scope, debounced).
  // With WebGPU compute the stats are near-instant, so a short ~100 ms debounce
  // gives near-real-time updates while panning; on the CPU fallback keep the
  // long 800 ms debounce to absorb the latency.
  const vcx = viewCenter[0];
  const vcy = viewCenter[1];
  useEffect(() => {
    if (!imageData || histogramScope !== 'viewport') return;
    // Hold off while the scene is still streaming. handleRecomputeHistogram
    // calls imageData.getTile, so running it mid-load contends with the load
    // itself for chunk reads and decode workers — on a gigapixel GCOV that was
    // six recomputes in three seconds, each one superseded before it mattered.
    // `tilesLoading` returning to 0 is the signal that streaming has settled;
    // it is in the dependency list, so the recompute fires once at that point.
    if (loading || tilesLoading > 0) return;
    const timer = setTimeout(() => {
      if (skipViewportRefreshRef.current) {
        skipViewportRefreshRef.current = false;
        return;
      }
      recomputeRef.current();
    }, gpuInfo.webgpu ? 100 : 800);
    return () => clearTimeout(timer);
  }, [vcx, vcy, viewZoom, imageData, histogramScope, gpuInfo.webgpu, loading, tilesLoading]);

  // Auto-recompute histogram when ROI changes (ROI scope only)
  // Disabled without WebGPU — CPU histogram is too slow for live ROI updates.
  useEffect(() => {
    if (!gpuInfo.webgpu) return; // Skip auto-refresh without WebGPU compute
    if (!imageData || !roi || histogramScope !== 'roi') return;
    // Same contention as the viewport scope: this also goes through getTile.
    if (loading || tilesLoading > 0) return;
    const timer = setTimeout(() => {
      recomputeRef.current();
    }, 300);
    return () => clearTimeout(timer);
  }, [roi, imageData, histogramScope, gpuInfo.webgpu, loading, tilesLoading]);

  // Recompute histogram when switching between dB and linear mode, then auto-stretch
  const useDecibelsRef = useRef(useDecibels);
  const pendingAutoStretchRef = useRef(false);
  const pendingPNGStateRef = useRef(null);

  // Initial per-channel RGB contrast for streamed composites (COG list, VRT
  // band stack) from the loader's per-band stats, in the current dB domain.
  const applyRgbContrastFromStats = useCallback((comp, bandStats, polNames) => {
    const useDb = useDecibelsRef.current;
    const lims = rgbContrastFromBandStats(comp, bandStats, polNames, useDb);
    if (!lims) return;
    setRgbContrastLimits(lims);
    setHistogramScope('viewport');
    addStatusLog('info', 'Initial RGB contrast from band statistics',
      ['R', 'G', 'B'].map((ch) => `${ch}: ${lims[ch][0].toFixed(1)}–${lims[ch][1].toFixed(1)}${useDb ? ' dB' : ''}`).join(', '));
  }, [addStatusLog]);

  useEffect(() => {
    if (useDecibels !== useDecibelsRef.current) {
      useDecibelsRef.current = useDecibels;
      // Skip histogram recompute if initial metadata contrast was just applied
      if (skipInitialHistogramRef.current) return;
      pendingAutoStretchRef.current = true;
      // Recompute histogram in the new scale (both single-band and RGB)
      if (imageData) {
        handleRecomputeHistogram();
      }
    }
  }, [useDecibels, imageData, handleRecomputeHistogram]);

  // Auto-stretch after dB-triggered histogram recompute completes
  useEffect(() => {
    if (pendingAutoStretchRef.current && (histogramData || roiRGBHistogramData || roiTSHistogramData)) {
      pendingAutoStretchRef.current = false;
      handleAutoStretch();
    }
  }, [histogramData, roiRGBHistogramData, roiTSHistogramData, handleAutoStretch]);

  // Tone mapping config — hidden, see tone mapping NOTE in JSX below
  // const toneMapping = useMemo(() => ({
  //   enabled: toneMapEnabled,
  //   method: toneMapMethod === 'auto' ? undefined : toneMapMethod,
  //   params: {
  //     gamma: toneMapGamma,
  //     strength: toneMapStrength,
  //   },
  // }), [toneMapEnabled, toneMapMethod, toneMapGamma, toneMapStrength]);

  // Generate markdown from current state
  const currentState = useMemo(() => ({
    source: fileType,
    file: fileType === 'cog' ? cogUrl : (nisarFile?.name || ''),
    dataset: (fileType === 'nisar' || fileType === 'nisar-gunw') ? { frequency: selectedFrequency, polarization: selectedPolarization } : null,
    displayMode,
    composite: compositeId,
    contrastMin,
    contrastMax,
    colormap,
    useDecibels,
    // toneMapEnabled, toneMapMethod, toneMapGamma, toneMapStrength,  // hidden
    view: { center: viewCenter, zoom: viewZoom },
  }), [fileType, cogUrl, nisarFile, selectedFrequency, selectedPolarization, displayMode, compositeId, contrastMin, contrastMax, colormap, useDecibels, viewCenter, viewZoom]);

  // Update markdown when state changes (unless edited)
  useEffect(() => {
    if (!isMarkdownEdited && !markdownUpdateRef.current) {
      setMarkdownState(generateMarkdownState(currentState));
    }
  }, [currentState, isMarkdownEdited]);

  // Handle markdown editing
  const handleMarkdownChange = useCallback((e) => {
    setMarkdownState(e.target.value);
    setIsMarkdownEdited(true);
  }, []);

  // Apply markdown changes to state
  const handleApplyMarkdown = useCallback(async () => {
    markdownUpdateRef.current = true;
    const parsed = parseMarkdownState(markdownState);
    addStatusLog('info', 'Applying state changes from markdown');

    // Update state from parsed markdown
    if (parsed.file !== cogUrl && parsed.file && parsed.file !== '(none)') {
      setCogUrl(parsed.file);
      // Load the COG if file changed
      setLoading(true);
      setError(null);
      addStatusLog('info', `Loading new file from markdown: ${parsed.file}`);
      try {
        const data = await loadCOG(parsed.file);
        setImageData(data);
        addStatusLog('success', 'COG loaded from markdown state');
      } catch (e) {
        setError(`Failed to load COG: ${e.message}`);
        setImageData(null);
        addStatusLog('error', 'Failed to load COG from markdown', e.message);
      } finally {
        setLoading(false);
      }
    }

    setContrastMin(parsed.contrastMin);
    setContrastMax(parsed.contrastMax);
    setColormap(parsed.colormap);
    setUseDecibels(parsed.useDecibels);
    // setToneMapEnabled(parsed.toneMapEnabled);  // hidden
    // setToneMapMethod(parsed.toneMapMethod);
    // setToneMapGamma(parsed.toneMapGamma);
    // setToneMapStrength(parsed.toneMapStrength);
    setViewCenter(parsed.view.center);
    setViewZoom(parsed.view.zoom);

    addStatusLog('success', 'Markdown state applied successfully');
    setIsMarkdownEdited(false);
    markdownUpdateRef.current = false;
  }, [markdownState, cogUrl, addStatusLog]);

  // Load COG
  const handleLoadCOG = useCallback(async () => {
    const gen = ++loadGenRef.current;
    // Check if multi-file mode
    if (multiFileMode) {
      const validFiles = fileList.filter(f => f && f.trim() !== '');
      if (validFiles.length === 0) {
        setError('Please enter at least one COG URL');
        addStatusLog('error', 'No COG URLs provided in multi-file mode');
        return;
      }

      setLoading(true);
      setError(null);
      addStatusLog('info', `Loading ${validFiles.length} files in ${multiFileModeType} mode`);

      try {
        let data;

        if (multiFileModeType === 'multi-band') {
          // Load as multi-band dataset
          addStatusLog('info', 'Loading multi-band COG dataset...');
          data = await loadMultiBandCOG({
            urls: validFiles,
            bands: bandNames.length === validFiles.length ? bandNames : null
          });

          addStatusLog('success', `Multi-band dataset loaded: ${data.bandNames.join(', ')}`,
            `Dimensions: ${data.width}x${data.height}, Bands: ${data.bandCount}`);

          // Update band names if auto-detected
          if (data.bandNames) {
            setBandNames(data.bandNames);
          }
        } else {
          // Load as temporal dataset
          addStatusLog('info', 'Loading temporal COG dataset...');
          const acquisitions = validFiles.map((url, i) => ({
            url,
            date: bandNames[i] || `t${i}`,
            label: bandNames[i] || `Time ${i}`
          }));
          data = await loadTemporalCOGs(acquisitions);

          const acqLabels = data.acquisitions.map(a => a.label).join(', ');
          addStatusLog('success', `Temporal dataset loaded: ${acqLabels}`,
            `Dimensions: ${data.width}x${data.height}, Acquisitions: ${data.acquisitionCount}`);
        }

        if (gen !== loadGenRef.current) return; // stale load
        setImageData(data);

        // Update view to fit bounds
        if (data.bounds) {
          const [minX, minY, maxX, maxY] = data.bounds;
          const centerX = (minX + maxX) / 2;
          const centerY = (minY + maxY) / 2;
          setViewCenter([centerX, centerY]);

          const spanX = maxX - minX;
          const spanY = maxY - minY;
          const maxSpan = Math.max(spanX, spanY);
          const isProjected = Math.abs(minX) > 180 || Math.abs(maxX) > 180;

          let zoom;
          if (isProjected) {
            const viewportSize = 1000;
            zoom = Math.log2(viewportSize / maxSpan);
          } else {
            zoom = Math.log2(360 / maxSpan) - 1;
          }

          setViewZoom(zoom);
          addStatusLog('info', 'View state updated to fit image bounds',
            `Center: [${centerX.toFixed(4)}, ${centerY.toFixed(4)}], Zoom: ${zoom.toFixed(2)}`);
        }

        addStatusLog('success', 'Multi-file dataset loaded and ready to display');

      } catch (e) {
        if (gen !== loadGenRef.current) return; // stale load
        setError(`Failed to load multi-file dataset: ${e.message}`);
        setImageData(null);
        addStatusLog('error', 'Failed to load multi-file dataset', e.message);
        console.error('Multi-file loading error:', e);
      } finally {
        setLoading(false);
      }

      return;
    }

    // Single file mode
    if (!cogUrl) {
      setError('Please enter a COG URL');
      addStatusLog('error', 'No COG URL provided');
      return;
    }

    // Validate URL format. Resolve against the page origin so root-relative
    // paths (e.g. same-origin `/data/...` served by the dev proxy or a
    // co-hosted Pages build) are accepted, not just absolute http(s) URLs.
    try {
      new URL(cogUrl, window.location.origin);
    } catch {
      setError('Invalid URL format. Please enter a valid HTTP(S) URL.');
      addStatusLog('error', `Invalid URL: ${cogUrl}`);
      return;
    }

    // GDAL VRT: its relative sources resolve against the upstream URL, so hand
    // the loader the un-proxied, absolute form; it proxies each fetch itself.
    const rawCogUrl = new URL(unproxyUrl(cogUrl), window.location.origin).href;
    if (isVRTPath(rawCogUrl)) {
      handleLoadVRTRef.current?.({ url: rawCogUrl });
      return;
    }

    setLoading(true);
    setError(null);
    addStatusLog('info', `Loading COG from: ${cogUrl}`);

    try {
      addStatusLog('info', 'Fetching GeoTIFF metadata...');

      // First, load metadata to check coordinate system
      const metadata = await loadCOG(cogUrl);
      const bounds = metadata.bounds;

      // Check if bounds are in projected coordinates (typically > 180 or < -180)
      const isProjected = Math.abs(bounds[0]) > 180 || Math.abs(bounds[2]) > 180;

      addStatusLog('info', `Detected ${isProjected ? 'projected' : 'geographic'} coordinates`);

      // Check if it's a proper COG
      if (metadata.isCOG) {
        addStatusLog('success', 'Valid Cloud Optimized GeoTIFF detected',
          `Tiles: ${metadata.tileWidth}x${metadata.tileHeight}, Overviews: ${metadata.imageCount}`);
      } else {
        addStatusLog('warning', 'This may not be a Cloud Optimized GeoTIFF',
          'Performance may be degraded for large images');
      }

      let data;

      if (isProjected) {
        // For projected coordinates, use tiled COG layer for dynamic overview loading
        addStatusLog('info', 'Using tiled COG layer for projected data with dynamic overview selection');
        addStatusLog('success', 'COG metadata loaded successfully',
          `Dimensions: ${metadata.width}x${metadata.height}, Bounds: ${metadata.bounds.map(b => b.toFixed(2)).join(', ')}`);
        // Store metadata with cogUrl for tiled loading
        data = {
          ...metadata,
          cogUrl, // Pass the URL for tiled loading
        };
      } else {
        // For geographic coordinates, use tile-based approach
        data = metadata;
        addStatusLog('success', 'COG metadata loaded successfully',
          `Dimensions: ${data.width}x${data.height}, Bounds: ${data.bounds.map(b => b.toFixed(2)).join(', ')}`);
      }

      if (gen !== loadGenRef.current) return; // stale load
      setImageData(data);

      // Auto-calculate contrast limits from a sample (skipped when a deep
      // link pinned explicit contrastMin/Max — W008 guard)
      if (consumeDeepLinkPin('contrast')) {
        addStatusLog('info', 'Keeping deep-link contrast (auto-contrast skipped)');
      } else try {
        addStatusLog('info', 'Calculating auto-contrast from sample data...');

        // Load a small sample from a middle overview for contrast calculation
        const sampleOverview = Math.min(2, metadata.imageCount - 1);
        const sampleData = await loadCOGFullImage(cogUrl, 512);

        if (sampleData && sampleData.data) {
          const limits = autoContrastLimits(sampleData.data, effectiveUseDecibels);
          setContrastMin(Math.round(limits[0]));
          setContrastMax(Math.round(limits[1]));
          addStatusLog('success', 'Auto-contrast calculated',
            `Range: ${limits[0].toFixed(2)} to ${limits[1].toFixed(2)}${effectiveUseDecibels ? ' dB' : ''}`);
        } else {
          addStatusLog('warning', 'No data available for contrast calculation');
        }
      } catch (e) {
        addStatusLog('warning', 'Could not auto-calculate contrast limits', e.message);
        console.warn('Could not auto-calculate contrast limits:', e);
      }

      // Update view to fit bounds (skipped when a deep link pinned c/z — W008 guard)
      if (data.bounds && !consumeDeepLinkPin('view')) {
        const [minX, minY, maxX, maxY] = data.bounds;
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        setViewCenter([centerX, centerY]);

        // For projected coordinates, calculate zoom differently
        // OrthographicView zoom: pixels per unit at zoom level 0
        // We want the image to fit in a typical viewport (e.g., 1000 pixels)
        const spanX = maxX - minX;
        const spanY = maxY - minY;
        const maxSpan = Math.max(spanX, spanY);

        let zoom;
        if (isProjected) {
          // For projected data (meters typically), we want to fit ~1000 pixels
          // zoom = log2(screen pixels / world units)
          const viewportSize = 1000;
          zoom = Math.log2(viewportSize / maxSpan);
        } else {
          // For geographic data (degrees)
          zoom = Math.log2(360 / maxSpan) - 1;
        }

        setViewZoom(zoom);
        addStatusLog('info', 'View state updated to fit image bounds',
          `Center: [${centerX.toFixed(4)}, ${centerY.toFixed(4)}], Zoom: ${zoom.toFixed(2)}, Span: ${maxSpan.toFixed(2)}`);
      }

      // W016: deep-link ?bbox=/?wkt= — apply the region as ROI + fit the view
      // to it (overrides the full-scene fit above in the same render commit).
      // COG tile fetches are viewport-driven, so the region fit alone scopes
      // network traffic — no loader change needed.
      applyDeepLinkRoi(data);

      addStatusLog('success', 'COG loaded and ready to display');
    } catch (e) {
      setError(`Failed to load COG: ${e.message}`);
      setImageData(null);
      addStatusLog('error', 'Failed to load COG', e.message);
      console.error('COG loading error:', e);
    } finally {
      setLoading(false);
    }
  }, [cogUrl, useDecibels, addStatusLog, multiFileMode, multiFileModeType, fileList, bandNames, applyDeepLinkRoi]);

  // Auto-load COG when set via ?cog= URL parameter
  useEffect(() => {
    if (urlCogTriggered.current && cogUrl && fileType === 'cog') {
      urlCogTriggered.current = false;
      handleLoadCOG();
    }
  }, [cogUrl, fileType, handleLoadCOG]);

  // Auto-load a multi-band RGB COG list from a deep link
  // (?cog=hh.tif,hv.tif&comp=dual-pol-h&mode=rgb). Single-band ?cog= links go
  // through cogUrl above; this path assembles per-band loadCOG sources into
  // one RGB-composite imageData via loadCOGRGBComposite — same render contract
  // as the NISAR HDF5 RGB path (getRGBTile tiles carry {bands, compositeId}).
  useEffect(() => {
    if (!cogRgbRequest) return;
    const { urls, compositeId: comp } = cogRgbRequest;
    const gen = ++loadGenRef.current;
    (async () => {
      setLoading(true);
      setError(null);
      const polNames = getRequiredDatasets(comp);
      if (polNames.length !== urls.length) {
        setLoading(false);
        setError(`RGB COG link: composite '${comp}' needs ${polNames.length || 'a known set of'} band URLs, got ${urls.length}`);
        addStatusLog('error', `RGB COG link: composite '${comp}' needs ${polNames.length} bands (${polNames.join(', ')}), got ${urls.length} URLs`);
        return;
      }
      addStatusLog('info', `Loading ${urls.length}-band RGB COG composite (${comp})`,
        polNames.map((pol, i) => `${pol}: ${urls[i]}`).join('\n'));
      try {
        const data = await loadCOGRGBComposite({
          urls: urls.map((u) => proxyUrlShared(u)),
          polNames,
          compositeId: comp,
        });
        if (gen !== loadGenRef.current) return;
        setImageData(data);
        setDisplayMode('rgb');
        setCompositeId(comp);

        // Per-channel contrast from band stats — same mean±2σ derivation as
        // the remote NISAR RGB path.
        applyRgbContrastFromStats(comp, data.bandStats, polNames);

        // Fit view to the scene (skipped when the link pinned c/z — W008).
        if (data.bounds && !consumeDeepLinkPin('view')) {
          const [minX, minY, maxX, maxY] = data.bounds;
          setViewCenter([(minX + maxX) / 2, (minY + maxY) / 2]);
          const maxSpan = Math.max(maxX - minX, maxY - minY);
          const isProjected = Math.abs(minX) > 180 || Math.abs(maxX) > 180;
          setViewZoom(isProjected ? Math.log2(1000 / maxSpan) : Math.log2(360 / maxSpan) - 1);
        }
        applyDeepLinkRoi(data);
        addStatusLog('success', `RGB COG composite ready (${data.width}x${data.height}, ${comp})`);
      } catch (e) {
        if (gen !== loadGenRef.current) return;
        setImageData(null);
        setError(`Failed to load RGB COG composite: ${e.message}`);
        addStatusLog('error', 'Failed to load RGB COG composite', e.message);
      } finally {
        if (gen === loadGenRef.current) setLoading(false);
      }
    })();
  }, [cogRgbRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle view state changes from viewer
  const handleViewStateChange = useCallback(({ viewState }) => {
    if (viewState.target) {
      setViewCenter(viewState.target);
    }
    if (viewState.zoom !== undefined) {
      setViewZoom(viewState.zoom);
    }
  }, []);

  /**
   * Auto-fit view to bounds ONLY if the scene has changed.
   * Same track-frame → same bounds → preserve current pan/zoom.
   * New scene → different bounds → auto-fit.
   */
  const autoFitIfNewScene = useCallback((newBounds) => {
    if (!newBounds) return;
    // Deep link pinned an explicit center/zoom — keep it for the first load (W008 guard)
    if (consumeDeepLinkPin('view')) {
      prevBoundsRef.current = newBounds;
      return;
    }
    debugLog('[SARdine] autoFitIfNewScene:', newBounds, 'prev:', prevBoundsRef.current);
    const prev = prevBoundsRef.current;
    if (prev) {
      // Check if bounds overlap significantly (same track-frame)
      const [pMinX, pMinY, pMaxX, pMaxY] = prev;
      const [nMinX, nMinY, nMaxX, nMaxY] = newBounds;
      const pSpan = Math.max(pMaxX - pMinX, pMaxY - pMinY) || 1;
      const dx = Math.abs((pMinX + pMaxX) / 2 - (nMinX + nMaxX) / 2);
      const dy = Math.abs((pMinY + pMaxY) / 2 - (nMinY + nMaxY) / 2);
      // If centers are within 10% of the span, treat as same scene
      if (dx < pSpan * 0.1 && dy < pSpan * 0.1) {
        prevBoundsRef.current = newBounds;
        return; // Keep current view
      }
    }
    // New scene — auto-fit
    const [minX, minY, maxX, maxY] = newBounds;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setViewCenter([cx, cy]);
    const maxSpan = Math.max(maxX - minX, maxY - minY);
    const viewportSize = 1000;
    const zoom = Math.log2(viewportSize / maxSpan);
    setViewZoom(zoom);
    prevBoundsRef.current = newBounds;
  }, []);

  // Reset view to fit current image bounds (unconditional — ignores same-scene check)
  const fitToBounds = useCallback(() => {
    const bounds = imageData?.bounds;
    if (!bounds) return;
    const [minX, minY, maxX, maxY] = bounds;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setViewCenter([cx, cy]);
    const maxSpan = Math.max(maxX - minX, maxY - minY);
    const viewportSize = 1000;
    const zoom = Math.log2(viewportSize / maxSpan);
    setViewZoom(zoom);
    addStatusLog('info', 'View reset to image bounds');
  }, [imageData, addStatusLog]);

  // Apply any visualization state saved from a previously-dropped PNG
  const applyPendingPNGState = useCallback(() => {
    const s = pendingPNGStateRef.current;
    if (!s) return;
    pendingPNGStateRef.current = null;
    if (s.colormap) setColormap(s.colormap);
    if (s.useDecibels !== undefined) setUseDecibels(s.useDecibels);
    if (s.contrastMin !== undefined) setContrastMin(s.contrastMin);
    if (s.contrastMax !== undefined) setContrastMax(s.contrastMax);
    if (s.gamma !== undefined) setGamma(s.gamma);
    if (s.stretchMode) setStretchMode(s.stretchMode);
    if (s.displayMode) setDisplayMode(s.displayMode);
    if (s.compositeId !== undefined) setCompositeId(s.compositeId);
    if (s.rgbContrastLimits) setRgbContrastLimits(s.rgbContrastLimits);
    if (s.selectedFrequency) setSelectedFrequency(s.selectedFrequency);
    if (s.selectedPolarization) setSelectedPolarization(s.selectedPolarization);
    if (s.multiLook !== undefined) setMultiLook(s.multiLook);
    if (s.speckleFilterType) setSpeckleFilterType(s.speckleFilterType);
    if (s.maskInvalid !== undefined) setMaskInvalid(s.maskInvalid);
    if (s.viewCenter) setViewCenter(s.viewCenter);
    if (s.viewZoom !== undefined) setViewZoom(s.viewZoom);
  }, []);

  // Handle NISAR file selection - read metadata to get available datasets
  const handleNISARFileSelect = useCallback(async (file) => {
    if (!file) return;

    setNisarFile(file);
    setNisarDatasets([]);
    setGunwDatasets(null);
    setLoading(true);
    setError(null);
    addStatusLog('info', `Reading NISAR metadata from: ${file.name}`);

    try {
      // Auto-detect product type
      const streamReader = await openNISARReader(file);
      const { band, productType } = await detectNISARProduct(streamReader);
      setNisarProductType(productType);
      addStatusLog('info', `Detected product type: ${productType} (${band})`);

      if (productType === 'GUNW') {
        // GUNW path — list layers and datasets
        const gunwResult = await listNISARGUNWDatasets(file, { band, _streamReader: streamReader });
        setGunwDatasets(gunwResult);

        // Build a flat dataset list for the shared UI (frequency + polarization)
        const datasets = gunwResult.datasets;
        setNisarDatasets(datasets);

        // Set defaults — prefer frequency B when available
        if (datasets.length > 0) {
          const preferB = datasets.find(d => d.frequency === 'B') || datasets[0];
          setSelectedFrequency(preferB.frequency);
          setSelectedPolarization(preferB.polarization);
          setSelectedLayer(preferB.layer);
          setSelectedGunwDataset(preferB.dataset);
        }

        // No RGB composites for GUNW
        setAvailableComposites([]);
        setCompositeId(null);
        setDisplayMode('single');

        const layers = [...new Set(datasets.map(d => d.layer))];
        addStatusLog('success', `Found ${datasets.length} GUNW datasets across ${layers.length} layer groups`,
          layers.map(l => GUNW_LAYER_LABELS[l] || l).join(', '));
        applyPendingPNGState();

        // Log GUNW metadata
        const meta = gunwResult.metadata;
        if (meta) {
          const parts = [];
          if (meta.trackNumber != null) parts.push(`Track ${meta.trackNumber}`);
          if (meta.frameNumber != null) parts.push(`Frame ${meta.frameNumber}`);
          if (meta.orbitPassDirection) parts.push(meta.orbitPassDirection);
          if (meta.temporalBaseline != null) parts.push(`${meta.temporalBaseline} day baseline`);
          if (meta.wavelength) parts.push(`λ=${(meta.wavelength * 100).toFixed(1)} cm`);
          if (meta.referenceZeroDopplerStartTime) {
            const refDate = meta.referenceZeroDopplerStartTime.slice(0, 10);
            const secDate = meta.secondaryZeroDopplerStartTime?.slice(0, 10);
            parts.push(secDate ? `${refDate} → ${secDate}` : refDate);
          }
          if (parts.length > 0) {
            addStatusLog('info', 'GUNW metadata', parts.join(' · '));
          }
        }
      } else {
        // GCOV path — existing behavior
        const datasets = await listNISARDatasets(file);
        setNisarDatasets(datasets);

        if (datasets.length > 0) {
          // Prefer frequency B when available (deep-link pins win — local
          // ?file= state links use the same one-shot guards as W008)
          const preferB = datasets.find(d => d.frequency === 'B') || datasets[0];
          if (!consumeDeepLinkPin('freq')) setSelectedFrequency(preferB.frequency);
          if (!consumeDeepLinkPin('pol')) setSelectedPolarization(preferB.polarization);

          // Apply auto-contrast immediately from metadata stats
          const firstStats = preferB.stats;
          if (consumeDeepLinkPin('contrast')) {
            addStatusLog('info', 'Keeping deep-link contrast (metadata auto-contrast skipped)');
          } else if (firstStats?.mean_value > 0 && firstStats?.sample_stddev > 0) {
            const meanDb = toDb(firstStats.mean_value, 0);
            const stdDb = Math.abs(toDb(firstStats.sample_stddev / firstStats.mean_value, 0));
            setContrastMin(Math.round(meanDb - 2 * stdDb));
            setContrastMax(Math.round(meanDb + 2 * stdDb));
            addStatusLog('info', 'Auto-contrast from metadata',
              `${(meanDb - 2 * stdDb).toFixed(1)} to ${(meanDb + 2 * stdDb).toFixed(1)} dB`);
          }
        }

        const composites = getAvailableComposites(datasets);
        setAvailableComposites(composites);

        const indices = getAvailableIndices(datasets);
        setAvailableIndices(indices);
        if (indices.length > 0) {
          setIndexId(indices[0].id);
          setIndexForm(indices[0].form);
        }

        const autoComposite = autoSelectComposite(datasets);
        // Deep-link comp/mode win over the auto-selection (one-shot pin)
        if (!consumeDeepLinkPin('comp')) {
          setCompositeId(autoComposite);
          setDisplayMode('single');
        }

        if (autoComposite) {
          addStatusLog('info', `RGB composite available: ${composites.find(c => c.id === autoComposite)?.name || autoComposite}`);
        }

        addStatusLog('success', `Found ${datasets.length} datasets`,
          datasets.map(d => `${d.frequency}/${d.polarization}`).join(', '));
        applyPendingPNGState();
      }
    } catch (e) {
      setError(`Failed to read NISAR file: ${e.message}`);
      addStatusLog('error', 'Failed to read NISAR metadata', e.message);
    } finally {
      setLoading(false);
    }
  }, [addStatusLog, applyPendingPNGState]);

  // Auto-contrast + dB detection from a sample of raw values (full raster
  // for plain TIFs, a decimated preview for VRTs).
  const applySampleContrast = useCallback((sampleData) => {
    const vals = [];
    const stride = Math.max(1, Math.floor(sampleData.length / 10000));
    for (let i = 0; i < sampleData.length; i += stride) {
      const v = sampleData[i];
      if (!isNaN(v) && v !== 0) vals.push(v);
    }
    vals.sort((a, b) => a - b);
    const p02 = vals[Math.floor(vals.length * 0.02)] || 0;
    const p98 = vals[Math.floor(vals.length * 0.98)] || 0;

    // Detect if values are raw power (needs dB) or already scaled:
    // - Raw SAR power: large positive values (p98 >> 1), dB conversion useful
    // - Calibrated sigma0/gamma0: mostly < 1, dB would work but linear range is fine
    // - Already in dB or ratio: can have negatives, small range, skip dB
    const hasNegatives = p02 < 0;
    const needsDb = !hasNegatives && p98 > 1;
    setUseDecibels(needsDb);

    const displayVals = needsDb
      ? vals.map(v => toDb(v))
      : vals;
    const lowIdx = Math.floor(0.02 * displayVals.length);
    const highIdx = Math.floor(0.98 * displayVals.length);
    const limits = [
      displayVals[lowIdx] ?? (needsDb ? -30 : 0),
      displayVals[Math.min(highIdx, displayVals.length - 1)] ?? (needsDb ? 0 : 1),
    ];
    setContrastMin(limits[0]);
    setContrastMax(limits[1]);
    addStatusLog('info', needsDb
      ? `dB scaling enabled (p98=${p98.toFixed(2)}), contrast: [${limits[0].toFixed(2)}, ${limits[1].toFixed(2)}]`
      : `Linear scaling (p98=${p98.toFixed(4)}), contrast: [${limits[0].toFixed(4)}, ${limits[1].toFixed(4)}]`);
  }, [addStatusLog]);

  // Handle local TIF file selection (single or multi-select mosaic).
  // Always replaces the active mosaic — drop the same files together
  // to mosaic them, or use appendMosaicTIFs to add to an existing mosaic.
  const handleLocalTIFMultiSelect = useCallback(async (files) => {
    if (!files || files.length === 0) return;

    setLoading(true);
    setLoadProgress(0);
    setError(null);
    setCogDatasets([]);
    setSelectedCogId(null);
    const names = files.map(f => f.name);
    addStatusLog('info', `Loading ${files.length} local GeoTIFF${files.length > 1 ? 's' : ''}: ${names.join(', ')}`);

    // Enumerate bands for the picker. Only meaningful for single-file
    // drops; mosaics flatten to band 0 of each input.
    if (files.length === 1) {
      try {
        const ds = await listLocalCOGDatasets(files[0]);
        setCogDatasets(ds);
        if (ds.length > 0) setSelectedCogId(ds[0].id);
      } catch (e) {
        // Non-fatal — picker just stays hidden
        console.warn('[COG] listLocalCOGDatasets failed:', e.message);
      }
    }

    try {
      const gen = ++loadGenRef.current;
      const data = await loadLocalTIFs(files, (pct) => setLoadProgress(pct));
      if (gen !== loadGenRef.current) return;

      setMosaicFiles(files);
      setImageData(data);
      const label = data.sliceCount > 1
        ? `Mosaic: ${data.sliceCount} slices, ${data.width}x${data.height} px`
        : `Loaded: ${data.width}x${data.height} px`;
      addStatusLog('success', label);

      // Categorical rasters (class maps): the dB heuristic misfires on
      // integer labels (all-positive, p98 > 1 → "raw power"). Class mode
      // renders through the palette, so skip dB + contrast entirely.
      if (data.isCategorical) {
        setUseDecibels(false);
        const n = data.classNames ? Object.keys(data.classNames).length : null;
        addStatusLog('success', 'Class map detected — rendering with embedded palette',
          n ? `${n} named classes` : 'integer labels');
      } else
      // Auto-contrast with dB detection (skipped when a deep link pinned
      // explicit contrastMin/Max — local-file ?file= state links)
      if (consumeDeepLinkPin('contrast')) {
        addStatusLog('info', 'Keeping deep-link contrast (auto-contrast skipped)');
      } else try {
        if (data.data) applySampleContrast(data.data);
      } catch (statsErr) {
        console.warn('Auto-contrast failed:', statsErr);
      }

      if (data.bounds) {
        autoFitIfNewScene(data.bounds);
      }
      setLoadProgress(100);
    } catch (e) {
      setError(`Failed to load GeoTIFF: ${e.message}`);
      addStatusLog('error', 'Failed to load GeoTIFF', e.message);
    } finally {
      setLoading(false);
    }
  }, [addStatusLog, autoFitIfNewScene, consumeDeepLinkPin, applySampleContrast]);

  // GDAL VRT — a remote URL (sources fetched through the proxy) or a dropped
  // .vrt plus its source files. Streams lazily; see src/loaders/vrt-loader.js.
  const handleLoadVRT = useCallback(async ({ url, file, companions = [] }) => {
    const gen = ++loadGenRef.current;
    const name = url ? url.split(/[?#]/)[0].split('/').pop() : file.name;
    setLoading(true);
    setLoadProgress(0);
    setError(null);
    setCogDatasets([]);
    setSelectedCogId(null);
    addStatusLog('info', `Loading VRT: ${name}`,
      file ? `${companions.length} source file${companions.length === 1 ? '' : 's'} dropped with it` : url);
    try {
      // Band stacks (gdalbuildvrt -separate hh.tif hv.tif) open as an RGB
      // composite when their band polarizations support one.
      const folders = vrtSourceFoldersRef.current;
      const data = await loadVRT(url || file, {
        files: companions,
        findFile: file && folders.length ? makeFolderResolver(folders) : null,
        resolveUrl: (u) => proxyUrlShared(u),
        onProgress: (pct) => setLoadProgress(pct),
        composite: 'auto',
      });
      if (gen !== loadGenRef.current) return;

      setVrtSourcePrompt(null);
      setMosaicFiles([]);
      setImageData(data);
      const { vrt } = data;
      addStatusLog('success', `VRT: ${data.width}x${data.height} px, ${vrt.sourceCount} source${vrt.sourceCount === 1 ? '' : 's'}`,
        `CRS ${data.crs}`);

      if (data.composite) {
        setDisplayMode('rgb');
        setCompositeId(data.composite);
        addStatusLog('success', `RGB composite from VRT bands: ${SAR_COMPOSITES[data.composite]?.name || data.composite}`,
          Object.entries(vrt.bandMap).map(([pol, b]) => `${pol} ← band ${b}`).join(', '));
        if (Object.keys(data.bandStats).length === 0) {
          addStatusLog('warning', 'RGB auto-contrast unavailable — no valid pixels sampled', 'Set per-channel contrast manually');
        } else if (!consumeDeepLinkPin('contrast')) {
          applyRgbContrastFromStats(data.composite, data.bandStats, data.requiredPols);
        }
        autoFitIfNewScene(data.bounds);
        return;
      }

      setDisplayMode('single');
      if (vrt.bandCount > 1) {
        const labels = vrt.bandDescriptions.map((d, i) => d || vrt.bandPolarizations[i] || `band ${i + 1}`).join(', ');
        addStatusLog('warning', `Showing band 1 of ${vrt.bandCount} — no RGB composite matches these bands`,
          `${labels}. Band polarizations come from band descriptions or source filenames (…_HH.tif).`);
      }

      // Auto-contrast from a bounded sample (≤16 sources) — a whole-scene
      // preview of a big mosaic would read every source before first paint.
      if (consumeDeepLinkPin('contrast')) {
        addStatusLog('info', 'Keeping deep-link contrast (auto-contrast skipped)');
      } else try {
        const sample = await data.readSample();
        if (gen !== loadGenRef.current) return;
        applySampleContrast(sample);
      } catch (statsErr) {
        console.warn('VRT auto-contrast failed:', statsErr);
      }

      autoFitIfNewScene(data.bounds);
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      if (e.code === 'VRT_MISSING_SOURCES' && file) {
        // A browser can't open the VRT's source paths — ask for their folder
        // (see the prompt next to the error stack) instead of failing flat.
        setVrtSourcePrompt({ file, companions, missing: e.missing, total: e.missing.length });
        addStatusLog('warning', `${name}: ${e.missing.length} source file${e.missing.length === 1 ? '' : 's'} not found`,
          `Choose the folder that holds them. First missing: ${e.missing[0]}`);
        return;
      }
      setError(`Failed to load VRT: ${e.message}`);
      setImageData(null);
      addStatusLog('error', 'Failed to load VRT', e.message);
    } finally {
      if (gen === loadGenRef.current) {
        setLoading(false);
        resetLoadProgress();
      }
    }
  }, [addStatusLog, autoFitIfNewScene, consumeDeepLinkPin, applySampleContrast, applyRgbContrastFromStats, resetLoadProgress]);

  useEffect(() => {
    handleLoadVRTRef.current = handleLoadVRT;
  }, [handleLoadVRT]);

  const chooseVrtSourceFolder = useCallback(async () => {
    const prompt = vrtSourcePrompt;
    if (!prompt) return;
    if (typeof window.showDirectoryPicker !== 'function') {
      addStatusLog('error', 'This browser cannot open folders',
        `Drop ${prompt.file.name} together with the folder that holds its sources`);
      return;
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'sardine-vrt-sources', mode: 'read' });
    } catch (e) {
      if (e.name !== 'AbortError') addStatusLog('error', 'Could not open folder', e.message);
      return;
    }
    vrtSourceFoldersRef.current = [dirHandleSource(handle), ...vrtSourceFoldersRef.current];
    addStatusLog('info', `VRT source folder: ${handle.name}`, 'Remembered for this session');
    setVrtSourcePrompt(null);
    handleLoadVRT({ file: prompt.file, companions: prompt.companions });
  }, [vrtSourcePrompt, addStatusLog, handleLoadVRT]);

  // Switch to a different band in the currently-open multi-band TIF.
  // Only meaningful for single-file loads; mosaic loads use band 0.
  const handleSelectCogDataset = useCallback(async (datasetId) => {
    if (!datasetId || datasetId === selectedCogId) return;
    if (mosaicFiles.length !== 1) return;
    setSelectedCogId(datasetId);
    setLoading(true);
    setLoadProgress(0);
    try {
      const gen = ++loadGenRef.current;
      const data = await loadLocalCOGDataset(mosaicFiles[0], datasetId, { onProgress: setLoadProgress });
      if (gen !== loadGenRef.current) return;
      setImageData(data);
      if (data.bounds) autoFitIfNewScene(data.bounds);
      setLoadProgress(100);
      const idx = cogDatasets.findIndex(d => d.id === datasetId);
      addStatusLog('info', `Switched COG band → ${idx + 1}/${cogDatasets.length}`);
    } catch (e) {
      setError(`Failed to switch band: ${e.message}`);
      addStatusLog('error', 'Failed to switch band', e.message);
    } finally {
      setLoading(false);
    }
  }, [mosaicFiles, selectedCogId, cogDatasets, addStatusLog, autoFitIfNewScene]);

  // Append TIF files to the active mosaic. Validates CRS against the
  // current mosaic and rejects mismatches. If no mosaic is loaded, falls
  // back to handleLocalTIFMultiSelect (treats as a fresh mosaic load).
  const appendMosaicTIFs = useCallback(async (newFiles) => {
    if (!newFiles || newFiles.length === 0) return;

    if (mosaicFiles.length === 0 || !imageData?.crs) {
      // Nothing to append to — load as a fresh mosaic
      handleLocalTIFMultiSelect(newFiles);
      return;
    }

    // De-duplicate by name+size against existing files
    const existingKeys = new Set(mosaicFiles.map(f => `${f.name}:${f.size}`));
    const additions = newFiles.filter(f => !existingKeys.has(`${f.name}:${f.size}`));
    if (additions.length === 0) {
      addStatusLog('info', 'All dropped files are already in the mosaic');
      return;
    }

    setLoading(true);
    setLoadProgress(0);
    setError(null);
    const primaryCRS = imageData.crs;
    addStatusLog('info', `Appending ${additions.length} file${additions.length > 1 ? 's' : ''} to mosaic (CRS: ${primaryCRS})`);

    try {
      // Quick CRS pre-check on additions before rebuilding the mosaic.
      // loadLocalTIFs uses slices[0].crs as the output CRS, so a mismatched
      // addition would silently distort the mosaic — reject early.
      const checks = await Promise.all(additions.map(f => loadLocalTIF(f)));
      const mismatched = checks.filter(s => s.crs && s.crs !== primaryCRS);
      if (mismatched.length > 0) {
        const names = additions
          .filter((_, i) => checks[i].crs && checks[i].crs !== primaryCRS)
          .map(f => f.name);
        addStatusLog('error',
          `CRS mismatch — rejected ${mismatched.length} file${mismatched.length > 1 ? 's' : ''}`,
          `${names.join(', ')} not in ${primaryCRS}`);
        const ok = additions.filter((_, i) => !checks[i].crs || checks[i].crs === primaryCRS);
        if (ok.length === 0) {
          setLoading(false);
          return;
        }
        additions.length = 0;
        additions.push(...ok);
      }

      const allFiles = [...mosaicFiles, ...additions];
      const gen = ++loadGenRef.current;
      const data = await loadLocalTIFs(allFiles, (pct) => setLoadProgress(pct));
      if (gen !== loadGenRef.current) return;

      setMosaicFiles(allFiles);
      setImageData(data);
      addStatusLog('success',
        `Mosaic now ${allFiles.length} files: ${data.width}x${data.height} px`);

      if (data.bounds) {
        autoFitIfNewScene(data.bounds);
      }
      setLoadProgress(100);
    } catch (e) {
      setError(`Failed to append to mosaic: ${e.message}`);
      addStatusLog('error', 'Failed to append to mosaic', e.message);
    } finally {
      setLoading(false);
    }
  }, [mosaicFiles, imageData, addStatusLog, autoFitIfNewScene, handleLocalTIFMultiSelect]);

  // Remove the mosaic and reset to single-source state
  const clearMosaic = useCallback(() => {
    if (mosaicFiles.length === 0) return;
    addStatusLog('info', `Cleared mosaic (${mosaicFiles.length} files)`);
    setMosaicFiles([]);
    setImageData(null);
  }, [mosaicFiles, addStatusLog]);

  // Append NISAR GCOV files to the secondary mosaic. CRS is validated against
  // the primary once the primary has loaded; if not yet loaded, the files are
  // staged and validated when the secondary loader runs.
  const appendGcovMosaicFiles = useCallback((newFiles) => {
    if (!newFiles || newFiles.length === 0) return;
    setGcovMosaicFiles(prev => {
      const existingKeys = new Set(prev.map(f => `${f.name}:${f.size}`));
      const additions = newFiles.filter(f => !existingKeys.has(`${f.name}:${f.size}`));
      if (additions.length === 0) {
        addStatusLog('info', 'All dropped HDF5 files are already in the mosaic');
        return prev;
      }
      addStatusLog('info',
        `Queued ${additions.length} GCOV file${additions.length > 1 ? 's' : ''} for mosaic`,
        additions.map(f => f.name).join(', '));
      return [...prev, ...additions];
    });
  }, [addStatusLog]);

  const clearGcovMosaic = useCallback(() => {
    if (gcovMosaicFiles.length === 0 && gcovMosaicLayers.length === 0) return;
    addStatusLog('info', `Cleared GCOV mosaic (${gcovMosaicFiles.length} secondary files)`);
    setGcovMosaicFiles([]);
    setGcovMosaicLayers([]);
  }, [gcovMosaicFiles, gcovMosaicLayers, addStatusLog]);

  // Load secondary GCOV files in parallel whenever the file list, primary
  // frequency/polarization, displayMode, or compositeId changes. Branches on
  // RGB mode: when the primary is in RGB display with a compositeId set,
  // secondaries are loaded via loadNISARRGBComposite so getTile returns
  // multi-band tile data ({bands, compositeId, ...}) — SARTileLayer then
  // renders the secondary as RGB automatically. Otherwise loads single-band
  // via loadNISARGCOV. CRS-mismatched sources are rejected.
  const gcovMosaicGenRef = useRef(0);
  useEffect(() => {
    if (fileType !== 'nisar') return;
    if (nisarProductType !== 'GCOV') return;
    if (gcovMosaicFiles.length === 0) {
      if (gcovMosaicLayers.length > 0) setGcovMosaicLayers([]);
      return;
    }
    if (!imageData?.crs) return;

    const isRGB = displayMode === 'rgb' && !!compositeId;

    const gen = ++gcovMosaicGenRef.current;
    const primaryCRS = imageData.crs;
    let cancelled = false;

    (async () => {
      const results = await Promise.all(
        gcovMosaicFiles.map(async (file) => {
          try {
            if (isRGB) {
              const requiredPols = getRequiredDatasets(compositeId);
              const requiredComplexPols = getRequiredComplexDatasets(compositeId);
              const data = await loadNISARRGBComposite(file, {
                frequency: selectedFrequency,
                compositeId,
                requiredPols,
                requiredComplexPols,
              });
              return { file, data, getTile: data.getRGBTile };
            }
            if (displayMode === 'index') {
              const data = await loadNISARIndex(file, {
                frequency: selectedFrequency,
                indexId,
                form: indexForm,
              });
              return { file, data, getTile: data.getTile };
            }
            const data = await loadNISARGCOV(file, {
              frequency: selectedFrequency,
              polarization: selectedPolarization,
            });
            return { file, data, getTile: data.getTile };
          } catch (e) {
            return { file, error: e };
          }
        })
      );
      if (cancelled || gen !== gcovMosaicGenRef.current) return;

      const ok = [];
      for (const r of results) {
        if (r.error) {
          addStatusLog('error', `GCOV mosaic load failed: ${r.file.name}`, r.error.message);
          continue;
        }
        if (r.data.crs && primaryCRS && r.data.crs !== primaryCRS) {
          addStatusLog('error',
            `CRS mismatch — skipped ${r.file.name}`,
            `${r.data.crs} ≠ primary ${primaryCRS}`);
          continue;
        }
        ok.push({
          id: `${r.file.name}-${r.file.size}`,
          label: r.file.name,
          getTile: r.getTile,
          bounds: r.data.bounds,
          crs: r.data.crs,
          width: r.data.width,
          height: r.data.height,
        });
      }
      setGcovMosaicLayers(ok);
      if (ok.length > 0) {
        addStatusLog('success',
          `GCOV mosaic ready: ${ok.length} secondary layer${ok.length > 1 ? 's' : ''}`,
          isRGB ? `RGB ${compositeId}` : `${selectedFrequency}/${selectedPolarization}`);
      }
    })();

    return () => { cancelled = true; };
  }, [fileType, nisarProductType, gcovMosaicFiles, imageData?.crs, selectedFrequency, selectedPolarization, displayMode, compositeId, indexId, indexForm, addStatusLog]);

  const handleNITFFileSelect = useCallback(async (file) => {
    setLoading(true);
    setLoadProgress(0);
    setError(null);
    setNitfFile(file);
    addStatusLog('info', `Loading NITF: ${file.name} (${(file.size / 1e9).toFixed(2)} GB)`);

    try {
      // Enumerate image segments. Most NITFs have one; SICD can have
      // multiple chips. Single-image files skip the picker entirely.
      const datasets = await listNITFDatasets(file);
      setNitfDatasets(datasets);
      if (datasets.length === 0) throw new Error('NITF file contains no image segments');

      const firstId = datasets[0].id;
      setSelectedNitfId(firstId);

      const gen = ++loadGenRef.current;
      const data = await loadNITFDataset(file, firstId, { onProgress: setLoadProgress });
      if (gen !== loadGenRef.current) return;

      setImageData(data);
      const info = data.nitfInfo || {};
      const segLabel = datasets.length > 1 ? ` [seg ${1}/${datasets.length}]` : '';
      const label = info.isComplex
        ? `NITF SICD${segLabel}: ${data.width}×${data.height} complex (amplitude)`
        : `NITF${segLabel}: ${data.width}×${data.height}`;
      addStatusLog('success', label,
        info.sicd ? `SICD ${info.sicd.modeType || ''} ${info.sicd.collector || ''}`.trim() : undefined);

      if (data.bounds) autoFitIfNewScene(data.bounds);
      setLoadProgress(100);
    } catch (e) {
      setError(`Failed to load NITF: ${e.message}`);
      addStatusLog('error', 'Failed to load NITF', e.message);
    } finally {
      setLoading(false);
    }
  }, [addStatusLog, autoFitIfNewScene]);

  // Load a different NITF image segment from the currently-open file.
  // Wired to the DatasetPicker for multi-image NITFs.
  const handleSelectNitfDataset = useCallback(async (datasetId) => {
    if (!nitfFile || !datasetId || datasetId === selectedNitfId) return;
    setSelectedNitfId(datasetId);
    setLoading(true);
    setLoadProgress(0);
    try {
      const gen = ++loadGenRef.current;
      const data = await loadNITFDataset(nitfFile, datasetId, { onProgress: setLoadProgress });
      if (gen !== loadGenRef.current) return;
      setImageData(data);
      if (data.bounds) autoFitIfNewScene(data.bounds);
      setLoadProgress(100);
      const idx = nitfDatasets.findIndex(d => d.id === datasetId);
      addStatusLog('info', `Switched NITF segment → ${idx + 1}/${nitfDatasets.length}`);
    } catch (e) {
      setError(`Failed to switch NITF segment: ${e.message}`);
      addStatusLog('error', 'Failed to switch NITF segment', e.message);
    } finally {
      setLoading(false);
    }
  }, [nitfFile, selectedNitfId, nitfDatasets, addStatusLog, autoFitIfNewScene]);

  // ─── Markup GeoJSON save/load (W004) — logic lives in src/utils/annotation-io.js ───
  const markupFileInputRef = useRef(null);

  const handleSaveMarkup = useCallback(() => {
    try {
      const scene = {
        file: fileType === 'cog' ? cogUrl : (nisarFile?.name || nitfFile?.name || ''),
        crs: imageData?.crs || null,
        bounds: imageData?.worldBounds || imageData?.bounds || null,
        width: imageData?.width,
        height: imageData?.height,
      };
      const fc = annotationsToGeoJSON({ annotations, roi, classRegions, scene, roiProfile });
      downloadMarkupGeoJSON(fc, 'sardine-markup.geojson');
      addStatusLog('success', `Markup saved: ${fc.features.length} feature(s)`, 'sardine-markup.geojson');
    } catch (e) {
      addStatusLog('error', 'Markup save failed', e.message);
    }
  }, [annotations, roi, classRegions, roiProfile, fileType, cogUrl, nisarFile, nitfFile, imageData, addStatusLog]);

  const applyMarkupGeoJSON = useCallback((fc, name) => {
    try {
      const scene = {
        crs: imageData?.crs || null,
        bounds: imageData?.worldBounds || imageData?.bounds || null,
        width: imageData?.width,
        height: imageData?.height,
      };
      const res = geoJSONToAnnotations(fc, scene);
      if (res.annotations.length > 0) setAnnotations(prev => [...prev, ...res.annotations]);
      if (res.roi) setROI(res.roi);
      if (res.classRegions.length > 0) setClassRegions(prev => [...prev, ...res.classRegions]);
      // res.transectLine: no transect state at HEAD — wired when the transect-line WIP lands
      for (const w of res.warnings) addStatusLog('warning', 'Markup import', w);
      addStatusLog('success', `Markup loaded: ${name}`,
        `${res.annotations.length} annotation(s)${res.roi ? ', ROI' : ''}${res.classRegions.length > 0 ? `, ${res.classRegions.length} class region(s)` : ''}`);
    } catch (e) {
      addStatusLog('error', `Markup load failed: ${name}`, e.message);
    }
  }, [imageData, addStatusLog]);

  const handleLoadMarkupFile = useCallback((file) => {
    file.text()
      .then(t => applyMarkupGeoJSON(JSON.parse(t), file.name))
      .catch(e => addStatusLog('error', `Markup load failed: ${file.name}`, e.message));
  }, [applyMarkupGeoJSON, addStatusLog]);

  // Drag-and-drop handler — single dispatch table over file formats.
  // Each entry handles its own bucket (mosaic vs single-shot, append vs
  // replace) but the routing logic is uniform: bucketByFormat + handle.
  const handleFileDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;

    // Dropped folders (for a VRT's sources) — entries must be taken during
    // the event; they stay usable afterwards. Folders also appear in `files`
    // as extensionless zero-byte items, so drop those from the file list.
    const folderEntries = Array.from(e.dataTransfer?.items || [])
      .map(it => it.webkitGetAsEntry?.())
      .filter(en => en?.isDirectory);
    const folderNames = new Set(folderEntries.map(en => en.name));
    if (folderNames.size > 0) {
      for (let i = files.length - 1; i >= 0; i--) {
        if (folderNames.has(files[i].name) && !files[i].type) files.splice(i, 1);
      }
    }

    const buckets = bucketByFormat(files);
    const geojsonFiles = buckets.unknown.filter(f => /\.(geojson|json)$/i.test(f.name));
    const pngFiles = buckets.unknown.filter(f => /\.png$/i.test(f.name));
    const trulyUnknown = buckets.unknown.filter(f =>
      !/\.(geojson|json|png)$/i.test(f.name));
    if (trulyUnknown.length > 0) {
      addStatusLog('warning',
        `Ignored ${trulyUnknown.length} unrecognized file${trulyUnknown.length > 1 ? 's' : ''}`,
        trulyUnknown.map(f => f.name).join(', '));
    }

    // Format dispatch — primary raster format wins, sidecars (geojson/png)
    // are layered on after.
    const h5Files = buckets.h5;
    const tifFiles = buckets.cog;
    const nitfFiles = buckets.nitf;

    // HDF5 (highest precedence — primary data type)
    if (h5Files.length > 0) {
      const firstH5 = h5Files[0];
      const firstName = firstH5.name.toLowerCase();
      const isGUNW = firstName.includes('gunw') || firstName.includes('_unw_');

      if (isGUNW) {
        setFileType('nisar-gunw');
        handleNISARFileSelect(firstH5);
        if (h5Files.length > 1) {
          addStatusLog('warning',
            `GUNW mosaic not supported — loaded only ${firstH5.name}`,
            `${h5Files.length - 1} additional GUNW file(s) ignored`);
        }
      } else if (fileType === 'nisar' && nisarProductType === 'GCOV' && nisarFile) {
        appendGcovMosaicFiles(h5Files);
      } else {
        setFileType('nisar');
        handleNISARFileSelect(firstH5);
        if (h5Files.length > 1) {
          appendGcovMosaicFiles(h5Files.slice(1));
        }
      }
      if (tifFiles.length > 0) {
        addStatusLog('warning',
          `Cannot mix HDF5 and GeoTIFF in one drop — ignored ${tifFiles.length} TIF file(s)`,
          tifFiles.map(f => f.name).join(', '));
      }
      if (nitfFiles.length > 0) {
        addStatusLog('warning',
          `Cannot mix HDF5 and NITF in one drop — ignored ${nitfFiles.length} NITF file(s)`,
          nitfFiles.map(f => f.name).join(', '));
      }
    } else if (buckets.vrt.length > 0) {
      // TIFs dropped alongside a .vrt are its sources, not a mosaic; so are
      // any dropped folders (looked up by name, never listed)
      if (folderEntries.length > 0) {
        vrtSourceFoldersRef.current = [...folderEntries.map(dirEntrySource), ...vrtSourceFoldersRef.current];
        addStatusLog('info', `VRT source folder${folderEntries.length > 1 ? 's' : ''}: ${[...folderNames].join(', ')}`,
          'Remembered for this session');
      }
      setFileType('local-tif');
      handleLoadVRT({ file: buckets.vrt[0], companions: tifFiles });
      if (buckets.vrt.length > 1) {
        addStatusLog('warning', `Loaded ${buckets.vrt[0].name} — drop one VRT at a time`,
          `${buckets.vrt.length - 1} other VRT file(s) ignored`);
      }
    } else if (tifFiles.length > 0) {
      if (fileType === 'local-tif' && mosaicFiles.length > 0) {
        appendMosaicTIFs(tifFiles);
      } else {
        setFileType('local-tif');
        handleLocalTIFMultiSelect(tifFiles);
      }
      if (nitfFiles.length > 0) {
        addStatusLog('warning',
          `Cannot mix GeoTIFF and NITF in one drop — ignored ${nitfFiles.length} NITF file(s)`,
          nitfFiles.map(f => f.name).join(', '));
      }
    } else if (nitfFiles.length > 0) {
      setFileType('nitf');
      handleNITFFileSelect(nitfFiles[0]);
      if (nitfFiles.length > 1) {
        // Multi-image NITF: future work — list segments via listNITFDatasets()
        // and let the user pick. For now, only segment 0 of file 0 loads.
        addStatusLog('warning',
          `NITF mosaic not supported — loaded only ${nitfFiles[0].name}`,
          `${nitfFiles.length - 1} additional NITF file(s) ignored`);
      }
    } else if (geojsonFiles.length > 0) {
      // Add each GeoJSON file as an overlay
      for (const gj of geojsonFiles) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const geojson = JSON.parse(evt.target.result);
            if (!geojson.type || (geojson.type !== 'FeatureCollection' && geojson.type !== 'Feature' && geojson.type !== 'GeometryCollection')) {
              addStatusLog('warning', `Not a valid GeoJSON: ${gj.name}`);
              return;
            }
            const data = geojson.type === 'Feature'
              ? { type: 'FeatureCollection', features: [geojson] }
              : geojson;
            if (isSardineMarkup(data)) {
              applyMarkupGeoJSON(data, gj.name);
              return;
            }
            const id = `geojson-${Date.now()}-${gj.name}`;
            setDroppedGeoJSON(prev => [...prev, { id, name: gj.name, data }]);
            addStatusLog('info', `GeoJSON loaded: ${gj.name}`,
              `${(data.features?.length || 0)} features`);
          } catch (parseErr) {
            addStatusLog('error', `Failed to parse GeoJSON: ${gj.name}`, parseErr.message);
          }
        };
        reader.readAsText(gj);
      }
    } else if (pngFiles.length > 0) {
      // Settings restore from a SARdine-exported PNG — only the first one makes sense
      const file = pngFiles[0];
      if (pngFiles.length > 1) {
        addStatusLog('warning',
          `Only one PNG state file can be applied at a time — using ${file.name}`,
          `${pngFiles.length - 1} additional PNG file(s) ignored`);
      }
      extractStateFromPNG(file).then((state) => {
        if (!state) {
          addStatusLog('warning', `No SARdine state found in: ${file.name}`, 'Only SARdine-exported PNGs carry embedded state');
          return;
        }
        const restoredFile = state.filename || '(unknown)';
        if (nisarFile || cogUrl) {
          pendingPNGStateRef.current = state;
          applyPendingPNGState();
          addStatusLog('success', `Settings restored from: ${file.name}`, `Applied to current data`);
        } else {
          pendingPNGStateRef.current = state;
          addStatusLog('success', `Settings staged from: ${file.name}`,
            `Now drop the original data file to render: ${restoredFile}`);
        }
      }).catch((err) => {
        addStatusLog('error', `Failed to read PNG state: ${file.name}`, err.message);
      });
    } else if (knownCount === 0) {
      addStatusLog('warning', `Unsupported file type: ${files[0].name}`,
        'Drop .h5, .tif, .vrt (with its sources), .nitf, .geojson, or a SARdine-exported .png');
    }
  }, [handleNISARFileSelect, handleLocalTIFMultiSelect, handleNITFFileSelect, handleLoadVRT, appendMosaicTIFs, appendGcovMosaicFiles, fileType, nisarProductType, mosaicFiles, addStatusLog, nisarFile, cogUrl, applyPendingPNGState, applyMarkupGeoJSON]);

  // Handle remote file selection from DataDiscovery browser
  // Auth headers for the CURRENT token, not the one captured when the scene was
  // selected. Metadata and data loads are separate user actions — a token pasted
  // between them must take effect without re-selecting the scene. Falls back to
  // the headers built at select time for sources whose token came from a catalog
  // feature rather than the shared store.
  const currentFetchHeaders = useCallback(() => {
    const live = getEDLToken();
    if (live) return { 'Authorization': `Bearer ${live}`, 'X-EDL-Token': live };
    return handleRemoteFileSelect._fetchHeaders;
  }, []);

  const handleRemoteFileSelect = useCallback(async (fileInfo) => {
    const { url, name, size, type, token } = fileInfo;
    addStatusLog('info', `Remote file selected: ${name}`);

    // Store auth token for subsequent data fetches (e.g. Earthdata bearer token from STAC search)
    // Strip "Bearer " prefix if user already included it
    const cleanToken = token?.replace(/^Bearer\s+/i, '').trim();
    // Authorization for the dev proxy + DAAC direct; X-EDL-Token for the
    // hosted Worker. Header transport keeps the token out of URLs (and
    // therefore out of anything that logs request lines).
    const fetchHeaders = cleanToken
      ? { 'Authorization': `Bearer ${cleanToken}`, 'X-EDL-Token': cleanToken }
      : undefined;
    handleRemoteFileSelect._fetchHeaders = fetchHeaders;
    // Never print token material, even truncated — consoles get screenshotted.
    debugLog(`[SARdine] Token: ${cleanToken ? 'set' : 'none'}, URL: ${url.slice(0, 80)}`);
    if (!cleanToken) {
      // An Earthdata host without a token will 302 to EDL's OAuth endpoint and
      // 401 there, which reads like "your token is bad" when in fact none was
      // ever sent. Name the real cause up front for those hosts.
      const isEarthdataHost = (() => {
        try { return /(^|\.)(earthdata|earthdatacloud)\.nasa\.gov$/.test(new URL(url).hostname); }
        catch { return false; }
      })();
      if (isEarthdataHost) {
        addStatusLog('error',
          'No Earthdata token — this DAAC URL needs one. Open the Earthdata Login panel and paste a token, then reload the scene.');
      } else {
        addStatusLog('warning', 'No Earthdata token — DAAC data URLs require authentication');
      }
    }

    setSharedRawUrl(url);

    if (type === 'cog') {
      // COGs load through geotiff.js, which owns its own fetches and cannot be
      // given custom headers — so unlike the h5chunk path below, the token has
      // to ride in the query string or it is never sent at all. Stripping it
      // here left OPERA/DAAC COGs unauthenticated: the proxy 401s and the
      // layer vanishes mid-load.
      setCogUrl(proxyUrlShared(url));
      setFileType('cog');
      addStatusLog('info', `Loading COG from: ${url}`);
      return;
    }

    // Route external URLs through the appropriate CORS proxy
    // (Vite dev plugin in development, Cloudflare Worker on the hosted Pages
    // build). h5chunk makes Range requests directly to this.url, so we
    // rewrite once here. Token rides in fetchHeaders, not the query string.
    const resolvedUrl = proxyUrlShared(url, { tokenInQuery: false });

    // NISAR HDF5 — stream from URL
    setRemoteUrl(resolvedUrl);
    setRemoteName(name);
    setNisarDatasets([]);
    setLoading(true);
    setError(null);

    // W030: metadata streaming is cancellable too — a mis-pasted multi-GB URL
    // should be stoppable before any band is loaded.
    const metaController = new AbortController();
    const metaSignal = beginLoadAbort(metaController);

    try {
      addStatusLog('info', `Streaming NISAR metadata from: ${name}`);
      // Use the CURRENT token, not the one captured when the scene was
      // selected. Selecting a scene and loading it are separate user actions,
      // and a token pasted between them (or one already in the shared store
      // when the scene carried none) must take effect without re-selecting.
      const result = await listNISARDatasetsFromUrl(resolvedUrl,
        { fetchHeaders: currentFetchHeaders(), signal: metaSignal });
      const datasets = result.datasets || result;
      // Store the stream reader to reuse when loading (avoids re-downloading metadata)
      if (result._streamReader) {
        handleRemoteFileSelect._cachedReader = result._streamReader;
      }
      setNisarDatasets(datasets);

      if (datasets.length > 0) {
        // Prefer frequency B when available (deep-link pins win — W008 guard)
        const preferB = datasets.find(d => d.frequency === 'B') || datasets[0];
        if (!consumeDeepLinkPin('freq')) setSelectedFrequency(preferB.frequency);
        if (!consumeDeepLinkPin('pol')) setSelectedPolarization(preferB.polarization);

        // Apply auto-contrast immediately from metadata stats (before data
        // loads). Peek — don't consume — the pin here: the load-stage
        // auto-contrast in handleLoadRemoteNISAR consumes it so the pin
        // survives until the raster actually renders (W008 guard).
        const firstStats = preferB.stats;
        if (deepLinkPins.current.has('contrast')) {
          addStatusLog('info', 'Keeping deep-link contrast (metadata auto-contrast skipped)');
        } else if (firstStats?.mean_value > 0 && firstStats?.sample_stddev > 0) {
          const meanDb = toDb(firstStats.mean_value, 0);
          const stdDb = Math.abs(toDb(firstStats.sample_stddev / firstStats.mean_value, 0));
          setContrastMin(Math.round(meanDb - 2 * stdDb));
          setContrastMax(Math.round(meanDb + 2 * stdDb));
          addStatusLog('info', 'Auto-contrast from metadata',
            `${(meanDb - 2 * stdDb).toFixed(1)} to ${(meanDb + 2 * stdDb).toFixed(1)} dB`);
        }
      }

      const composites = getAvailableComposites(datasets);
      setAvailableComposites(composites);
      const remoteIndices = getAvailableIndices(datasets);
      setAvailableIndices(remoteIndices);
      if (remoteIndices.length > 0) {
        setIndexId(remoteIndices[0].id);
        setIndexForm(remoteIndices[0].form);
      }
      const autoComp = autoSelectComposite(datasets);
      // Deep-link comp/mode win over the auto-selection (one-shot pin)
      if (!consumeDeepLinkPin('comp')) {
        setCompositeId(autoComp);
        setDisplayMode('single');
      }

      addStatusLog('success', `Found ${datasets.length} remote datasets`,
        datasets.map(d => `${d.frequency}/${d.polarization}`).join(', '));

      // Show dataset controls — user clicks "Load" manually (NISAR files are
      // large). Exception (W016): a bbox/wkt deep link bounds the fetch to the
      // region, so auto-load the selected dataset instead of waiting.
      if (deepLinkAutoLoad.current && datasets.length > 0) {
        deepLinkAutoLoad.current = false;
        addStatusLog('info', 'Deep-link region present — loading dataset automatically');
        // Next tick: let the freq/pol state set above commit first, and let
        // handleLoadRemoteNISAR (defined below) bind its ref.
        setTimeout(() => handleLoadRemoteNISARRef.current?.(), 0);
      }
    } catch (e) {
      const isAuthErr = e.message?.includes('401') || e.message?.includes('403') || e.message?.includes('Unauthorized');
      // "Unexpired" is not "accepted": EDL revokes tokens, and only two are live
      // at a time, so generating a third silently kills the oldest — which still
      // decodes as valid locally. Report which token was actually sent (uid and
      // expiry) so a stale one is recognisable, and do not assert a cause we
      // have not observed.
      const tokenState = validateEDLToken(token || getEDLToken());
      const hint = isAuthErr
        ? (!tokenState.ok
            ? ` — ${tokenState.error} Open the Earthdata Login panel to set it.`
            : ` — The server rejected the token sent (${tokenState.username}, expires `
              + `${tokenState.expiresAt.toISOString().slice(0, 10)}). If that is not the token you `
              + 'just pasted, reload the page. Otherwise it has been revoked or superseded — EDL '
              + 'keeps only two live tokens — so generate a new one from your Earthdata profile.')
        : '';
      if (!isAbortError(e)) {
        // The loader already prefixes its own failures ("Failed to read remote
        // NISAR file: ..."), so prefixing again stutters. Pass its message
        // through and only add the auth hint.
        setError(`${e.message}${hint}`);
        addStatusLog('error', `Remote metadata read failed${hint}`, e.message);
      }
    } finally {
      endLoadAbort(metaController);
      setLoading(false);
    }
  }, [addStatusLog, beginLoadAbort, endLoadAbort, currentFetchHeaders]);

  // Keep the forward-ref pointed at the latest handleRemoteFileSelect so the
  // share-link effect can invoke it after mount (and after a token is pasted).
  useEffect(() => {
    handleRemoteFileSelectRef.current = handleRemoteFileSelect;
  }, [handleRemoteFileSelect]);

  useEffect(() => {
    handleNITFFileSelectRef.current = handleNITFFileSelect;
  }, [handleNITFFileSelect]);

  // If the share link points at a NISAR URL and the user just pasted a token,
  // fire the deferred load. urlCogTriggered.current holds {pendingNisar:{url,name}}.
  useEffect(() => {
    if (!shareLinkPending) return;
    if (!edlToken) return;
    const pending = urlCogTriggered.current?.pendingNisar;
    if (!pending) return;
    setShareLinkPending(false);
    urlCogTriggered.current = true;
    handleRemoteFileSelectRef.current?.({ url: pending.url, name: pending.name, size: 0, type: 'nisar' });
  }, [shareLinkPending, edlToken]);

  // Handle a manually pasted direct URL (pre-signed S3, public HTTPS, etc.)
  const handleDirectUrlSubmit = useCallback(() => {
    const url = directUrl.trim();
    if (!url) return;

    // Strip query string for extension detection; full URL (with pre-signed params) passes through
    const pathOnly = url.split('?')[0];
    const name = pathOnly.split('/').pop() || 'remote-file';

    let type;
    if (isNISARFile(pathOnly)) {
      type = 'nisar';
    } else if (isCOGFile(pathOnly)) {
      type = 'cog';
    } else {
      addStatusLog('warn', `Unknown extension for ${name}, treating as NISAR HDF5`);
      type = 'nisar';
    }

    // Attach the stored EDL token so pasted DAAC URLs authenticate in dev
    // (Authorization header through the Vite proxy) as well as hosted builds.
    handleRemoteFileSelect({ url, name, size: 0, type, token: getEDLToken() });
  }, [directUrl, handleRemoteFileSelect, addStatusLog]);

  // Load remote NISAR dataset by URL (single band or RGB composite)
  const handleLoadRemoteNISAR = useCallback(async () => {
    if (!remoteUrl) return;
    const gen = ++loadGenRef.current;

    // W030: load-scoped controller — Cancel must stop the range reads on the
    // wire, not just discard whatever comes back (that is what the pre-existing
    // `cancelled` flag idiom did, and why the transfer kept running).
    const loadController = new AbortController();
    const loadSignal = beginLoadAbort(loadController);

    setLoading(true);
    setLoadProgress(0);
    setLoadDetail(null);
    setError(null);

    // W030: the overview prefetch runs on past the load promise and is where a
    // remote granule's bytes actually move. Keep the bar and Cancel alive for
    // it — `loading` still clears on time so the first tiles can paint.
    let streamingTail = null;

    try {
      let data;

      if (displayMode === 'rgb' && compositeId) {
        // RGB composite mode — load multiple polarization bands from URL
        const requiredPols = getRequiredDatasets(compositeId);
        const requiredComplexPols = getRequiredComplexDatasets(compositeId);
        addStatusLog('info', `Loading remote RGB composite: ${compositeId} (${requiredPols.join(', ')}${requiredComplexPols.length ? ' + complex: ' + requiredComplexPols.join(', ') : ''})`);

        data = await loadNISARRGBComposite(remoteUrl, {
          frequency: selectedFrequency,
          compositeId,
          requiredPols,
          requiredComplexPols,
          _streamReader: handleRemoteFileSelect._cachedReader || imageData?._h5chunk || null,
          _chunkCaches: imageData?._chunkCaches || null,
          fetchHeaders: currentFetchHeaders(),
        });

        // In RGB mode, pass getRGBTile as getTile
        data.getTile = data.getRGBTile;

        // Eagerly warm chunk cache (fire-and-forget — tiles use coarse mosaic
        // from cached chunks while remaining chunks load in background)
        if (data.prefetchOverviewChunks) {
          data.prefetchOverviewChunks().catch(e =>
            console.warn('[SARdine] RGB overview prefetch failed:', e.message)
          );
        }

        addStatusLog('success', 'Remote RGB composite loaded',
          `${data.width}x${data.height}, Composite: ${compositeId}`);

        // Instant initial contrast from per-band stats (same as local file path)
        setUseDecibels(false);
        if (data.bandStats && Object.keys(data.bandStats).length > 0) {
          const preset = SAR_COMPOSITES[compositeId];
          if (preset?.channels) {
            const lims = {};
            for (const ch of ['R', 'G', 'B']) {
              const chDef = preset.channels[ch];
              if (chDef?.dataset && data.bandStats[chDef.dataset]) {
                const s = data.bandStats[chDef.dataset];
                const lo = Math.max(0, s.mean_value - 2 * s.sample_stddev);
                const hi = s.mean_value + 2 * s.sample_stddev;
                lims[ch] = [lo, hi];
              } else if (chDef?.datasets && chDef.datasets.length === 2) {
                const s0 = data.bandStats[chDef.datasets[0]];
                const s1 = data.bandStats[chDef.datasets[1]];
                if (s0 && s1) {
                  const ratio = s0.mean_value / Math.max(s1.mean_value, 1e-10);
                  lims[ch] = [ratio * 0.3, ratio * 3];
                } else {
                  lims[ch] = [0, 1];
                }
              } else {
                lims[ch] = [0, 1];
              }
            }
            setRgbContrastLimits(lims);
            setHistogramScope('viewport');
            addStatusLog('info', 'Initial contrast from band statistics',
              ['R', 'G', 'B'].map(ch => `${ch}: ${lims[ch][0].toExponential(2)}–${lims[ch][1].toExponential(2)}`).join(', '));
          }
        }
      } else if (displayMode === 'index') {
        // ── Remote GCOV scalar index (e.g. RVI) — single-band render ──
        addStatusLog('info', `Loading remote index: ${indexId} (${indexForm}-pol form)`);

        data = await loadNISARIndex(remoteUrl, {
          frequency: selectedFrequency,
          indexId,
          form: indexForm,
          _streamReader: handleRemoteFileSelect._cachedReader || imageData?._h5chunk || null,
          _chunkCaches: imageData?._chunkCaches || null,
          fetchHeaders: currentFetchHeaders(),
        });

        data.onRefine = () => setTileVersion(v => v + 1);
        if (data.prefetchOverviewChunks) {
          data.prefetchOverviewChunks().catch(e =>
            console.warn('[SARdine] Index overview prefetch failed:', e.message)
          );
        }

        setUseDecibels(!!data.indexUseDecibels);
        setContrastMin(data.indexRange?.[0] ?? 0);
        setContrastMax(data.indexRange?.[1] ?? 1);
        setColormap(data.indexColormap || 'viridis');

        addStatusLog('success', `Remote ${indexId.toUpperCase()} loaded`,
          `${data.width}x${data.height}, ${data.indexColormap}`);
      } else {
        // Single band mode
        addStatusLog('info', `Loading remote NISAR: ${selectedFrequency}/${selectedPolarization}`);

        data = await loadNISARGCOVFromUrl(remoteUrl, {
          frequency: selectedFrequency,
          polarization: selectedPolarization,
          _streamReader: handleRemoteFileSelect._cachedReader || null,
          fetchHeaders: currentFetchHeaders(),
          // W030: progress stays live across prefetchOverviewChunks() below —
          // that is where a remote granule actually spends its bytes.
          onProgress: handleLoadProgress,
          signal: loadSignal,
          // W016: deep-link region (WGS84) — scopes overview prefetch +
          // Phase-2 refinement to the intersecting chunks. Read pre-
          // consumption; applyDeepLinkRoi below consumes the ref.
          scopeBbox: deepLinkRoiRef.current?.bbox || undefined,
        });

        // Progressive refinement: when background Phase 2 completes, bump version
        // so SARViewer re-creates its TileLayer and fetches the refined tiles.
        if (data.mode === 'streaming') {
          data.onRefine = () => setTileVersion(v => v + 1);
          // Eagerly warm chunk cache (fire-and-forget — tiles use coarse mosaic
          // from cached chunks while remaining chunks load in background).
          // Keep the promise: the background histogram waits on it so its
          // tile sampling doesn't compete with the first-paint chunk fetch.
          if (data.prefetchOverviewChunks) {
            data._prefetchPromise = data.prefetchOverviewChunks().catch(e => {
              if (!isAbortError(e)) console.warn('[SARdine] Overview prefetch failed:', e.message);
            });
            streamingTail = data._prefetchPromise;
          }
        }

        addStatusLog('success', `Remote NISAR loaded: ${data.width}×${data.height}`,
          `URL: ${remoteUrl}`);

        // Use embedded HDF5 statistics for auto-contrast (same as local file
        // path). Peek the deep-link pin — the background histogram below is
        // the last auto-contrast in this flow and consumes it (W008 guard).
        if (data.stats && data.stats.mean_value !== undefined && !deepLinkPins.current.has('contrast')) {
          const { mean_value, sample_stddev } = data.stats;
          if (mean_value > 0 && sample_stddev > 0) {
            const meanDb = toDb(mean_value, 0);
            const stdDb = Math.abs(toDb(sample_stddev / mean_value, 0));
            setContrastMin(Math.round(meanDb - 2 * stdDb));
            setContrastMax(Math.round(meanDb + 2 * stdDb));
            addStatusLog('info', 'Auto-contrast from HDF5 statistics',
              `${(meanDb - 2 * stdDb).toFixed(1)} to ${(meanDb + 2 * stdDb).toFixed(1)} dB`);
          }
        }
      }

      if (gen !== loadGenRef.current) {
        debugLog('[SARdine] Stale load gen, skipping setImageData');
        return;
      }
      debugLog('[SARdine] Setting imageData:', data.width, 'x', data.height, 'bounds:', data.bounds);
      setImageData(data);

      // Auto-fit view only if this is a new scene (different track-frame)
      autoFitIfNewScene(data.bounds);

      // W016: deep-link ?bbox=/?wkt= — apply the region as ROI + WKT input and
      // refit the view to it (both state sets batch in this commit; the region
      // fit wins over the full-scene fit above).
      const dlRoi = applyDeepLinkRoi(data);

      // Auto-open OverviewMap when loading from CMR so user sees geographic context
      if (fileType === 'cmr') {
        setOverviewMapVisible(true);
      }

      // Compute histograms in background (don't block loading)
      if (displayMode === 'rgb' && data.getRGBTile) {
        // RGB histogram: sample a single center tile (not 3×3 grid) to avoid
        // hundreds of remote chunk fetches that would block the UI
        setUseDecibels(false); // Linear for RGB composites
        addStatusLog('info', 'Computing per-channel histograms in background...');
        const _histCompositeId = compositeId;
        (async () => {
          try {
            const tileSize = 256;
            const rawValues = { R: [], G: [], B: [] };
            // Sample center tile only — fast enough for remote
            // Use world-coordinate bounds for bbox
            const [rcMinX, rcMinY, rcMaxX, rcMaxY] = data.bounds;
            const rcCx = (rcMinX + rcMaxX) / 2;
            const rcCy = (rcMinY + rcMaxY) / 2;
            const rcHalf = (rcMaxX - rcMinX) / 6;
            const tileData = await data.getRGBTile({
              x: 0, y: 0, z: 0,
              bbox: { left: rcCx - rcHalf, top: rcCy - rcHalf, right: rcCx + rcHalf, bottom: rcCy + rcHalf },
              noCache: true,
            });
            if (tileData && tileData.bands) {
              const rgbBands = computeRGBBands(tileData.bands, _histCompositeId, tileSize);
              for (const ch of ['R', 'G', 'B']) {
                const arr = rgbBands[ch];
                for (let i = 0; i < arr.length; i += 4) {
                  if (arr[i] > 0 && !isNaN(arr[i])) rawValues[ch].push(arr[i]);
                }
              }
            }
            logHistogramPathOnce();
            const hists = {};
            const lims = {};
            for (const ch of ['R', 'G', 'B']) {
              const arr = rawValues[ch] instanceof Float32Array ? rawValues[ch] : new Float32Array(rawValues[ch]);
              const st = await computeChannelStatsAuto(arr, false);
              hists[ch] = st;
              lims[ch] = st ? [st.p2, st.p98] : [0, 1];
            }
            setHistogramData(hists);
            setRgbContrastLimits(lims);
            addStatusLog('success', 'Per-channel contrast set (linear 2–98%)',
              ['R', 'G', 'B'].map(ch => hists[ch] ? `${ch}: ${lims[ch][0].toExponential(2)}–${lims[ch][1].toExponential(2)}` : '').join(', '));
          } catch (e) {
            addStatusLog('warning', 'Background histogram failed', e.message);
          }
        })();
      } else if (data.getTile) {
        // Single-band histogram — also run in background for remote
        addStatusLog('info', 'Computing histogram in background...');
        (async () => {
          try {
            // Let the first-paint chunk prefetch finish before sampling —
            // histogram reads would compete with it for bandwidth.
            if (data._prefetchPromise) await data._prefetchPromise;
            // Sample using world-coordinate bounds so getTile receives world-space
            // bboxes. W016: when a deep-link region is active, sample the region
            // instead of the full scene — contrast matches the AOI and the
            // sampling doesn't pull out-of-region chunks.
            const [gMinX, gMinY, gMaxX, gMaxY] = dlRoi?.bboxFileCrs || data.bounds;
            logHistogramPathOnce();
            let stats = null;
            if (data.mode === 'streaming') {
              // Streaming loaders: the z0 overview mosaic is already a spatial
              // sample of the full image and sits in the chunk cache after
              // prefetch — one background tile, zero new bytes. (The old 3×3
              // sampleViewportStats grid re-fetched most of the raster.)
              const overviewTile = await data.getTile({
                x: 0, y: 0, z: 0,
                bbox: { left: gMinX, top: gMinY, right: gMaxX, bottom: gMaxY },
                background: true,
              });
              if (overviewTile?.data) {
                stats = await computeChannelStatsAuto(overviewTile.data, effectiveUseDecibels, 128);
              }
            }
            if (!stats) {
              stats = await sampleViewportStatsAuto(
                data.getTile, gMaxX - gMinX, gMaxY - gMinY, effectiveUseDecibels, 128,
                gMinX, gMinY,
              );
            }
            if (stats) {
              setHistogramData({ single: stats });
              if (consumeDeepLinkPin('contrast')) {
                addStatusLog('info', 'Keeping deep-link contrast (auto-contrast skipped)');
              } else {
                setContrastMin(Number(stats.p2.toFixed(effectiveUseDecibels ? 1 : 3)));
                setContrastMax(Number(stats.p98.toFixed(effectiveUseDecibels ? 1 : 3)));
                const unit = effectiveUseDecibels ? 'dB' : '';
                addStatusLog('success', `Auto-contrast: ${stats.p2.toFixed(effectiveUseDecibels ? 1 : 3)} to ${stats.p98.toFixed(effectiveUseDecibels ? 1 : 3)} ${unit}`);
              }
            }
          } catch (e) {
            addStatusLog('warning', 'Background histogram failed', e.message);
          }
        })();
      }
    } catch (e) {
      if (!isAbortError(e)) {
        setError(`Failed to load remote NISAR: ${e.message}`);
        addStatusLog('error', 'Remote load failed', e.message);
      }
    } finally {
      setLoading(false);
      if (streamingTail) {
        streamingTail.finally(() => { endLoadAbort(loadController); resetLoadProgress(); });
      } else {
        endLoadAbort(loadController);
        resetLoadProgress();
      }
    }
  }, [remoteUrl, selectedFrequency, selectedPolarization, displayMode, compositeId, useDecibels, fileType, addStatusLog, autoFitIfNewScene, applyDeepLinkRoi, logHistogramPathOnce, beginLoadAbort, endLoadAbort, handleLoadProgress, resetLoadProgress]);

  // Keep the forward-ref current so the deep-link auto-load (bbox links only,
  // W016) can fire it from handleRemoteFileSelect, which is defined earlier.
  useEffect(() => {
    handleLoadRemoteNISARRef.current = handleLoadRemoteNISAR;
  }, [handleLoadRemoteNISAR]);

  // Note: Auto-load removed — NISAR files are large (multi-GB), user clicks "Load" manually
  // after selecting a granule and reviewing the dataset/frequency/polarization options.
  // Exception: bbox/wkt deep links auto-load (bounded fetch, see above).

  // Load selected NISAR dataset (single band or RGB composite)
  const handleLoadNISAR = useCallback(async () => {
    if (!nisarFile) {
      setError('Please select a NISAR HDF5 file');
      addStatusLog('error', 'No NISAR file selected');
      return;
    }

    // W030: a load-scoped controller so Cancel actually stops the read stream.
    const loadController = new AbortController();
    const loadSignal = beginLoadAbort(loadController);

    setLoading(true);
    setLoadProgress(0);
    setLoadDetail(null);
    setError(null);

    try {
      let data;

      if (displayMode === 'multi-temporal') {
        // ── Multi-temporal RGB: same dataset from 3 separate files (GCOV or GUNW) ──
        const mtFiles = [nisarFile, nisarFile2, nisarFile3].filter(Boolean);
        if (mtFiles.length < 2) {
          throw new Error('Select at least 2 files for multi-temporal RGB');
        }
        const channelNames = ['R', 'G', 'B'];
        const isGUNW = nisarProductType === 'GUNW';
        const dsLabel = isGUNW
          ? `${selectedLayer}/${selectedGunwDataset} (${selectedPolarization})`
          : `${selectedFrequency}/${selectedPolarization}`;
        addStatusLog('info',
          `Loading multi-temporal RGB: ${dsLabel} from ${mtFiles.length} files`);

        const mtLoaders = await Promise.all(
          mtFiles.map((f, i) => {
            addStatusLog('info', `  File ${i + 1} (${channelNames[i]}): ${f.name}`);
            if (isGUNW) {
              return loadNISARGUNW(f, {
                frequency: selectedFrequency,
                layer: selectedLayer,
                polarization: selectedPolarization,
                dataset: selectedGunwDataset,
              });
            }
            return loadNISARGCOV(f, {
              frequency: selectedFrequency,
              polarization: selectedPolarization,
            });
          })
        );

        const { bounds, width, height, crs } = mtLoaders[0];

        const getRGBTile = async (tileArgs) => {
          const results = await Promise.all(mtLoaders.map(l => l.getTile(tileArgs)));
          const validResult = results.find(r => r?.data);
          if (!validResult) return null;
          const bands = {};
          for (let i = 0; i < 3; i++) {
            const r = i < mtLoaders.length ? results[i] : null;
            bands[channelNames[i]] = r?.data || new Float32Array(validResult.data.length);
          }
          return { bands, width: validResult.width, height: validResult.height, compositeId: 'multi-temporal' };
        };

        data = { bounds, width, height, crs, getRGBTile, getTile: getRGBTile };
        setCompositeId('multi-temporal');
        // Multi-temporal uses linear scale by default (coherence is 0–1; GCOV power users
        // can still enable dB via the scale toggle after loading)
        setUseDecibels(false);
        useDecibelsRef.current = false; // pre-sync so the useDecibels effect doesn't fire
        if (isGUNW) {
          // Set per-channel contrast limits from the first loader's render mode default,
          // otherwise fall back to [0, 1] (correct for coherence/magnitude datasets).
          const rm0 = mtLoaders[0]?.renderMode;
          const dr = rm0?.defaultRange || [0, 1];
          setRgbContrastLimits({ R: [dr[0], dr[1]], G: [dr[0], dr[1]], B: [dr[0], dr[1]] });
        } else {
          // GCOV multi-temporal: default linear contrast, refined when user selects viewport scope.
          setRgbContrastLimits({ R: [0, 0.5], G: [0, 0.5], B: [0, 0.5] });
        }
        // Skip the auto-triggered histogram recompute on load for all multi-temporal types.
        // The user can trigger it via the scope selector (Viewport button).
        skipInitialHistogramRef.current = true;
        skipViewportRefreshRef.current = true;
        addStatusLog('success', 'Multi-temporal RGB loaded',
          `${width}x${height}, Files: ${mtFiles.map(f => f.name).join(' / ')}`);

      } else if (nisarProductType === 'GUNW') {
        // ── GUNW loading path ──
        const dsLabel = `${selectedLayer}/${selectedGunwDataset} (${selectedPolarization})`;
        addStatusLog('info', `Loading GUNW dataset: ${dsLabel}`);

        data = await loadNISARGUNW(nisarFile, {
          frequency: selectedFrequency,
          layer: selectedLayer,
          polarization: selectedPolarization,
          dataset: selectedGunwDataset,
          withCoherence: true,  // Always load coherence — checkbox controls shader masking
          _streamReader: gunwDatasets?._streamReader || null,
        });

        addStatusLog('success', 'GUNW dataset loaded',
          `${data.width}x${data.height}, CRS: ${data.crs || 'N/A'}, bounds: [${(data.bounds || []).map(b => b.toFixed(2)).join(', ')}]`);

        // Apply render mode defaults — GUNW uses linear scaling, not dB
        const rm = data.renderMode || {};
        setUseDecibels(rm.transform === 'dB');
        if (rm.colormap) setColormap(rm.colormap);
        if (rm.defaultRange) {
          setContrastMin(rm.defaultRange[0]);
          setContrastMax(rm.defaultRange[1]);
        } else if (data.attributes) {
          // Use HDF5 valid_min/valid_max attributes for initial contrast if available
          const attrs = data.attributes;
          const vMin = attrs.valid_min ?? attrs.valid_range?.[0];
          const vMax = attrs.valid_max ?? attrs.valid_range?.[1];
          if (vMin != null && vMax != null && isFinite(vMin) && isFinite(vMax)) {
            const isDiverging = rm.colormap === 'rdbu' || rm.colormap === 'diverging';
            if (isDiverging) {
              const absMax = Math.max(Math.abs(vMin), Math.abs(vMax));
              setContrastMin(Number((-absMax).toFixed(3)));
              setContrastMax(Number(absMax.toFixed(3)));
            } else {
              setContrastMin(Number(Number(vMin).toFixed(3)));
              setContrastMax(Number(Number(vMax).toFixed(3)));
            }
            addStatusLog('info', `Initial contrast from metadata: ${vMin} to ${vMax} ${rm.unit || ''}`);
          }
        }

        // Load incidence angle grid from GUNW radarGrid metadata cube
        try {
          const reader = data._streamReader || gunwDatasets?._streamReader;
          const band = data.band || 'LSAR';
          if (reader) {
            const cube = await loadMetadataCube(reader, band, { product: 'GUNW', fields: ['incidenceAngle'] });
            if (cube && cube.fields.incidenceAngle) {
              // Evaluate on a coarse grid matching image extent
              const iaWidth = Math.min(512, data.width);
              const iaHeight = Math.min(512, data.height);
              // Build coordinate arrays spanning the image bounds
              const [bMinX, bMinY, bMaxX, bMaxY] = data.bounds;
              const iaXCoords = new Float64Array(iaWidth);
              const iaYCoords = new Float64Array(iaHeight);
              for (let i = 0; i < iaWidth; i++) iaXCoords[i] = bMinX + (i / (iaWidth - 1)) * (bMaxX - bMinX);
              for (let i = 0; i < iaHeight; i++) iaYCoords[i] = bMaxY - (i / (iaHeight - 1)) * (bMaxY - bMinY);
              const iaGrid = cube.evaluateOnGrid('incidenceAngle', iaXCoords, iaYCoords, iaWidth, iaHeight, null, 4);
              setGunwIncidenceAngleGrid({ data: iaGrid, width: iaWidth, height: iaHeight });
              const angles = Array.from(iaGrid).filter(v => !isNaN(v));
              if (angles.length > 0) {
                const sorted = angles.sort((a, b) => a - b);
                addStatusLog('info', `GUNW incidence angle: ${sorted[0].toFixed(1)}°–${sorted[sorted.length - 1].toFixed(1)}°`);
              }
            } else {
              setGunwIncidenceAngleGrid(null);
            }
          }
        } catch (e) {
          console.warn('[main] Failed to load GUNW incidence angle grid:', e);
          setGunwIncidenceAngleGrid(null);
        }

        // Load phase correction layers (iono, tropo, SET) in background
        if (selectedGunwDataset === 'unwrappedPhase') {
          try {
            const reader = data._streamReader || gunwDatasets?._streamReader;
            const band = data.band || 'LSAR';
            if (reader) {
              addStatusLog('info', 'Loading phase correction layers...');
              const corrections = await loadAllCorrections(
                reader, band, selectedFrequency, selectedPolarization,
                { bounds: data.bounds, width: data.width, height: data.height }
              );
              setCorrectionLayers(corrections);
              setEnabledCorrections(new Set());

              const available = Object.keys(corrections);
              if (available.length > 0) {
                addStatusLog('success', `Phase corrections available: ${available.map(k => CORRECTION_TYPES[k]?.label || k).join(', ')}`);
              } else {
                addStatusLog('info', 'No phase correction layers found in this GUNW product');
              }
            }
          } catch (e) {
            console.warn('[main] Failed to load phase corrections:', e);
            setCorrectionLayers(null);
          }
        } else {
          setCorrectionLayers(null);
          setEnabledCorrections(new Set());
        }
      } else if (displayMode === 'index') {
        // ── GCOV scalar index mode (e.g. RVI) — single-band render ──
        addStatusLog('info', `Loading index: ${indexId} (${indexForm}-pol form)`);

        data = await loadNISARIndex(nisarFile, {
          frequency: selectedFrequency,
          indexId,
          form: indexForm,
          _streamReader: imageData?._h5chunk || null,
          _chunkCaches: imageData?._chunkCaches || null,
        });

        data.onRefine = () => setTileVersion(v => v + 1);

        // Auto-apply index render settings: linear scale, index range, colormap.
        setUseDecibels(!!data.indexUseDecibels);
        setContrastMin(data.indexRange?.[0] ?? 0);
        setContrastMax(data.indexRange?.[1] ?? 1);
        setColormap(data.indexColormap || 'viridis');

        addStatusLog('success', `${indexId.toUpperCase()} loaded`,
          `${data.width}x${data.height}, range ${data.indexRange?.[0]}–${data.indexRange?.[1]}, ${data.indexColormap}`);
      } else if (displayMode === 'rgb' && compositeId) {
        // ── GCOV RGB composite mode ──
        const requiredPols = getRequiredDatasets(compositeId);
        const requiredComplexPols = getRequiredComplexDatasets(compositeId);
        addStatusLog('info', `Loading RGB composite: ${compositeId} (${requiredPols.join(', ')}${requiredComplexPols.length ? ' + complex: ' + requiredComplexPols.join(', ') : ''})`);

        data = await loadNISARRGBComposite(nisarFile, {
          frequency: selectedFrequency,
          compositeId,
          requiredPols,
          requiredComplexPols,
          _streamReader: imageData?._h5chunk || null,
          _chunkCaches: imageData?._chunkCaches || null,
        });

        // In RGB mode, pass getRGBTile as getTile
        data.getTile = data.getRGBTile;

        addStatusLog('success', 'RGB composite loaded',
          `${data.width}x${data.height}, Composite: ${compositeId}`);
      } else {
        // ── GCOV single band mode ──
        addStatusLog('info', `Loading NISAR dataset: ${selectedFrequency}/${selectedPolarization}`);

        data = await loadNISARGCOV(nisarFile, {
          frequency: selectedFrequency,
          polarization: selectedPolarization,
          onProgress: handleLoadProgress,
          signal: loadSignal,
        });

        addStatusLog('success', 'NISAR dataset loaded',
          `${data.width}x${data.height}, CRS: ${data.crs}`);

        // Progressive refinement: coarse grid → full-res in background
        data.onRefine = () => setTileVersion(v => v + 1);

        // Use embedded statistics for auto-contrast if available
        if (data.stats && data.stats.mean_value !== undefined) {
          const { mean_value, sample_stddev } = data.stats;
          if (mean_value > 0 && sample_stddev > 0) {
            const meanDb = toDb(mean_value, 0);
            const stdDb = Math.abs(toDb(sample_stddev / mean_value, 0));
            setContrastMin(Math.round(meanDb - 2 * stdDb));
            setContrastMax(Math.round(meanDb + 2 * stdDb));
            addStatusLog('info', 'Auto-contrast from HDF5 statistics',
              `${(meanDb - 2 * stdDb).toFixed(1)} to ${(meanDb + 2 * stdDb).toFixed(1)} dB`);
          }
        }
      }

      setImageData(data);
      // Bump tileVersion so deck.gl invalidates its TileLayer cache and fetches new tiles.
      // Without this, switching datasets (e.g. unwrappedPhase → coherenceMagnitude) keeps
      // stale tile data from the previous load.
      setTileVersion(v => v + 1);

      // Compute incidence angle grid from metadata cube (GCOV only)
      if (data.metadataCube && data.xCoords && data.yCoords) {
        try {
          const iaWidth = Math.min(512, data.width);
          const iaHeight = Math.min(512, data.height);
          const ml = Math.max(1, Math.floor(data.width / iaWidth));
          const iaGrid = data.metadataCube.evaluateAllFields(
            data.xCoords, data.yCoords, iaWidth, iaHeight, ml
          );
          if (iaGrid.incidenceAngle) {
            setIncidenceAngleGrid({ data: iaGrid.incidenceAngle, width: iaWidth, height: iaHeight });
            const angles = Array.from(iaGrid.incidenceAngle).filter(v => !isNaN(v));
            if (angles.length > 0) {
              const sorted = angles.sort((a, b) => a - b);
              setIncAngleMin(Math.floor(sorted[0]));
              setIncAngleMax(Math.ceil(sorted[sorted.length - 1]));
              addStatusLog('info', `Incidence angle: ${sorted[0].toFixed(1)}° – ${sorted[sorted.length - 1].toFixed(1)}°`);
            }
          }
          // Compute scatter plot data (backscatter vs incidence angle)
          sampleScatterData(data).then(sd => {
            if (sd) setIncidenceScatterData(sd);
          }).catch(() => {});
        } catch (e) {
          console.warn('[main] Failed to compute incidence angle grid:', e);
        }
      } else {
        setIncidenceAngleGrid(null);
        setIncidenceScatterData(null);
      }

      // Auto-fit view only if this is a new scene (different track-frame)
      autoFitIfNewScene(data.bounds);

      // Set scale mode for RGB — React 18 batches this with setImageData above,
      // so the useEffect-triggered histogram recompute sees useDecibels=false.
      if (isRGBDisplayMode) {
        setUseDecibels(false);

        // Instant initial contrast from per-band center-chunk statistics.
        // Uses mean ± 2*stddev as p2/p98 proxy — rough but immediate.
        // Viewport histogram refines contrast once the user sees the image.
        if (data.bandStats && Object.keys(data.bandStats).length > 0) {
          const preset = SAR_COMPOSITES[compositeId];
          if (preset?.channels) {
            const lims = {};
            for (const ch of ['R', 'G', 'B']) {
              const chDef = preset.channels[ch];
              if (chDef?.dataset && data.bandStats[chDef.dataset]) {
                // Direct band → channel: use log-normal p2/p98 from band stats
                const s = data.bandStats[chDef.dataset];
                const { p2, p98 } = computeLogNormalHist(s.mean_value, s.sample_stddev);
                lims[ch] = [p2, p98];
              } else if (chDef?.datasets && chDef.datasets.length === 2) {
                // Ratio channel (e.g. HH/HV): estimate from constituent bands
                const s0 = data.bandStats[chDef.datasets[0]];
                const s1 = data.bandStats[chDef.datasets[1]];
                if (s0 && s1) {
                  const ratio = s0.mean_value / Math.max(s1.mean_value, 1e-10);
                  lims[ch] = [ratio * 0.3, ratio * 3];
                } else {
                  lims[ch] = [0, 1];
                }
              } else {
                lims[ch] = [0, 1];
              }
            }
            setRgbContrastLimits(lims);
            // Pre-sync the useDecibels ref so its change-detection effect doesn't fire
            useDecibelsRef.current = false;

            // Build synthetic per-channel histograms from band stats so the histogram
            // panel renders immediately without sampling any tiles.
            // Uses log-normal model — SAR power is right-skewed, Gaussian assumption
            // clamps to 0 and squishes all bins to the left edge.
            const syntheticHists = {};
            for (const ch of ['R', 'G', 'B']) {
              const chDef = preset.channels[ch];
              const s = chDef?.dataset && data.bandStats[chDef.dataset];
              if (s && s.mean_value > 0 && s.sample_stddev > 0) {
                syntheticHists[ch] = computeLogNormalHist(s.mean_value, s.sample_stddev);
              } else {
                // Ratio channel or missing stats — flat histogram over the contrast range
                const [clo, chi] = lims[ch];
                const numBins = 128;
                const binWidth = (chi - clo) / numBins;
                const bins = new Array(numBins).fill(1000 / numBins);
                syntheticHists[ch] = { bins, min: clo, max: chi, mean: (clo + chi) / 2,
                  binWidth, count: 1000, p2: clo, p98: chi };
              }
            }
            // Store synthetic histograms from band stats as 'Metadata' histogram.
            // Switching to Viewport triggers live GPU-accelerated computation.
            // Skip tile-sampling recompute on load — metadata contrast already applied.
            setHistogramData(syntheticHists);
            skipInitialHistogramRef.current = true;
            skipViewportRefreshRef.current = true;
            addStatusLog('info', 'Initial contrast from metadata',
              ['R', 'G', 'B'].map(ch => `${ch}: ${lims[ch][0].toExponential(2)}–${lims[ch][1].toExponential(2)}`).join(', '));
          }
        }
      }

      // For GUNW with a default render-mode range, apply it immediately (no tile reads)
      if (nisarProductType === 'GUNW' && data.renderMode?.defaultRange) {
        const rm = data.renderMode;
        addStatusLog('success', `Using default range: ${rm.defaultRange[0]} to ${rm.defaultRange[1]} ${rm.unit || ''}`);
      }

      // Single-band auto-contrast from HDF5 stats is already applied above
      // (inside the GCOV single-band loading block, lines ~2156-2167).

      // Histogram computation runs non-blocking via useEffect → handleRecomputeHistogram
      // after setImageData triggers a re-render. This avoids blocking the UI for
      // large files (previously 60+ seconds for 7 GB GCOV RGB composites).

      addStatusLog('success', `NISAR ${nisarProductType} loaded and ready to display`);
    } catch (e) {
      // A user cancel is not a failure — it already logged itself.
      if (!isAbortError(e)) {
        setError(`Failed to load NISAR dataset: ${e.message}`);
        setImageData(null);
        addStatusLog('error', 'Failed to load NISAR dataset', e.message);
        console.error('NISAR loading error:', e);
      }
    } finally {
      endLoadAbort(loadController);
      setLoading(false);
      resetLoadProgress();
    }
  }, [nisarFile, nisarFile2, nisarFile3, nisarProductType, selectedFrequency, selectedPolarization, selectedLayer, selectedGunwDataset, displayMode, compositeId, gunwDatasets, addStatusLog, autoFitIfNewScene, beginLoadAbort, endLoadAbort, handleLoadProgress, resetLoadProgress]);

  // Export current view as GeoTIFF
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const handleExportGeoTIFF = useCallback(async () => {
    if (!imageData) {
      addStatusLog('error', 'No image data to export');
      return;
    }

    if (!imageData.getExportStripe) {
      addStatusLog('error', 'Export not available for this data source (requires NISAR streaming loader)');
      return;
    }

    setExporting(true);
    const exportStart = performance.now();
    addStatusLog('info', '--- GeoTIFF Export Started ---');
    debugLog('[Export] GeoTIFF export started');

    // Yield to browser so "Exporting..." button state renders before heavy work
    await new Promise(resolve => setTimeout(resolve, 0));

    try {
      const sourceWidth = imageData.width;
      const sourceHeight = imageData.height;

      // Use the user's selected multilook factor, clamped to valid range
      let effectiveMl = Math.max(1, Math.min(128, exportMultilookWindow || 1));

      // If ROI is set, export only the selected region
      const roiActive = roi && roi.width > 0 && roi.height > 0;

      // Clamp ROI to source data bounds before computing export dimensions
      let roiClamped = roi;
      if (roiActive) {
        const cl = Math.max(0, Math.min(roi.left, sourceWidth));
        const ct = Math.max(0, Math.min(roi.top, sourceHeight));
        const cr = Math.max(cl, Math.min(roi.left + roi.width, sourceWidth));
        const cb = Math.max(ct, Math.min(roi.top + roi.height, sourceHeight));
        roiClamped = { left: cl, top: ct, width: cr - cl, height: cb - ct };
      }

      const roiStartCol = roiActive ? Math.floor(roiClamped.left / effectiveMl) : 0;
      const roiStartRow = roiActive ? Math.floor(roiClamped.top / effectiveMl) : 0;
      // Round the far edge UP to the next multilook boundary so the export covers the
      // full user selection (floor would silently drop up to ml-1 pixels at the edge).
      // Cap at the image's own integer-ml limit to avoid reading past source data.
      const maxExportCol = Math.floor(sourceWidth / effectiveMl);
      const maxExportRow = Math.floor(sourceHeight / effectiveMl);
      const roiEndCol = roiActive
        ? Math.min(Math.ceil(Math.min(roiClamped.left + roiClamped.width, sourceWidth) / effectiveMl), maxExportCol)
        : maxExportCol;
      const roiEndRow = roiActive
        ? Math.min(Math.ceil(Math.min(roiClamped.top + roiClamped.height, sourceHeight) / effectiveMl), maxExportRow)
        : maxExportRow;
      const exportWidth = roiEndCol - roiStartCol;
      const exportHeight = roiEndRow - roiStartRow;

      // Guard against zero-size exports (ROI smaller than multilook window)
      if (exportWidth < 1 || exportHeight < 1) {
        addStatusLog('error', `ROI too small for multilook ${effectiveMl}x${effectiveMl}. ` +
          `Need at least ${effectiveMl}x${effectiveMl} pixels, got ${roiClamped?.width || 0}x${roiClamped?.height || 0}.`);
        setExporting(false);
        return;
      }

      // Log when the ROI was snapped to the multilook grid
      if (roiActive) {
        const snappedLeft   = roiStartCol * effectiveMl;
        const snappedTop    = roiStartRow * effectiveMl;
        const snappedRight  = roiEndCol   * effectiveMl;
        const snappedBottom = roiEndRow   * effectiveMl;
        const reqRight  = Math.min(roiClamped.left + roiClamped.width,  sourceWidth);
        const reqBottom = Math.min(roiClamped.top  + roiClamped.height, sourceHeight);
        if (snappedLeft !== roiClamped.left || snappedTop !== roiClamped.top ||
            snappedRight !== reqRight || snappedBottom !== reqBottom) {
          addStatusLog('info',
            `ROI snapped to ${effectiveMl}px multilook grid: ` +
            `source cols ${snappedLeft}–${snappedRight}, rows ${snappedTop}–${snappedBottom}`);
        }
      }

      // Warn if per-band allocation is very large (modern 64-bit browsers
      // support ArrayBuffers well beyond 2 GB, but system RAM is the real limit)
      const perBandBytes = exportWidth * exportHeight * 4;
      if (perBandBytes > 6e9) {
        addStatusLog('error', `Single band too large (${(perBandBytes / 1e9).toFixed(1)}GB). Increase multilook to reduce size.`);
        setExporting(false);
        return;
      }
      if (perBandBytes > 2e9) {
        addStatusLog('warning', `Large allocation: ${(perBandBytes / 1e9).toFixed(1)}GB per band — ensure sufficient RAM`);
      }

      // Extract EPSG from CRS string
      const epsgMatch = imageData.crs?.match(/EPSG:(\d+)/);
      const epsgCode = epsgMatch ? parseInt(epsgMatch[1]) : 32610;

      // Band names from the loaded data's required polarizations
      // Single-band: ['HHHH'], RGB composite: ['HHHH', 'HVHV', 'VVVV'], etc.
      const bandNames = imageData.requiredPols || [imageData.polarization || 'HHHH'];

      // Complex band names (e.g. HHVV → HHVV_re, HHVV_im) for decompositions
      const complexBandNames = [];
      if (imageData.requiredComplexPols) {
        for (const cpol of imageData.requiredComplexPols) {
          complexBandNames.push(`${cpol}_re`, `${cpol}_im`);
        }
      }

      addStatusLog('info', `Source: ${sourceWidth} x ${sourceHeight}`);
      if (roiActive) {
        addStatusLog('info', `ROI: ${roiClamped.width} x ${roiClamped.height} px @ (${roiClamped.left}, ${roiClamped.top})`);
        addStatusLog('info', `ROI export grid: startCol=${roiStartCol}, startRow=${roiStartRow}, ${exportWidth}x${exportHeight}`);
      }
      addStatusLog('info', `Multilook: ${effectiveMl}x${effectiveMl} (integer)`);
      addStatusLog('info', `Export: ${exportWidth} x ${exportHeight}`);
      const isRendered = exportMode === 'rendered';
      addStatusLog('info', `Bands: ${bandNames.join(', ')} (${isRendered ? 'RGBA rendered' : 'Float32, raw linear power'})`);
      addStatusLog('info', `EPSG: ${epsgCode}`);
      if (isRendered) {
        if (isRGBDisplayMode && compositeId && effectiveContrastLimits && !Array.isArray(effectiveContrastLimits)) {
          const limStr = ['R', 'G', 'B'].map(ch => {
            const lim = effectiveContrastLimits[ch];
            return lim ? `${ch}:[${lim[0].toExponential(1)},${lim[1].toExponential(1)}]` : '';
          }).filter(Boolean).join(' ');
          addStatusLog('info', `Render: composite="${compositeId}", ${effectiveUseDecibels ? 'dB' : 'linear'}, per-channel ${limStr}, ${stretchMode}, gamma=${gamma}`);
        } else {
          addStatusLog('info', `Render: ${effectiveUseDecibels ? 'dB' : 'linear'}, contrast [${contrastMin}, ${contrastMax}], ${colormap}, ${stretchMode}, gamma=${gamma}`);
        }
        addStatusLog('info', `Format: GeoTIFF (RGBA uint8, 512x512 tiles, DEFLATE)`);
      } else {
        addStatusLog('info', `Format: GeoTIFF (Float32, 512x512 tiles, DEFLATE)`);
      }

      // Allocate output arrays for each band (power + complex)
      const bands = {};
      const allBandNames = [...bandNames, ...complexBandNames];

      // Check total memory across all bands (not just per-band)
      const totalBandBytes = allBandNames.length * exportWidth * exportHeight * 4;
      if (totalBandBytes > 6e9) {
        addStatusLog('error',
          `Total band allocation too large (${(totalBandBytes / 1e9).toFixed(1)} GB across ` +
          `${allBandNames.length} bands). Increase multilook to reduce size.`);
        setExporting(false);
        return;
      }
      if (totalBandBytes > 2e9) {
        addStatusLog('warning',
          `Large allocation: ${(totalBandBytes / 1e9).toFixed(1)} GB total across ` +
          `${allBandNames.length} bands — ensure sufficient RAM`);
      }

      for (const name of allBandNames) {
        bands[name] = new Float32Array(exportWidth * exportHeight);
      }

      // Stripe-based reading: 256 output rows per stripe
      const stripeRows = 256;
      const numStripes = Math.ceil(exportHeight / stripeRows);

      for (let s = 0; s < numStripes; s++) {
        const startRow = s * stripeRows;
        const numRows = Math.min(stripeRows, exportHeight - startRow);

        addStatusLog('info', `Reading stripe ${s + 1}/${numStripes} (rows ${startRow}-${startRow + numRows - 1})...`);
        setExportProgress(Math.round((s / numStripes) * 50));

        const stripe = await imageData.getExportStripe({
          startRow: roiActive ? roiStartRow + startRow : startRow,
          numRows,
          ml: effectiveMl,
          exportWidth,
          ...(roiActive ? { startCol: roiStartCol, numCols: exportWidth } : {}),
        });

        // Copy stripe data into output arrays (power + complex bands).
        // Single-band loaders (COG, plain TIF) emit `band0` rather than a
        // polarization-named key — alias it to the single requested band so
        // the export gets real data instead of zeros.
        for (const name of allBandNames) {
          const src = stripe.bands[name]
            || (allBandNames.length === 1 ? stripe.bands.band0 : null);
          if (src) {
            bands[name].set(src, startRow * exportWidth);
          }
        }
      }

      addStatusLog('info', 'Encoding GeoTIFF...');
      setExportProgress(50);
      await new Promise(r => setTimeout(r, 0));

      // --- Append metadata cube fields as extra bands ---
      if (imageData.metadataCube && imageData.xCoords && imageData.yCoords) {
        addStatusLog('info', 'Evaluating metadata cube fields on export grid...');
        try {
          // When ROI is active, pass only the coordinate subset covering the ROI
          // so the metadata cube evaluates at the correct geographic positions.
          let cubeXCoords = imageData.xCoords;
          let cubeYCoords = imageData.yCoords;
          if (roiActive) {
            // Use multilook-aligned origin to match getExportStripe data
            const dataOriginCol = roiStartCol * effectiveMl;
            const dataOriginRow = roiStartRow * effectiveMl;
            const dataEndCol = dataOriginCol + exportWidth * effectiveMl;
            const dataEndRow = dataOriginRow + exportHeight * effectiveMl;
            const xStart = Math.min(dataOriginCol, imageData.xCoords.length);
            const xEnd = Math.min(dataEndCol, imageData.xCoords.length);
            const yStart = Math.min(dataOriginRow, imageData.yCoords.length);
            const yEnd = Math.min(dataEndRow, imageData.yCoords.length);
            cubeXCoords = imageData.xCoords.subarray(xStart, xEnd);
            cubeYCoords = imageData.yCoords.subarray(yStart, yEnd);
          }
          const cubeFields = imageData.metadataCube.evaluateAllFields(
            cubeXCoords,
            cubeYCoords,
            exportWidth,
            exportHeight,
            effectiveMl,
            null, // ground layer (no DEM)
          );

          const cubeFieldNames = Object.keys(cubeFields);
          for (const name of cubeFieldNames) {
            bands[name] = cubeFields[name];
            bandNames.push(name);
          }
          addStatusLog('success', `Added ${cubeFieldNames.length} metadata bands: ${cubeFieldNames.join(', ')}`);
        } catch (e) {
          addStatusLog('warning', 'Failed to evaluate metadata cube for export', e.message);
        }
      }

      // --- Existing export code continues (writeFloat32GeoTIFF / writeRGBAGeoTIFF) ---

      // Pixel-edge bounds correction: NISAR coords are pixel-CENTER,
      // GeoTIFF PixelIsArea expects pixel-EDGE
      // Use worldBounds (real-world coordinates) for georeferencing if available
      if (!imageData.worldBounds) {
        addStatusLog('warning', 'No world coordinates found in HDF5 — exported GeoTIFF will lack proper georeferencing');
      }
      const geoBounds = imageData.worldBounds || imageData.bounds;

      // Check for non-uniform coordinate spacing.  NISAR GCOV grids are nominally
      // uniform, but if they're not, the average-spacing georeferencing used below
      // will drift at the edges.  Warn so the user knows to check registration.
      if (imageData.xCoords && imageData.yCoords && imageData.worldBounds) {
        const maxSpacingDeviation = (coords) => {
          if (!coords || coords.length < 3) return 0;
          const nominal = coords[1] - coords[0];
          if (Math.abs(nominal) < 1e-12) return 0;
          let max = 0;
          for (let i = 2; i < coords.length; i++) {
            const dev = Math.abs((coords[i] - coords[i - 1]) - nominal) / Math.abs(nominal);
            if (dev > max) max = dev;
          }
          return max;
        };
        const xDev = maxSpacingDeviation(imageData.xCoords);
        const yDev = maxSpacingDeviation(imageData.yCoords);
        if (xDev > 0.001 || yDev > 0.001) {
          addStatusLog('warning',
            `Non-uniform coordinate spacing detected ` +
            `(x: ${(xDev * 100).toFixed(2)}%, y: ${(yDev * 100).toFixed(2)}% max deviation). ` +
            `Georeferencing uses average spacing — sub-pixel misregistration possible at edges.`);
        }
      }

      // worldBounds are pixel-CENTER: span = (N-1) * spacing, so divide by (N-1)
      // Always compute from worldBounds and data dimensions — pixelSpacing reflects
      // coordinate posting which may differ from data pixel footprint.
      const nativeSpacingX = (geoBounds[2] - geoBounds[0]) / (sourceWidth - 1 || 1);
      const nativeSpacingY = (geoBounds[3] - geoBounds[1]) / (sourceHeight - 1 || 1);
      // Pixel-edge bounds must match the pixels actually used by multilooking.
      // getExportStripe reads source pixels 0..(exportWidth*ml - 1), truncating
      // any remainder when sourceWidth isn't evenly divisible by ml.
      // Posting = nativeSpacing * ml, guaranteed exact by construction.
      let exportBounds;
      if (roiActive) {
        // Align geo-bounds to the actual multilook-grid origin that getExportStripe reads.
        // getExportStripe reads from source column roiStartCol*ml and row roiStartRow*ml,
        // which may differ from roiClamped.left/top when ROI isn't ml-aligned.
        const dataOriginCol = roiStartCol * effectiveMl;
        const dataOriginRow = roiStartRow * effectiveMl;
        const roiOriginX = geoBounds[0] + dataOriginCol * nativeSpacingX - nativeSpacingX / 2;
        // ROI Y: source row 0 = north = geoBounds[3]. Each row steps south by nativeSpacingY.
        // North pixel edge of the ROI:
        const roiMaxGeoY = geoBounds[3] - dataOriginRow * nativeSpacingY + nativeSpacingY / 2;
        // South pixel edge: north edge minus the export span
        const roiMinGeoY = roiMaxGeoY - exportHeight * effectiveMl * nativeSpacingY;
        exportBounds = [
          roiOriginX,
          roiMinGeoY,
          roiOriginX + exportWidth * effectiveMl * nativeSpacingX,
          roiMaxGeoY,
        ];
      } else {
        exportBounds = [
          geoBounds[0] - nativeSpacingX / 2,                                             // minX edge
          geoBounds[1] - nativeSpacingY / 2,                                             // minY edge
          geoBounds[0] - nativeSpacingX / 2 + exportWidth * effectiveMl * nativeSpacingX,  // maxX edge
          geoBounds[1] - nativeSpacingY / 2 + exportHeight * effectiveMl * nativeSpacingY, // maxY edge
        ];
      }

      const exportPixelX = (exportBounds[2] - exportBounds[0]) / exportWidth;
      const exportPixelY = (exportBounds[3] - exportBounds[1]) / exportHeight;

      addStatusLog('info', `Pixel scale: ${exportPixelX.toFixed(1)}m x ${exportPixelY.toFixed(1)}m`);
      addStatusLog('info', `Bounds (pixel-edge): [${exportBounds.map(b => b.toFixed(1)).join(', ')}]`);

      let geotiff;
      let filename;

      if (isRendered) {
        // --- Rendered export: apply same pipeline as GPU shader ---
        // Speckle reduction: if user selected a filter, apply it to export bands.
        // Otherwise fall back to the default 3×3 box-filter smooth.
        if (speckleFilterType !== 'none') {
          addStatusLog('info', `Applying ${speckleFilterType} ${speckleKernelSize}×${speckleKernelSize} speckle filter...`);
          for (const name of bandNames) {
            bands[name] = await applySpeckleFilter(bands[name], exportWidth, exportHeight, {
              type: speckleFilterType,
              kernelSize: speckleKernelSize,
            });
          }
        } else {
          // Default 3×3 box-filter bridges the gap between export multilook
          // and on-screen implicit averaging at overview zoom levels.
          const smoothKernel = 3;
          addStatusLog('info', `Smoothing bands: ${smoothKernel}×${smoothKernel} box filter (speckle reduction)...`);
          for (const name of bandNames) {
            bands[name] = smoothBand(bands[name], exportWidth, exportHeight, smoothKernel);
          }
        }

        const numPixels = exportWidth * exportHeight;

        if (displayMode === 'rgb' && compositeId) {
          // RGB composite: render tiles on-the-fly during GeoTIFF encoding.
          // This avoids allocating a full RGBA image (~1.5 GB for 366M pixels)
          // on top of the band data (~2.9 GB), which would exceed browser limits.
          // Each 512×512 tile (~4 MB) is rendered and compressed individually.
          addStatusLog('info', `Applying RGB composite "${compositeId}" + per-channel contrast...`);

          const renderTile = (x0, y0, tileW, tileH) => {
            const tilePixels = tileW * tileH;
            // Extract contiguous tile bands from row-major image bands
            const tileBands = {};
            for (const name of Object.keys(bands)) {
              const arr = new Float32Array(tilePixels);
              for (let py = 0; py < tileH; py++) {
                const srcOff = (y0 + py) * exportWidth + x0;
                arr.set(bands[name].subarray(srcOff, srcOff + tileW), py * tileW);
              }
              tileBands[name] = arr;
            }
            const rgbBands = computeRGBBands(tileBands, compositeId, tileW, tilePixels);
            const tileImage = createRGBTexture(
              rgbBands, tileW, tileH,
              effectiveContrastLimits,
              effectiveUseDecibels, gamma, stretchMode,
              null, false
            );
            return tileImage.data;
          };

          geotiff = await writeRGBAGeoTIFF(null, exportWidth, exportHeight, exportBounds, epsgCode, {
            generateOverviews: false,
            renderTile,
            onProgress: (pct) => {
              setExportProgress(50 + Math.round(pct / 2));
            }
          });

          // Free band data
          for (const name of Object.keys(bands)) {
            bands[name] = null;
          }

          filename = `sardine_${bandNames.join('-')}_${compositeId}_ml${effectiveMl}_${exportWidth}x${exportHeight}.tif`;
        } else {
          // Single-band: apply colormap
          addStatusLog('info', `Applying ${effectiveUseDecibels ? 'dB' : 'linear'} + ${colormap}${reverseColormap && colormap !== 'label' ? ' (reversed)' : ''} colormap...`);
          const colormapFunc = getColormap(colormap);
          const invertRamp = reverseColormap && colormap !== 'label';
          const cMin = contrastMin;
          const cMax = contrastMax;
          const needsStretch = stretchMode !== 'linear' || gamma !== 1.0;
          const stretchFn = needsStretch ? createStretchFn(stretchMode, gamma) : null;
          const rgbaData = new Uint8ClampedArray(numPixels * 4);
          const bandData = bands[bandNames[0]];
          // GDAL_NODATA sentinel from COG loader (e.g. -FLT_MAX, -9999).
          // Without this, sentinel pixels passed through getExportStripe with
          // ml=1 land here as finite non-zero numbers, evade the alpha mask,
          // and paint the entire export with the colormap's clamped-low color.
          const nodataSentinel = (imageData?.nodata !== undefined && imageData?.nodata !== null)
            ? imageData.nodata : null;

          for (let i = 0; i < numPixels; i++) {
            const amplitude = bandData[i];
            let value;
            if (effectiveUseDecibels) {
              const db = toDb(amplitude);
              value = (db - cMin) / (cMax - cMin);
            } else {
              value = (amplitude - cMin) / (cMax - cMin);
            }
            value = Math.max(0, Math.min(1, value));
            if (stretchFn !== null) value = stretchFn(value);
            const [r, g, b] = colormapFunc(invertRamp ? 1 - value : value);
            rgbaData[i * 4] = r;
            rgbaData[i * 4 + 1] = g;
            rgbaData[i * 4 + 2] = b;
            const isNodata = amplitude === 0 || isNaN(amplitude)
              || (nodataSentinel !== null && amplitude === nodataSentinel);
            rgbaData[i * 4 + 3] = isNodata ? 0 : 255;
          }

          // Free band data before GeoTIFF encoding
          for (const name of Object.keys(bands)) {
            bands[name] = null;
          }

          addStatusLog('info', 'Writing RGBA GeoTIFF...');
          geotiff = await writeRGBAGeoTIFF(rgbaData, exportWidth, exportHeight, exportBounds, epsgCode, {
            generateOverviews: false,
            onProgress: (pct) => {
              setExportProgress(50 + Math.round(pct / 2));
            }
          });

          filename = `sardine_${bandNames.join('-')}_${colormap}_ml${effectiveMl}_${exportWidth}x${exportHeight}.tif`;
        }
      } else {
        // --- Raw export: Float32 linear power (+ complex bands if present) ---
        const rawBandNames = complexBandNames.length > 0 ? allBandNames : bandNames;
        addStatusLog('info', 'Writing Float32 GeoTIFF...');
        geotiff = await writeFloat32GeoTIFF(bands, rawBandNames, exportWidth, exportHeight, exportBounds, epsgCode, {
          onProgress: (pct) => {
            setExportProgress(50 + Math.round(pct / 2));
          }
        });

        filename = `sardine_${bandNames.join('-')}_ml${effectiveMl}_${exportWidth}x${exportHeight}.tif`;
      }

      // Georef verification logging
      addStatusLog('info', '--- Georef Verification ---');
      addStatusLog('info', `EPSG: ${epsgCode}`);
      addStatusLog('info', `Pixel scale: ${exportPixelX.toFixed(6)} x ${exportPixelY.toFixed(6)}`);
      addStatusLog('info', `Expected: ${(nativeSpacingX * effectiveMl).toFixed(1)}m (native ${nativeSpacingX.toFixed(1)}m x ${effectiveMl}ml)`);
      addStatusLog('info', `UL corner: (${exportBounds[0].toFixed(2)}, ${exportBounds[3].toFixed(2)})`);
      addStatusLog('info', `LR corner: (${exportBounds[2].toFixed(2)}, ${exportBounds[1].toFixed(2)})`);
      addStatusLog('info', `Dimensions: ${exportWidth} x ${exportHeight} = ${sourceWidth}/${effectiveMl} x ${sourceHeight}/${effectiveMl}`);
      const intCheck = (sourceWidth % effectiveMl === 0 && sourceHeight % effectiveMl === 0) ? 'exact' : 'truncated';
      addStatusLog('info', `Integer multilook: ${intCheck}`);

      const sizeMB = (geotiff.byteLength / 1e6).toFixed(1);
      const elapsed = ((performance.now() - exportStart) / 1000).toFixed(1);

      downloadBuffer(geotiff, filename);

      // W005: provenance sidecar — {output}.tif.json (identification passed through opaquely)
      try {
        downloadSidecar(buildExportSidecar({
          scene: {
            file: (fileType === 'nisar' || fileType === 'nisar-gunw') ? (nisarFile?.name || null) : (cogUrl || null),
            productType: imageData?.identification?.productType || nisarProductType || null,
            identification: imageData?.identification || null,
          },
          renderState: isRendered ? {
            mode: 'rendered',
            useDecibels: effectiveUseDecibels,
            contrastLimits: (displayMode === 'rgb' && compositeId) ? effectiveContrastLimits : [contrastMin, contrastMax],
            colormap,
            stretchMode,
            gamma,
            compositeId: compositeId || null,
          } : { mode: 'raw' },
          exportParams: { crs: epsgCode, bounds: exportBounds, width: exportWidth, height: exportHeight, multilook: effectiveMl },
        }), filename);
        addStatusLog('info', `Sidecar: ${filename}.json`);
      } catch (sidecarErr) {
        addStatusLog('warning', `Sidecar write failed: ${sidecarErr.message}`);
      }

      addStatusLog('success', `Exported: ${filename}`);
      addStatusLog('success', `File size: ${sizeMB} MB, Time: ${elapsed}s`);
      addStatusLog('info', '--- GeoTIFF Export Complete ---');
    } catch (e) {
      addStatusLog('error', 'Export failed', e.message);
      console.error('GeoTIFF export error:', e);
    } finally {
      setExporting(false);
      setExportProgress(0);
    }
  }, [imageData, exportMultilookWindow, exportMode, contrastMin, contrastMax, useDecibels, colormap, stretchMode, gamma, displayMode, compositeId, effectiveContrastLimits, roi, fileType, nisarFile, cogUrl, nisarProductType, effectiveUseDecibels, addStatusLog]);

  // Export the current time-series frame as a georeferenced GeoTIFF with multilooking
  const handleExportTSFrame = useCallback(async () => {
    const frame = roiTSFrames?.[roiTSIndex];
    if (!frame?.getExportStripe) {
      addStatusLog('error', 'Export not available for this frame (requires NISAR streaming loader)');
      return;
    }

    setExporting(true);
    setExportProgress(0);
    const exportStart = performance.now();
    addStatusLog('info', `--- TS Frame Export: ${frame.label} ---`);

    await new Promise(resolve => setTimeout(resolve, 0));

    try {
      const effectiveMl = Math.max(1, Math.min(128, exportMultilookWindow || 1));

      // Map roiTSBounds (world coords) → pixel bounds within this frame
      const [fMinX, fMinY, fMaxX, fMaxY] = frame.bounds;
      const [rMinX, rMinY, rMaxX, rMaxY] = roiTSBounds;
      const fw = frame.width, fh = frame.height;

      // frame.bounds are pixel-CENTER coords; spacing = span / (N-1)
      const nativePixW = (fMaxX - fMinX) / (fw - 1 || 1);
      const nativePixH = (fMaxY - fMinY) / (fh - 1 || 1);

      const srcStartCol = Math.max(0, Math.floor((rMinX - fMinX) / nativePixW));
      const srcEndCol   = Math.min(fw, Math.ceil((rMaxX - fMinX) / nativePixW));
      const srcStartRow = Math.max(0, Math.floor((fMaxY - rMaxY) / nativePixH));
      const srcEndRow   = Math.min(fh, Math.ceil((fMaxY - rMinY) / nativePixH));

      const roiStartCol = Math.floor(srcStartCol / effectiveMl);
      const roiStartRow = Math.floor(srcStartRow / effectiveMl);
      const roiEndCol   = Math.min(Math.floor(fw / effectiveMl), Math.ceil(srcEndCol / effectiveMl));
      const roiEndRow   = Math.min(Math.floor(fh / effectiveMl), Math.ceil(srcEndRow / effectiveMl));
      const exportWidth  = roiEndCol - roiStartCol;
      const exportHeight = roiEndRow - roiStartRow;

      if (exportWidth < 1 || exportHeight < 1) {
        addStatusLog('error', `ROI too small for multilook ${effectiveMl}x${effectiveMl}`);
        setExporting(false);
        return;
      }

      const epsgMatch = frame.crs?.match(/EPSG:(\d+)/);
      const epsgCode = epsgMatch ? parseInt(epsgMatch[1]) : 4326;

      const bandNames = frame.requiredPols?.length ? frame.requiredPols : ['band'];
      const complexBandNames = (frame.requiredComplexPols || []).flatMap(p => [`${p}_re`, `${p}_im`]);
      const allBandNames = [...bandNames, ...complexBandNames];

      // Pixel-edge export bounds: frame.bounds are pixel centers, so shift by ±½ pixel
      const exportPixW = nativePixW * effectiveMl;
      const exportPixH = nativePixH * effectiveMl;
      const exportBounds = [
        fMinX - nativePixW / 2 + roiStartCol * exportPixW,
        fMaxY + nativePixH / 2 - roiEndRow   * exportPixH,
        fMinX - nativePixW / 2 + roiEndCol   * exportPixW,
        fMaxY + nativePixH / 2 - roiStartRow * exportPixH,
      ];

      addStatusLog('info', `Export: ${exportWidth}x${exportHeight} @ ml=${effectiveMl}, EPSG:${epsgCode}`);
      addStatusLog('info', `Bands: ${bandNames.join(', ')} (${exportMode === 'rendered' ? 'RGBA rendered' : 'Float32 raw'})`);

      // Allocate output arrays
      const bands = {};
      for (const name of allBandNames) {
        bands[name] = new Float32Array(exportWidth * exportHeight);
      }

      // Stripe-based reading
      const stripeRows = 256;
      const numStripes = Math.ceil(exportHeight / stripeRows);
      for (let s = 0; s < numStripes; s++) {
        const startRow = s * stripeRows;
        const numRows = Math.min(stripeRows, exportHeight - startRow);
        setExportProgress(Math.round((s / numStripes) * 50));
        addStatusLog('info', `Reading stripe ${s + 1}/${numStripes}...`);

        const stripe = await frame.getExportStripe({
          startRow: roiStartRow + startRow,
          numRows,
          ml: effectiveMl,
          exportWidth,
          startCol: roiStartCol,
          numCols: exportWidth,
        });

        for (const name of allBandNames) {
          if (stripe.bands[name]) bands[name].set(stripe.bands[name], startRow * exportWidth);
        }
        await new Promise(r => setTimeout(r, 0));
      }

      let geotiff, filename;
      const isRendered = exportMode === 'rendered';

      if (isRendered) {
        // 3×3 smooth to match on-screen display quality
        for (const name of bandNames) {
          bands[name] = smoothBand(bands[name], exportWidth, exportHeight, 3);
        }

        if (frame.isRGB && frame.compositeId) {
          addStatusLog('info', `Applying RGB composite "${frame.compositeId}"...`);
          const renderTile = (x0, y0, tileW, tileH) => {
            const tilePixels = tileW * tileH;
            const tileBands = {};
            for (const name of Object.keys(bands)) {
              const arr = new Float32Array(tilePixels);
              for (let py = 0; py < tileH; py++) {
                const srcOff = (y0 + py) * exportWidth + x0;
                arr.set(bands[name].subarray(srcOff, srcOff + tileW), py * tileW);
              }
              tileBands[name] = arr;
            }
            const rgbBands = computeRGBBands(tileBands, frame.compositeId, tileW, tilePixels);
            const tileImage = createRGBTexture(
              rgbBands, tileW, tileH,
              roiTSContrastLimits,
              false, gamma, stretchMode,
              null, false
            );
            return tileImage.data;
          };

          geotiff = await writeRGBAGeoTIFF(null, exportWidth, exportHeight, exportBounds, epsgCode, {
            generateOverviews: false,
            renderTile,
            onProgress: (pct) => setExportProgress(50 + Math.round(pct / 2)),
          });
          filename = `sardine_ts_${frame.label}_${frame.compositeId}_ml${effectiveMl}_${exportWidth}x${exportHeight}.tif`;
        } else {
          // Single-band rendered
          const tsUseDecibels = nisarProductType === 'GUNW' ? false : useDecibels;
          const [cMin, cMax] = Array.isArray(roiTSContrastLimits) ? roiTSContrastLimits : [-25, 0];
          const colormapFunc = getColormap(colormap);
          const invertRamp = reverseColormap && colormap !== 'label';
          const numPixels = exportWidth * exportHeight;
          const rgbaData = new Uint8ClampedArray(numPixels * 4);
          const bandData = bands[bandNames[0]];
          const tsNeedsStretch = stretchMode !== 'linear' || gamma !== 1.0;
          const tsStretchFn = tsNeedsStretch ? createStretchFn(stretchMode, gamma) : null;

          for (let i = 0; i < numPixels; i++) {
            const amp = bandData[i];
            let v = tsUseDecibels
              ? (toDb(amp) - cMin) / (cMax - cMin)
              : (amp - cMin) / (cMax - cMin);
            v = Math.max(0, Math.min(1, v));
            if (tsStretchFn !== null) v = tsStretchFn(v);
            const [r, g, b] = colormapFunc(invertRamp ? 1 - v : v);
            rgbaData[i * 4] = r; rgbaData[i * 4 + 1] = g; rgbaData[i * 4 + 2] = b;
            rgbaData[i * 4 + 3] = (amp === 0 || isNaN(amp)) ? 0 : 255;
          }
          for (const name of bandNames) bands[name] = null;

          geotiff = await writeRGBAGeoTIFF(rgbaData, exportWidth, exportHeight, exportBounds, epsgCode, {
            generateOverviews: false,
            onProgress: (pct) => setExportProgress(50 + Math.round(pct / 2)),
          });
          filename = `sardine_ts_${frame.label}_${colormap}_ml${effectiveMl}_${exportWidth}x${exportHeight}.tif`;
        }
      } else {
        // Raw Float32
        const rawBandNames = complexBandNames.length > 0 ? allBandNames : bandNames;
        addStatusLog('info', 'Writing Float32 GeoTIFF...');
        geotiff = await writeFloat32GeoTIFF(bands, rawBandNames, exportWidth, exportHeight, exportBounds, epsgCode, {
          onProgress: (pct) => setExportProgress(50 + Math.round(pct / 2)),
        });
        filename = `sardine_ts_${frame.label}_${bandNames.join('-')}_ml${effectiveMl}_${exportWidth}x${exportHeight}.tif`;
      }

      downloadBuffer(geotiff, filename);

      // W005: provenance sidecar — {output}.tif.json (identification passed through opaquely)
      try {
        downloadSidecar(buildExportSidecar({
          scene: {
            file: frame.fileName || null,
            productType: frame.identification?.productType || nisarProductType || null,
            identification: frame.identification || null,
          },
          renderState: isRendered ? {
            mode: 'rendered',
            useDecibels: nisarProductType === 'GUNW' ? false : useDecibels,
            contrastLimits: roiTSContrastLimits,
            colormap,
            stretchMode,
            gamma,
            compositeId: frame.compositeId || null,
          } : { mode: 'raw' },
          exportParams: { crs: epsgCode, bounds: exportBounds, width: exportWidth, height: exportHeight, multilook: effectiveMl },
        }), filename);
        addStatusLog('info', `Sidecar: ${filename}.json`);
      } catch (sidecarErr) {
        addStatusLog('warning', `Sidecar write failed: ${sidecarErr.message}`);
      }

      const elapsed = ((performance.now() - exportStart) / 1000).toFixed(1);
      addStatusLog('success', `Exported: ${filename} (${(geotiff.byteLength / 1e6).toFixed(1)} MB, ${elapsed}s)`);
    } catch (e) {
      addStatusLog('error', 'TS frame export failed', e.message);
      console.error('[Export TS]', e);
    } finally {
      setExporting(false);
      setExportProgress(0);
    }
  }, [roiTSFrames, roiTSIndex, roiTSBounds, roiTSContrastLimits, exportMultilookWindow, exportMode,
      gamma, stretchMode, colormap, useDecibels, nisarProductType, addStatusLog]);

  // Serialize current visualization state for embedding in exported PNGs
  const serializeViewerState = useCallback(() => ({
    colormap,
    reverseColormap,
    useDecibels,
    contrastMin,
    contrastMax,
    gamma,
    stretchMode,
    displayMode,
    compositeId,
    rgbContrastLimits,
    selectedFrequency,
    selectedPolarization,
    multiLook,
    speckleFilterType,
    maskInvalid,
    fileType,
    viewCenter,
    viewZoom,
    filename: (fileType === 'nisar' || fileType === 'nisar-gunw') ? (nisarFile?.name || null) : (cogUrl || null),
  }), [colormap, reverseColormap, useDecibels, contrastMin, contrastMax, gamma, stretchMode, displayMode, compositeId, rgbContrastLimits, selectedFrequency, selectedPolarization, multiLook, speckleFilterType, maskInvalid, fileType, viewCenter, viewZoom, nisarFile, cogUrl]);

  // W018 Phase 1 — agent bridge (read-only). Lets Claude Code see what the
  // viewer is showing: current render settings and a screenshot of the actual
  // canvas. Nothing here writes app state. The bridge is a no-op when no
  // broker is running, so this is inert in production builds.
  // Handlers must read CURRENT state, not the values captured when the
  // bridge connected — otherwise an agent is told about a render that has
  // since changed (e.g. a deep link applying a colormap after mount).
  const bridgeStateRef = useRef(null);
  bridgeStateRef.current = { serializeViewerState, imageData, wgs84Bounds };

  useEffect(() => {
    const bridge = connectAgentBridge();

    bridge.register('get_view_state', () => {
      const { serializeViewerState, imageData, wgs84Bounds } = bridgeStateRef.current;
      const render = serializeViewerState();
      return {
        ...render,
        hasData: !!imageData,
        bounds: wgs84Bounds || null,
        // Phase 1.5: a view without its physical frame invites optical
        // misreadings, so grounding travels with every agent-facing view.
        grounding: buildGrounding(imageData, render),
      };
    });

    bridge.register('screenshot', ({ maxDim } = {}) => {
      const viewer = viewerRef.current;
      if (!viewer) throw new Error('Viewer not mounted');
      // deck.gl may have cleared the drawing buffer since the last paint;
      // force a fresh frame, then read it back on the next rAF.
      viewer.redraw?.();
      return new Promise((resolve, reject) => {
        requestAnimationFrame(() => {
          try {
            resolve(captureCanvas(viewer.getCanvas(), maxDim || 1024));
          } catch (err) {
            reject(err);
          }
        });
      });
    });

    return () => bridge.disconnect();
    // Empty deps: one bridge for the app's lifetime; handlers read live state
    // through bridgeStateRef, so reconnecting on every render is unnecessary.
  }, []);

  // Local-file state links (?file=): filename hint for the Copy-link button
  // when no shareable URL exists. Only real local Files qualify — remote NISAR
  // staging stores {url, name} objects, which sharedRawUrl already covers.
  const localShareName =
    (fileType === 'nisar' || fileType === 'nisar-gunw')
      ? (typeof File !== 'undefined' && nisarFile instanceof File ? nisarFile.name : null)
      : fileType === 'local-tif'
        ? (mosaicFiles[0]?.name || null)
        : null;

  // Serialize the full set of render options + viewport for clipboard copy.
  // Marker `__sardine: 'render-state'` lets Ctrl+V detect a SARdine payload
  // and ignore unrelated clipboard contents.
  const serializeRenderState = useCallback(() => ({
    __sardine: 'render-state',
    version: 1,
    // Viewport
    viewCenter: Array.isArray(viewCenter) ? [viewCenter[0], viewCenter[1]] : viewCenter,
    viewZoom,
    // Display mode
    displayMode,
    compositeId,
    // Single-band rendering
    colormap,
    useDecibels,
    contrastMin,
    contrastMax,
    gamma,
    stretchMode,
    // RGB
    rgbContrastLimits: rgbContrastLimits ? JSON.parse(JSON.stringify(rgbContrastLimits)) : null,
    rgbSaturation,
    colorblindMode,
    // Resampling / masking
    multiLook,
    maskInvalid,
    maskLayoverShadow,
    useIncidenceAngleMask,
    incAngleMin,
    incAngleMax,
    // Speckle
    speckleFilterType,
    speckleKernelSize,
    // GUNW
    useCoherenceMask,
    coherenceThreshold,
    losDisplacement,
    verticalDisplacement,
    // Overlays / UI
    showGrid,
    pixelExplorer,
    pixelWindowSize,
    showHistogramOverlay,
    histogramScope,
    // NISAR dataset selection
    selectedFrequency,
    selectedPolarization,
  }), [
    viewCenter, viewZoom,
    displayMode, compositeId,
    colormap, useDecibels, contrastMin, contrastMax, gamma, stretchMode,
    rgbContrastLimits, rgbSaturation, colorblindMode,
    multiLook, maskInvalid, maskLayoverShadow, useIncidenceAngleMask, incAngleMin, incAngleMax,
    speckleFilterType, speckleKernelSize,
    useCoherenceMask, coherenceThreshold, losDisplacement, verticalDisplacement,
    showGrid, pixelExplorer, pixelWindowSize, showHistogramOverlay, histogramScope,
    selectedFrequency, selectedPolarization,
  ]);

  // Restore a render state previously produced by serializeRenderState.
  // Each field is type-checked so partial / older payloads degrade gracefully.
  const applyRenderState = useCallback((s) => {
    if (!s || typeof s !== 'object' || s.__sardine !== 'render-state') return false;

    if (Array.isArray(s.viewCenter) && s.viewCenter.length === 2 &&
        Number.isFinite(s.viewCenter[0]) && Number.isFinite(s.viewCenter[1])) {
      setViewCenter([s.viewCenter[0], s.viewCenter[1]]);
    }
    if (Number.isFinite(s.viewZoom)) setViewZoom(s.viewZoom);

    if (typeof s.displayMode === 'string') setDisplayMode(s.displayMode);
    if (s.compositeId === null || typeof s.compositeId === 'string') setCompositeId(s.compositeId);

    if (typeof s.colormap === 'string') setColormap(s.colormap);
    if (typeof s.useDecibels === 'boolean') setUseDecibels(s.useDecibels);
    if (Number.isFinite(s.contrastMin)) setContrastMin(s.contrastMin);
    if (Number.isFinite(s.contrastMax)) setContrastMax(s.contrastMax);
    if (Number.isFinite(s.gamma)) setGamma(s.gamma);
    if (typeof s.stretchMode === 'string') setStretchMode(s.stretchMode);

    if (s.rgbContrastLimits === null || typeof s.rgbContrastLimits === 'object') {
      setRgbContrastLimits(s.rgbContrastLimits);
    }
    if (Number.isFinite(s.rgbSaturation)) setRgbSaturation(s.rgbSaturation);
    if (typeof s.colorblindMode === 'string') setColorblindMode(s.colorblindMode);

    if (typeof s.multiLook === 'boolean') setMultiLook(s.multiLook);
    if (typeof s.maskInvalid === 'boolean') setMaskInvalid(s.maskInvalid);
    if (typeof s.maskLayoverShadow === 'boolean') setMaskLayoverShadow(s.maskLayoverShadow);
    if (typeof s.useIncidenceAngleMask === 'boolean') setUseIncidenceAngleMask(s.useIncidenceAngleMask);
    if (Number.isFinite(s.incAngleMin)) setIncAngleMin(s.incAngleMin);
    if (Number.isFinite(s.incAngleMax)) setIncAngleMax(s.incAngleMax);

    if (typeof s.speckleFilterType === 'string') setSpeckleFilterType(s.speckleFilterType);
    if (Number.isFinite(s.speckleKernelSize)) setSpeckleKernelSize(s.speckleKernelSize);

    if (typeof s.useCoherenceMask === 'boolean') setUseCoherenceMask(s.useCoherenceMask);
    if (Number.isFinite(s.coherenceThreshold)) setCoherenceThreshold(s.coherenceThreshold);
    if (typeof s.losDisplacement === 'boolean') setLosDisplacement(s.losDisplacement);
    if (typeof s.verticalDisplacement === 'boolean') setVerticalDisplacement(s.verticalDisplacement);

    if (typeof s.showGrid === 'boolean') setShowGrid(s.showGrid);
    if (typeof s.pixelExplorer === 'boolean') setPixelExplorer(s.pixelExplorer);
    if (Number.isFinite(s.pixelWindowSize)) setPixelWindowSize(s.pixelWindowSize);
    if (typeof s.showHistogramOverlay === 'boolean') setShowHistogramOverlay(s.showHistogramOverlay);
    if (typeof s.histogramScope === 'string') setHistogramScope(s.histogramScope);

    if (typeof s.selectedFrequency === 'string') setSelectedFrequency(s.selectedFrequency);
    if (typeof s.selectedPolarization === 'string') setSelectedPolarization(s.selectedPolarization);

    return true;
  }, []);

  // Save current view (or TS viewer) as a georeferenced GeoTIFF — screenshots the rendered canvas
  const handleSaveFigureGeoTIFF = useCallback(async () => {
    // Choose which viewer to capture: TS viewer when it's active, otherwise main viewer
    const isTS = activeViewer === 'roi-ts' && !!roiTSFrames && roiTSViewerRef.current;
    const targetRef = isTS ? roiTSViewerRef : viewerRef;
    const targetBounds = isTS ? roiTSBounds : imageData?.bounds;

    if (!targetRef.current || !targetBounds) {
      addStatusLog('error', 'Viewer not ready');
      return;
    }
    const glCanvas = targetRef.current.getCanvas();
    if (!glCanvas) {
      addStatusLog('error', 'Could not capture canvas');
      return;
    }

    try {
      addStatusLog('info', 'Capturing figure GeoTIFF...');

      // Get view state to compute exact viewport world bounds
      const vs = targetRef.current.getViewState();
      const vcx = vs?.target?.[0] ?? viewCenter[0];
      const vcy = vs?.target?.[1] ?? viewCenter[1];
      const vzoom = vs?.zoom ?? viewZoom;

      const ppu = Math.pow(2, vzoom);
      const pw = glCanvas.width;    // physical pixels (DPR-scaled)
      const ph = glCanvas.height;
      const vpHalfW = (pw / 2) / ppu;
      const vpHalfH = (ph / 2) / ppu;

      // Full viewport bounds — not clamped, so georeference covers the entire canvas
      const vpBounds = [vcx - vpHalfW, vcy - vpHalfH, vcx + vpHalfW, vcy + vpHalfH];

      // Read rendered RGBA pixels from the WebGL canvas
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = pw;
      tmpCanvas.height = ph;
      const ctx = tmpCanvas.getContext('2d');
      ctx.drawImage(glCanvas, 0, 0);
      const imgData = ctx.getImageData(0, 0, pw, ph);
      const rgba = new Uint8ClampedArray(imgData.data);

      const epsgMatch = imageData?.crs?.match(/EPSG:(\d+)/);
      const epsgCode = epsgMatch ? parseInt(epsgMatch[1]) : 4326;

      const geotiff = await writeRGBAGeoTIFF(rgba, pw, ph, vpBounds, epsgCode, {
        generateOverviews: false,
      });

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const label = isTS ? `_ts_${roiTSFrames[roiTSIndex]?.label || roiTSIndex}` : '';
      const filename = `sardine_figure${label}_${ts}.tif`;
      downloadBuffer(geotiff, filename);
      addStatusLog('success', `Figure GeoTIFF saved: ${filename} (${pw}×${ph} px, ${(geotiff.byteLength / 1e6).toFixed(1)} MB)`);
    } catch (e) {
      addStatusLog('error', 'Figure GeoTIFF export failed', e.message);
      console.error('[Figure GeoTIFF]', e);
    }
  }, [imageData, viewCenter, viewZoom, activeViewer, roiTSBounds, roiTSFrames, roiTSIndex, addStatusLog]);

  // Save current view as PNG figure with overlays
  const handleSaveFigure = useCallback(async (fmt) => {
    // Callable as an event handler (arg is an Event) or with an explicit
    // 'png'|'svg' string; anything that isn't the literal 'svg' means PNG.
    const format = fmt === 'svg' ? 'svg' : 'png';
    const ext = format;
    // Compare grid mode — stitch all panels into one figure.
    if (compareMode && compareGridRef.current) {
      const gridPanels = compareGridRef.current.getPanels();
      const ready = gridPanels.filter((p) => p.viewer?.getCanvas?.());
      if (ready.length === 0) {
        addStatusLog('error', 'Compare grid: no panels to export');
        return;
      }
      addStatusLog('info', `Capturing compare grid (${ready.length} panels)...`);
      try {
        const panelSpecs = ready.map((p) => ({
          canvas: p.viewer.getCanvas(),
          options: {
            colormap: p.colormap,
            contrastLimits: p.contrastLimits,
            useDecibels: p.useDecibels,
            stretchMode: p.stretchMode,
            gamma: p.gamma,
            compositeId: null,
            viewState: p.viewer.getViewState?.(),
            bounds: p.source?.bounds,
            filename: p.name,
            crs: p.source?.crs || '',
            // Class-map panels: export a discrete class legend instead of the
            // continuous dB colorbar (which is meaningless for labels).
            classMode: !!p.classMode,
            classPalette: p.classPalette || null,
            classNames: p.classNames || null,
            classLegend: p.classLegend || null,
            gridMode: figureGridMode,
            colorbarLabel,
            reverseColormap: !!p.reverseColormap,
          },
        }));
        const blob = await exportFigureGrid(panelSpecs, { format, theme: figureTheme });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        downloadBlob(blob, `sardine_compare_${ts}.${ext}`);
        addStatusLog('success', `Compare grid figure saved (${ext.toUpperCase()})`);
        ready.forEach((p) => p.viewer.redraw?.());
      } catch (e) {
        addStatusLog('error', 'Compare grid export failed', e.message);
        console.error('Compare grid export error:', e);
      }
      return;
    }

    if (!viewerRef.current) {
      addStatusLog('error', 'Viewer not ready');
      return;
    }

    const glCanvas = viewerRef.current.getCanvas();
    if (!glCanvas) {
      addStatusLog('error', 'Could not capture canvas');
      return;
    }

    addStatusLog('info', 'Capturing figure...');

    try {
      const vs = viewerRef.current.getViewState();
      const sourceName = (fileType === 'nisar' || fileType === 'nisar-gunw') ? nisarFile?.name : cogUrl;
      const attribution = attributionEnabled
        ? buildAttribution({
            vendor: attributionVendor || detectVendor(sourceName),
            processor: attributionProcessor || undefined,
          })
        : null;
      const mainOpts = {
        colormap,
        reverseColormap,
        contrastLimits: effectiveContrastLimits,
        useDecibels: effectiveUseDecibels,
        compositeId: isRGBDisplayMode ? compositeId : null,
        viewState: vs,
        bounds: imageData?.bounds,
        filename: sourceName,
        crs: imageData?.crs || '',
        histogramData: showHistogramOverlay ? histogramData : null,
        polarization: selectedPolarization,
        identification: imageData?.identification || null,
        colorblindMode,
        attribution,
        annotations,
        gridMode: figureGridMode,
        colorbarLabel,
        // Class-map figures: discrete legend instead of the continuous colorbar.
        classMode: !!mainClassInfo,
        classPalette: mainClassInfo?.palette || null,
        classNames: mainClassInfo?.names || null,
        classLegend: mainClassInfo?.legend || null,
        // Location-map inset: exported when the satellite/overview map is on
        // screen (export parity with the viewer).
        wgs84Bounds: (satelliteMapVisible || overviewMapVisible) ? wgs84Bounds : null,
      };

      const secondaryRef = roiRGBViewerRef.current ? roiRGBViewerRef : roiTSViewerRef.current ? roiTSViewerRef : null;
      const secondaryCanvas = secondaryRef?.current?.getCanvas();

      let blob;
      if (secondaryCanvas) {
        const secondaryVS = secondaryRef.current.getViewState();
        const isTS = secondaryRef === roiTSViewerRef;
        const secondaryOpts = isTS ? {
          colormap,
          reverseColormap,
          contrastLimits: roiTSContrastLimits,
          useDecibels: roiTSFrames[roiTSIndex]?.isRGB ? false : (nisarProductType === 'GUNW' ? false : useDecibels),
          compositeId: roiTSFrames[roiTSIndex]?.compositeId || null,
          viewState: secondaryVS,
          bounds: roiTSBounds,
          filename: roiTSFrames[roiTSIndex]?.label || '',
          crs: imageData?.crs || '',
          identification: imageData?.identification || null,
          colorblindMode,
          attribution,
          gridMode: figureGridMode,
          colorbarLabel,
        } : {
          colormap,
          contrastLimits: roiRGBContrastLimits,
          useDecibels: false,
          compositeId: roiCompositeId,
          viewState: secondaryVS,
          bounds: roiRGBBounds,
          filename: sourceName,
          crs: imageData?.crs || '',
          histogramData: showHistogramOverlay && roiRGBHistogramData ? roiRGBHistogramData : null,
          identification: imageData?.identification || null,
          colorblindMode,
          attribution,
          gridMode: figureGridMode,
          colorbarLabel,
        };
        blob = await exportFigureSideBySide(
          { canvas: glCanvas, options: mainOpts },
          { canvas: secondaryCanvas, options: secondaryOpts },
          { format, theme: figureTheme },
        );
      } else {
        blob = await exportFigure(glCanvas, { ...mainOpts, format, theme: figureTheme });
      }

      // State embedding is a PNG-only feature (iTXt chunk); SVG ships as-is.
      if (format !== 'svg') {
        blob = await embedStateInPNG(blob, serializeViewerState());
      }

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const figName = `sardine_figure_${ts}.${ext}`;
      downloadBlob(blob, figName);
      addStatusLog('success', `Figure saved: ${figName}`);

      // Force deck.gl to re-render so the canvas doesn't stay blank
      viewerRef.current.redraw();
      secondaryRef?.current?.redraw();
    } catch (e) {
      addStatusLog('error', 'Figure export failed', e.message);
      console.error('Figure export error:', e);
    }
  }, [compareMode, colormap, reverseColormap, effectiveContrastLimits, useDecibels, effectiveUseDecibels, displayMode, compositeId, imageData, fileType, nisarFile, cogUrl, addStatusLog, showHistogramOverlay, histogramData, selectedPolarization, roiRGBContrastLimits, roiRGBBounds, roiCompositeId, roiRGBHistogramData, roiTSContrastLimits, roiTSBounds, roiTSFrames, roiTSIndex, nisarProductType, serializeViewerState, attributionEnabled, attributionVendor, attributionProcessor, annotations, figureTheme, figureGridMode, colorbarLabel, satelliteMapVisible, overviewMapVisible, wgs84Bounds, mainClassInfo]);

  // Enhanced figure export — captures all overlays (ROI box, profile plots, pixel explorer)
  const handleSaveFigureWithOverlays = useCallback(async (fmt) => {
    const format = fmt === 'svg' ? 'svg' : 'png';
    const ext = format;
    if (!viewerRef.current) {
      addStatusLog('error', 'Viewer not ready');
      return;
    }

    const glCanvas = viewerRef.current.getCanvas();
    if (!glCanvas) {
      addStatusLog('error', 'Could not capture canvas');
      return;
    }

    addStatusLog('info', 'Capturing figure with overlays...');

    try {
      const vs = viewerRef.current.getViewState();
      const sourceName = (fileType === 'nisar' || fileType === 'nisar-gunw') ? nisarFile?.name : cogUrl;
      const attribution = attributionEnabled
        ? buildAttribution({
            vendor: attributionVendor || detectVendor(sourceName),
            processor: attributionProcessor || undefined,
          })
        : null;
      const mainOpts = {
        colormap,
        reverseColormap,
        contrastLimits: effectiveContrastLimits,
        useDecibels: effectiveUseDecibels,
        compositeId: isRGBDisplayMode ? compositeId : null,
        viewState: vs,
        bounds: imageData?.bounds,
        filename: sourceName,
        crs: imageData?.crs || '',
        roi,
        profileData: null,
        profileShow: { v: false, h: false, i: false },
        imageWidth: imageData?.sourceWidth || imageData?.width,
        imageHeight: imageData?.sourceHeight || imageData?.height,
        histogramData: showHistogramOverlay ? histogramData : null,
        polarization: selectedPolarization,
        identification: imageData?.identification || null,
        classificationMap: classifierOpen ? classificationMap : null,
        classRegions,
        classifierRoiDims,
        colorblindMode,
        attribution,
        annotations,
        gridMode: figureGridMode,
        colorbarLabel,
        // Class-map figures: discrete legend instead of the continuous colorbar.
        classMode: !!mainClassInfo,
        classPalette: mainClassInfo?.palette || null,
        classNames: mainClassInfo?.names || null,
        classLegend: mainClassInfo?.legend || null,
        // Location-map inset: exported when the satellite/overview map is on
        // screen (export parity with the viewer).
        wgs84Bounds: (satelliteMapVisible || overviewMapVisible) ? wgs84Bounds : null,
      };

      const secondaryRef = roiRGBViewerRef.current ? roiRGBViewerRef : roiTSViewerRef.current ? roiTSViewerRef : null;
      const secondaryCanvas = secondaryRef?.current?.getCanvas();

      let blob;
      // The secondary-panel export stitches two rendered bitmaps on a canvas —
      // inherently raster. For SVG we keep the main panel (ROI/profile/class
      // overlays remain editable vector) and omit the secondary panel.
      if (secondaryCanvas && format === 'svg') {
        addStatusLog('info', 'SVG: secondary panel omitted (main panel + overlays only)');
      }
      if (secondaryCanvas && format !== 'svg') {
        const secondaryVS = secondaryRef.current.getViewState();
        const isTS = secondaryRef === roiTSViewerRef;
        const secondaryOpts = isTS ? {
          colormap,
          reverseColormap,
          contrastLimits: roiTSContrastLimits,
          useDecibels: roiTSFrames[roiTSIndex]?.isRGB ? false : (nisarProductType === 'GUNW' ? false : useDecibels),
          compositeId: roiTSFrames[roiTSIndex]?.compositeId || null,
          viewState: secondaryVS,
          bounds: roiTSBounds,
          filename: roiTSFrames[roiTSIndex]?.label || '',
          crs: imageData?.crs || '',
          identification: imageData?.identification || null,
          colorblindMode,
          attribution,
          gridMode: figureGridMode,
          colorbarLabel,
        } : {
          colormap,
          contrastLimits: roiRGBContrastLimits,
          useDecibels: false,
          compositeId: roiCompositeId,
          viewState: secondaryVS,
          bounds: roiRGBBounds,
          filename: sourceName,
          crs: imageData?.crs || '',
          histogramData: showHistogramOverlay && roiRGBHistogramData ? roiRGBHistogramData : null,
          identification: imageData?.identification || null,
          colorblindMode,
          attribution,
          gridMode: figureGridMode,
          colorbarLabel,
        };
        // For the main panel, use exportFigureWithOverlays to capture ROI/profile overlays;
        // for the secondary panel use plain exportFigure (no ROI drawn there).
        // Raster-only path (PNG): stitches two bitmaps, so it is skipped for SVG.
        const [mainBlob, secondBlob] = await Promise.all([
          exportFigureWithOverlays(glCanvas, mainOpts),
          exportFigure(secondaryCanvas, secondaryOpts),
        ]);
        // Convert both blobs to ImageBitmaps and stitch side-by-side
        const [lBmp, rBmp] = await Promise.all([
          createImageBitmap(mainBlob),
          createImageBitmap(secondBlob),
        ]);
        const dpr = window.devicePixelRatio || 1;
        const divider = Math.round(3 * dpr);
        const H = Math.max(lBmp.height, rBmp.height);
        const W = lBmp.width + divider + rBmp.width;
        const stitchCanvas = document.createElement('canvas');
        stitchCanvas.width = W;
        stitchCanvas.height = H;
        const sCtx = stitchCanvas.getContext('2d');
        sCtx.fillStyle = '#0a1628';
        sCtx.fillRect(0, 0, W, H);
        sCtx.drawImage(lBmp, 0, 0);
        sCtx.fillStyle = 'rgba(30, 58, 95, 0.80)';
        sCtx.fillRect(lBmp.width, 0, divider, H);
        sCtx.drawImage(rBmp, lBmp.width + divider, 0);
        blob = await new Promise((resolve) => stitchCanvas.toBlob(resolve, 'image/png'));
      } else {
        blob = await exportFigureWithOverlays(glCanvas, { ...mainOpts, format, theme: figureTheme });
      }

      // State embedding is a PNG-only feature (iTXt chunk); SVG ships as-is.
      if (format !== 'svg') {
        blob = await embedStateInPNG(blob, serializeViewerState());
      }

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const figName = `sardine_figure_${ts}.${ext}`;
      downloadBlob(blob, figName);
      addStatusLog('success', `Figure with overlays saved: ${figName}`);

      viewerRef.current.redraw();
      secondaryRef?.current?.redraw();
    } catch (e) {
      addStatusLog('error', 'Figure export failed', e.message);
      console.error('Figure export error:', e);
    }
  }, [colormap, reverseColormap, effectiveContrastLimits, useDecibels, effectiveUseDecibels, displayMode, compositeId, imageData, fileType, nisarFile, cogUrl, roi, roiProfile, profileShow, addStatusLog, showHistogramOverlay, histogramData, selectedPolarization, classifierOpen, classificationMap, classRegions, classifierRoiDims, roiRGBContrastLimits, roiRGBBounds, roiCompositeId, roiRGBHistogramData, roiTSContrastLimits, roiTSBounds, roiTSFrames, roiTSIndex, nisarProductType, serializeViewerState, attributionEnabled, attributionVendor, attributionProcessor, annotations, figureTheme, figureGridMode, colorbarLabel, satelliteMapVisible, overviewMapVisible, wgs84Bounds, mainClassInfo]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ctrl+Shift+{ — open command palette (works even from inputs).
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === '{' || e.key === '[')) {
        e.preventDefault();
        setCommandPaletteOpen(prev => !prev);
        return;
      }

      // Skip when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

      // Ctrl+Shift+S — Save figure with all overlays
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        handleSaveFigureWithOverlays();
        return;
      }
      // Ctrl+S — Save basic figure (no overlays)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 's') {
        e.preventDefault();
        handleSaveFigure();
        return;
      }

      // Ctrl+C / Cmd+C — Copy current render state (viewport + scales + options) as JSON.
      // Defers to native copy when the user has a text selection.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
        const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
        if (sel && sel.toString().length > 0) return;
        e.preventDefault();
        const state = serializeRenderState();
        const json = JSON.stringify(state, null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(json).then(
            () => addStatusLog('success', 'Render state copied to clipboard'),
            (err) => addStatusLog('error', 'Failed to copy render state', err && err.message),
          );
        } else {
          addStatusLog('error', 'Clipboard API unavailable');
        }
        return;
      }

      // Ctrl+V / Cmd+V — Restore render state from clipboard JSON.
      // Silently no-op for clipboard contents that are not SARdine state.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
        if (!navigator.clipboard || !navigator.clipboard.readText) {
          addStatusLog('error', 'Clipboard API unavailable');
          return;
        }
        e.preventDefault();
        navigator.clipboard.readText().then(
          (text) => {
            let parsed;
            try {
              parsed = JSON.parse(text);
            } catch {
              addStatusLog('warning', 'Clipboard does not contain SARdine render state');
              return;
            }
            if (applyRenderState(parsed)) {
              addStatusLog('success', 'Render state restored from clipboard');
            } else {
              addStatusLog('warning', 'Clipboard does not contain SARdine render state');
            }
          },
          (err) => addStatusLog('error', 'Failed to read clipboard', err && err.message),
        );
        return;
      }

      // Keyboard shortcuts (only when no modifier keys)
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'h' || e.key === 'H') {
          setShowHistogramOverlay(prev => !prev);
          return;
        }
        if (e.key === 'c' || e.key === 'C') {
          if (imageData) setClassifierOpen(prev => !prev);
          return;
        }
        if (e.key === 'm' || e.key === 'M') {
          setMedicalMode(prev => {
            const next = !prev;
            addStatusLog('info', `Analytical/medical mode ${next ? 'enabled' : 'disabled'}`);
            return next;
          });
          return;
        }
        if (e.key === 'i' || e.key === 'I') {
          // Invert grayscale — only meaningful in medical mode but
          // we let the toggle work always, gated by the overlay.
          setMedicalInverted(prev => !prev);
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSaveFigure, handleSaveFigureWithOverlays, roi, serializeRenderState, applyRenderState, addStatusLog, imageData]);

  const handleExportColorbar = useCallback(async (fmt) => {
    const format = fmt === 'svg' ? 'svg' : 'png';
    if (!isRGBDisplayMode || !compositeId) {
      addStatusLog('error', 'Colorbar export requires RGB composite mode');
      return;
    }

    try {
      const blob = await exportRGBColorbar({
        compositeId,
        contrastLimits: effectiveContrastLimits,
        useDecibels: effectiveUseDecibels,
        stretchMode,
        gamma,
        colorblindMode,
        format,
        theme: figureTheme,
      });

      if (!blob) {
        addStatusLog('error', 'Failed to generate colorbar');
        return;
      }

      const filename = `colorbar_${compositeId}.${format}`;
      downloadBlob(blob, filename);
      addStatusLog('success', `Colorbar saved: ${filename}`);
    } catch (e) {
      addStatusLog('error', 'Colorbar export failed', e.message);
      console.error('Colorbar export error:', e);
    }
  }, [compositeId, effectiveContrastLimits, useDecibels, stretchMode, gamma, isRGBDisplayMode, colorblindMode, addStatusLog, figureTheme]);

  // Reload/restart current rendering — full data + state refresh
  const handleReload = useCallback(async () => {
    if (!imageData) {
      addStatusLog('warning', 'No data loaded to reload');
      return;
    }

    addStatusLog('info', 'Reloading current view...');

    // Clear all derived state
    setImageData(null);
    setHistogramData(null);
    setRoiRGBData(null);
    setRoiRGBBounds(null);
    setRoiRGBContrastLimits(null);
    setRoiRGBHistogramData(null);
    setRoiTSFrames(null);
    setRoiTSBounds(null);
    setRoiTSContrastLimits(null);
    setRoiTSHistogramData(null);
    setRoiTSPlaying(false);
    setRoiTSIndex(0);
    setActiveViewer('main');
    setTileVersion(0);

    // Re-load from source after state clears
    await new Promise(r => setTimeout(r, 50));

    if ((fileType === 'nisar' || fileType === 'nisar-gunw') && nisarFile) {
      handleLoadNISAR();
    } else if ((fileType === 'nisar' || fileType === 'nisar-gunw' || fileType === 'cmr') && remoteUrl) {
      handleLoadRemoteNISAR();
    } else if ((fileType === 'cog' || fileType === 'remote') && cogUrl) {
      handleLoadCOG();
    } else if (fileType === 'cog' && cogRgbRequest) {
      // RGB COG composite: re-trigger the load effect with a fresh object.
      setCogRgbRequest({ ...cogRgbRequest });
    } else {
      addStatusLog('warning', 'Could not determine data source for reload');
    }
  }, [imageData, fileType, nisarFile, remoteUrl, cogUrl, cogRgbRequest, addStatusLog, handleLoadNISAR, handleLoadRemoteNISAR, handleLoadCOG]);

  // Fetch Overture features for entire scene extent (once per enable/theme/data change)
  useEffect(() => {
    if (!overtureEnabled || overtureThemes.length === 0) return;

    if (overtureDebounceRef.current) clearTimeout(overtureDebounceRef.current);

    // Generation token: if the effect re-runs (themes change, file loads) before
    // the in-flight fetch resolves, the stale result is discarded instead of
    // overwriting newer state.
    let cancelled = false;

    overtureDebounceRef.current = setTimeout(async () => {
      try {
        setOvertureLoading(true);
        let wgs84Bbox;

        if (imageData) {
          const globalBounds = imageData.worldBounds || imageData.bounds;
          const crs = imageData.crs || 'EPSG:4326';
          wgs84Bbox = projectedToWGS84(globalBounds, crs);
        } else {
          wgs84Bbox = [-180, -85, 180, 85];
        }

        addStatusLog('info', `Fetching Overture for scene extent...`);
        const data = await fetchAllOvertureThemes(overtureThemes, wgs84Bbox);
        if (cancelled) return;
        setOvertureData(data);

        const totalFeatures = Object.values(data).reduce(
          (sum, fc) => sum + (fc.features?.length || 0), 0
        );
        addStatusLog('success', `Overture: ${totalFeatures} features loaded`);
      } catch (e) {
        if (cancelled) return;
        addStatusLog('warning', 'Overture fetch failed', e.message);
      } finally {
        if (!cancelled) setOvertureLoading(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      if (overtureDebounceRef.current) clearTimeout(overtureDebounceRef.current);
    };
  }, [overtureEnabled, overtureThemes, imageData, addStatusLog]);

  // Build Overture overlay layers for deck.gl
  const overtureLayers = useMemo(() => {
    if (!overtureEnabled || !overtureData) return [];
    const crs = imageData?.crs || 'EPSG:4326';
    const projection = imageData?.projection || null;
    const bounds = imageData?.bounds || null;
    const worldBounds = imageData?.worldBounds || null;
    return createOvertureLayers(overtureData, { opacity: overtureOpacity, crs, projection, bounds, worldBounds });
  }, [overtureEnabled, overtureData, overtureOpacity, imageData]);

  // Optical peek raster overlay. Only supports CRSes that OpticalPeekLayer's
  // inline proj4DefFor recognises (EPSG:4326, UTM north/south, polar stereo).
  // SICD slant-plane chips have a `projection` object instead of a CRS string
  // and aren't supported yet — the layer just no-ops.
  const opticalPeekLayers = useMemo(() => {
    if (!opticalPeekEnabled || !imageData?.bounds) return [];
    // maxZoom bounds the viewport-tracking detail atlas (W026). Esri serves
    // deeper in metro areas but z19 (~0.3 m/px) is the broadly-available
    // floor; past real coverage the layer overzoom-fills from parent tiles.
    const PROVIDERS = {
      esri: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19 },
      osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 },
    };
    const provider = PROVIDERS[opticalPeekProvider] || PROVIDERS.esri;
    // Two-bounds split for the OrthographicView pipeline:
    //   • `bounds` drives the quad geometry — must match the SAR layer's
    //     coord space, which is pixel-space [0, 0, W, H] for COG/NITF
    //     local loads and the geographic extent for NISAR GCOV.
    //   • `geoBounds` drives the projection math (proj4 inverse to lon/lat
    //     → atlas warp) — always the geographic extent.
    // For local TIFs loadLocalTIF puts pixel-space in bounds and the UTM
    // extent in worldBounds. For NISAR/COG-URL bounds == worldBounds and
    // the dispatch is a no-op.
    return [new OpticalPeekLayer({
      id: 'optical-peek',
      bounds: imageData.bounds,
      geoBounds: imageData.worldBounds || imageData.bounds,
      crs: imageData.crs || 'EPSG:4326',
      tileUrlTemplate: provider.url,
      maxZoom: provider.maxZoom,
      opacity: opticalPeekOpacity,
      onStatus: (level, message) => addStatusLog(level, message),
    })];
  }, [opticalPeekEnabled, opticalPeekProvider, opticalPeekOpacity, imageData?.bounds, imageData?.worldBounds, imageData?.crs, addStatusLog]);

  // Build GeoJSON overlay layers from dropped files
  const geojsonOverlayLayers = useMemo(() => {
    if (droppedGeoJSON.length === 0) return [];
    const crs = imageData?.crs || 'EPSG:4326';
    const projection = imageData?.projection || null;
    const bounds = imageData?.bounds || null;
    const worldBounds = imageData?.worldBounds || null;

    // Shared SICD/proj4/identity reprojection — same path Overture uses.
    const reprojectFn = makeReproject({ projection, crs, worldBounds, pixelBounds: bounds });
    function reprojectData(data) {
      if (data.type === 'FeatureCollection') {
        return { ...data, features: data.features.map(f => reprojectFeature(f, reprojectFn)) };
      }
      return reprojectFeature(data, reprojectFn);
    }

    const needsReproject = reprojectFn !== null;
    const colors = [
      [255, 200, 0],   // yellow
      [0, 200, 255],   // cyan
      [255, 100, 200], // pink
      [100, 255, 100], // green
      [255, 140, 0],   // orange
    ];
    const coordSys = needsReproject ? COORDINATE_SYSTEM.CARTESIAN : COORDINATE_SYSTEM.LNGLAT;
    return droppedGeoJSON.map((entry, i) => {
      const color = colors[i % colors.length];
      const data = needsReproject ? reprojectData(entry.data) : entry.data;
      return new GeoJsonLayer({
        id: entry.id,
        data,
        coordinateSystem: coordSys,
        pickable: true,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 2,
        pointRadiusMinPixels: 5,
        getLineColor: [...color, 220],
        getFillColor: [...color, 40],
        getPointRadius: 5,
        getLineWidth: 2,
        onClick: (info) => {
          if (info.object) {
            setGeojsonPopup({
              x: info.x,
              y: info.y,
              properties: info.object.properties || {},
              geometry: info.object.geometry,
              layer: entry.name,
            });
          }
        },
      });
    });
  }, [droppedGeoJSON, imageData]);

  // ── Command palette actions ───────────────────────────────────────
  // Self-contained registry of every meaningful operation, surfaced via Cmd-K.
  // Actions are gated by `when` so unavailable ones are filtered out automatically.
  const paletteActions = useMemo(() => {
    const hasData = !!imageData;
    const hasHist = !!histogramData?.single;
    const setSigma = (n) => () => {
      const s = histogramData?.single;
      if (!s || !Number.isFinite(s.mean) || !Number.isFinite(s.std)) return;
      setContrastMin(s.mean - n * s.std);
      setContrastMax(s.mean + n * s.std);
      addStatusLog('info', `Stretch: ±${n}σ`);
    };
    const setPctile = () => {
      const s = histogramData?.single;
      if (!s || !Number.isFinite(s.p2) || !Number.isFinite(s.p98)) return;
      setContrastMin(s.p2);
      setContrastMax(s.p98);
      addStatusLog('info', 'Stretch: 2–98%');
    };
    return [
      // Mode toggles
      { id: 'mode.medical', group: 'mode', label: 'Toggle analytical / medical mode', shortcut: 'M', run: () => setMedicalMode(v => !v) },
      { id: 'mode.invert', group: 'mode', label: 'Toggle inverted grayscale', shortcut: 'I', run: () => setMedicalInverted(v => !v) },
      { id: 'mode.histogram', group: 'mode', label: 'Toggle histogram overlay', shortcut: 'H', run: () => setShowHistogramOverlay(v => !v) },
      { id: 'mode.grid', group: 'mode', label: 'Toggle coordinate grid', run: () => setShowGrid(v => !v) },
      { id: 'mode.db', group: 'mode', label: 'Toggle dB / linear', run: () => setUseDecibels(v => !v) },
      { id: 'mode.classifier', group: 'mode', label: 'Toggle classifier', shortcut: 'C', when: () => hasData, run: () => setClassifierOpen(v => !v) },
      { id: 'mode.profileV', group: 'mode', label: 'Toggle ROI vertical profile', when: () => !!roi, run: () => setProfileShow(p => ({ ...p, v: !p.v })) },
      { id: 'mode.profileH', group: 'mode', label: 'Toggle ROI horizontal profile', when: () => !!roi, run: () => setProfileShow(p => ({ ...p, h: !p.h })) },
      { id: 'mode.profileI', group: 'mode', label: 'Toggle ROI intensity histogram', when: () => !!roi, run: () => setProfileShow(p => ({ ...p, i: !p.i })) },
      { id: 'mode.transect', group: 'mode', label: transectEnabled ? 'Transect tool: disable' : 'Transect tool: draw a profile line', when: () => hasData, run: () => setTransectEnabled(v => {
          const next = !v;
          if (next) { setBottomTab('transect'); setStatusCollapsed(false); }
          return next;
        }) },
      { id: 'mode.transectClear', group: 'mode', label: 'Transect: clear line', when: () => !!transectLine, run: () => setTransectLine(null) },

      // Stretch presets
      { id: 'stretch.1sigma', group: 'stretch', label: 'Stretch ±1σ', when: () => hasHist, run: setSigma(1) },
      { id: 'stretch.2sigma', group: 'stretch', label: 'Stretch ±2σ', when: () => hasHist, run: setSigma(2) },
      { id: 'stretch.3sigma', group: 'stretch', label: 'Stretch ±3σ', when: () => hasHist, run: setSigma(3) },
      { id: 'stretch.pct', group: 'stretch', label: 'Stretch 2–98 percentile', when: () => hasHist, run: setPctile },

      // Stretch modes
      { id: 'stretchmode.linear', group: 'stretch mode', label: 'Linear', run: () => setStretchMode('linear') },
      { id: 'stretchmode.sqrt', group: 'stretch mode', label: 'Square root', run: () => setStretchMode('sqrt') },
      { id: 'stretchmode.cbrt', group: 'stretch mode', label: 'Cube root', run: () => setStretchMode('cbrt') },
      { id: 'stretchmode.log', group: 'stretch mode', label: 'Logarithmic', run: () => setStretchMode('log') },
      { id: 'stretchmode.gamma', group: 'stretch mode', label: 'Gamma', run: () => setStretchMode('gamma') },
      { id: 'stretchmode.sigmoid', group: 'stretch mode', label: 'Sigmoid', run: () => setStretchMode('sigmoid') },

      // Colormaps
      { id: 'cmap.gray', group: 'colormap', label: 'Grayscale', run: () => setColormap('grayscale') },
      { id: 'cmap.viridis', group: 'colormap', label: 'Viridis', run: () => setColormap('viridis') },
      { id: 'cmap.inferno', group: 'colormap', label: 'Inferno', run: () => setColormap('inferno') },
      { id: 'cmap.plasma', group: 'colormap', label: 'Plasma', run: () => setColormap('plasma') },
      { id: 'cmap.rdbu', group: 'colormap', label: 'RdBu (diverging)', run: () => setColormap('rdbu') },
      { id: 'cmap.romaO', group: 'colormap', label: 'romaO (cyclic)', run: () => setColormap('romaO') },
      { id: 'cmap.phase', group: 'colormap', label: 'Phase (cyclic HSV)', run: () => setColormap('phase') },

      // Actions
      { id: 'act.reload', group: 'action', label: 'Reload current view', when: () => hasData, run: handleReload },
      { id: 'act.figure', group: 'action', label: 'Save figure (PNG)', shortcut: 'Ctrl+S', when: () => hasData || compareMode, run: handleSaveFigure },
      { id: 'act.figureOverlays', group: 'action', label: 'Save figure with overlays', shortcut: 'Ctrl+Shift+S', when: () => hasData, run: handleSaveFigureWithOverlays },
      { id: 'act.colorbar', group: 'action', label: 'Export RGB colorbar', when: () => isRGBDisplayMode, run: handleExportColorbar },
    ];
  }, [
    imageData, histogramData, isRGBDisplayMode, compareMode, roi, transectEnabled, transectLine,
    handleReload, handleSaveFigure, handleSaveFigureWithOverlays, handleExportColorbar, addStatusLog,
  ]);

  // ── Model plugin handlers (W025) ──────────────────────────────────

  // ROI band extraction for model runs — same getExportStripe path as the
  // classifier, capped ~384 px on the long axis, returns LINEAR POWER
  // (the registry applies the manifest's declared transform).
  const extractRoiBandsForModel = useCallback(async (wantBands) => {
    const sourceW = imageData.width;
    const sourceH = imageData.height;
    const ml = Math.max(1, Math.ceil(Math.max(roi.width, roi.height) / 384));
    const startCol = Math.floor(Math.max(0, roi.left) / ml);
    const startRow = Math.floor(Math.max(0, roi.top) / ml);
    const endCol = Math.floor(Math.min(roi.left + roi.width, sourceW) / ml);
    const endRow = Math.floor(Math.min(roi.top + roi.height, sourceH) / ml);
    const exportW = Math.max(1, endCol - startCol);
    const exportH = Math.max(1, endRow - startRow);
    const result = await imageData.getExportStripe({
      startRow, numRows: exportH, ml, exportWidth: exportW, startCol, numCols: exportW,
    });
    const names = Object.keys(result.bands);
    const resolved = wantBands.map((b, i) => {
      if (b === 'ACTIVE') return result.bands[selectedPolarization] ? selectedPolarization : names[0];
      return result.bands[b] ? b : (names[i] ?? names[0]);
    });
    const bands = resolved.map((n) => result.bands[n]);
    if (bands.some((b) => !b)) {
      throw new Error(`bands unavailable: wanted [${wantBands.join(', ')}], scene has [${names.join(', ')}]`);
    }
    return { bands, width: exportW, height: exportH, resolved };
  }, [imageData, roi, selectedPolarization]);

  // classmap result → overlay {map (1-based), regions}; classes with
  // color_hint 00000000 (e.g. "not water") stay undrawn; 255 = invalid.
  const overlayFromClassmap = useCallback((result, classes) => {
    const n = result.data.length;
    const map = new Uint8Array(n);
    const regions = [];
    const valueToIdx = new Map();
    for (const c of (classes || [])) {
      if ((c.color_hint || '') === '00000000') { valueToIdx.set(c.value, 0); continue; }
      regions.push({ name: c.name, color: `#${c.color_hint || '4ec9d4'}` });
      valueToIdx.set(c.value, regions.length);
    }
    for (let i = 0; i < n; i++) {
      const v = result.data[i];
      map[i] = v === 255 ? 0 : (valueToIdx.get(v) ?? 0);
    }
    return { map, dims: { w: result.width, h: result.height }, regions };
  }, []);

  const handleRunModel = useCallback(async (manifest) => {
    if (!imageData || !roi) {
      addStatusLog('warning', 'Load a scene and Shift+drag an ROI before running a model');
      return;
    }
    const ctrl = new AbortController();
    modelAbortRef.current = ctrl;
    setModelBusyId(manifest.id);
    setModelProgress(null);
    setModelRunInfo(null);
    try {
      const d = manifestDefaults(manifest);
      const input = await extractRoiBandsForModel(d.bands);
      const result = await runModel(manifest, input, {
        signal: ctrl.signal,
        onProgress: (phase, done, total) => setModelProgress({ phase, done, total }),
      });
      if (result.kind === 'classmap') {
        setModelOverlay(overlayFromClassmap(result, d.classes));
        setModelPreview(null);
      } else if (result.kind === 'raster') {
        setModelPreview({ before: input.bands[0], after: result.data, width: result.width, height: result.height });
      }
      setModelRunInfo({ id: manifest.id, ep: result.ep, weightsFrom: result.weightsFrom, elapsedMs: result.elapsedMs });
      addStatusLog('success', `Model ran: ${manifest['mlm:name']}`,
        `${Math.round(result.elapsedMs)} ms${result.ep ? ` · ${result.ep} EP` : ''}${result.weightsFrom ? ` · weights: ${result.weightsFrom}` : ''}`);
    } catch (e) {
      if (e?.name === 'AbortError') addStatusLog('info', `Model run canceled: ${manifest['mlm:name']}`);
      else addStatusLog('error', `Model failed: ${manifest['mlm:name']}`, e.message);
    } finally {
      setModelBusyId(null);
      setModelProgress(null);
      modelAbortRef.current = null;
    }
  }, [imageData, roi, extractRoiBandsForModel, overlayFromClassmap, addStatusLog]);

  const handleCancelModel = useCallback(() => { modelAbortRef.current?.abort(); }, []);

  // Fast path for the live loop: predict directly on the classifier's
  // already-extracted dB features — no re-extraction, milliseconds.
  const applyHeadToClassifierData = useCallback((manifest) => {
    if (!classifierData || !manifest) return;
    const { x, y, valid, w, h } = classifierData;
    const n = x.length;
    const X = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      X[i * 2] = valid[i] ? x[i] : NaN;
      X[i * 2 + 1] = valid[i] ? y[i] : NaN;
    }
    const classes = manifest['mlm:output'][0]['classification:classes'];
    const model = {
      weights: manifest['sardine:params'].weights,
      mean: manifest['sardine:params'].mean,
      std: manifest['sardine:params'].std,
      numClasses: classes.length,
      numFeatures: 2,
    };
    const { labels } = predictLogistic(model, X, n);
    const regions = classes.map((c) => ({ name: c.name, color: `#${c.color_hint || '4ec9d4'}` }));
    const map = new Uint8Array(n);
    for (let i = 0; i < n; i++) map[i] = labels[i] === 255 ? 0 : labels[i] + 1;
    setModelOverlay({ map, dims: { w, h }, regions });
  }, [classifierData]);

  const fitHeadFromLabels = useCallback((applyAfter = true) => {
    if (!classifierData || classRegions.length < 2) return null;
    try {
      const ds = datasetFromClassRegions(classifierData, classRegions, { seed: 1337 });
      const split = stratifiedSplit(
        { X: ds.X, y: ds.y, n: ds.n, numFeatures: 2, numClasses: ds.numClasses },
        { testFraction: 0.25, seed: 1337 });
      const model = trainLogistic({
        X: split.train.X, y: split.train.y,
        numClasses: ds.numClasses, numFeatures: 2, seed: 1337,
      });
      const metrics = evaluateModel(model, split.test.X, split.test.y, split.test.n);
      const manifest = buildHeadManifest({
        name: `${classifierBands.x}/${classifierBands.y} head`,
        model,
        bands: [classifierBands.x, classifierBands.y],
        transform: 'dB',
        classes: classRegions.map((r) => ({ name: r.name, color: r.color })),
        metrics,
        provenance: {
          scene: (fileType === 'nisar' || fileType === 'nisar-gunw') ? (nisarFile?.name || null) : (cogUrl || null),
          nTrain: split.train.n, nTest: split.test.n,
        },
      });
      setHeadManifest(manifest);
      setHeadMetrics(metrics);
      try { modelRegistry.register(manifest); setModelListVersion((v) => v + 1); } catch { /* replace in place */ }
      if (applyAfter) applyHeadToClassifierData(manifest);
      return manifest;
    } catch (e) {
      addStatusLog('error', 'Head fit failed', e.message);
      return null;
    }
  }, [classifierData, classRegions, classifierBands, fileType, nisarFile, cogUrl,
    modelRegistry, applyHeadToClassifierData, addStatusLog]);

  // Live loop: refit + repaint on label changes (classical head only).
  useEffect(() => {
    if (!liveFit || !classifierData || classRegions.length < 2) return undefined;
    const t = setTimeout(() => { fitHeadFromLabels(true); }, 300);
    return () => clearTimeout(t);
  }, [liveFit, classifierData, classRegions, fitHeadFromLabels]);

  const handleApplyHead = useCallback(() => {
    if (!headManifest) return;
    if (classifierData) applyHeadToClassifierData(headManifest);
    else handleRunModel(headManifest);
  }, [headManifest, classifierData, applyHeadToClassifierData, handleRunModel]);

  const handleSaveHead = useCallback(() => {
    if (!headManifest) return;
    const blob = new Blob([serializeManifest(headManifest)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${headManifest.id}.sardine-model.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    addStatusLog('success', `Model saved: ${a.download}`, 'STAC-MLM-aligned manifest; loads back via "Load model…"');
  }, [headManifest, addStatusLog]);

  const handleLoadManifestFile = useCallback((file) => {
    file.text().then((text) => {
      const { manifest, warnings } = deserializeManifest(text);
      const regWarnings = modelRegistry.register(manifest);
      setModelListVersion((v) => v + 1);
      for (const wmsg of [...warnings, ...regWarnings]) addStatusLog('warning', wmsg);
      addStatusLog('success', `Model loaded: ${manifest['mlm:name']}`,
        `${manifest['sardine:backend']} · ${manifest['mlm:tasks'].join(', ')}`);
    }).catch((e) => addStatusLog('error', `Model load failed: ${file.name}`, e.message));
  }, [modelRegistry, addStatusLog]);

  // ── Activity rail + viewer context menu ──────────────────────────
  const handleRailSelect = useCallback((id) => {
    if (id === activePanel && panelOpen) {
      setPanelOpen(false);
    } else {
      setActivePanel(id);
      setPanelOpen(true);
    }
  }, [activePanel, panelOpen]);

  // First load: advance from Data to Display once a scene is on screen.
  const railAutoAdvancedRef = useRef(false);
  useEffect(() => {
    if (imageData && !railAutoAdvancedRef.current) {
      railAutoAdvancedRef.current = true;
      setActivePanel(prev => (prev === 'data' ? 'display' : prev));
    }
    if (!imageData) railAutoAdvancedRef.current = false;
  }, [imageData]);

  // Context menu items come from the same registry as the command palette,
  // plus viewer-specific extras. Gated by each action's `when`.
  const contextMenuItems = useMemo(() => {
    const pick = (id) => {
      const a = paletteActions.find(x => x.id === id);
      return a && (!a.when || a.when()) ? a : null;
    };
    const items = [];
    if (imageData?.bounds) {
      items.push({ id: 'ctx.fit', group: 'view', label: 'Fit view to data', run: fitToBounds });
    }
    const reload = pick('act.reload');
    if (reload) items.push({ ...reload, group: 'view', label: 'Reload view' });
    if (imageData) {
      items.push({
        id: 'ctx.arrow', group: 'annotate',
        label: annotationMode === 'arrow' ? 'Annotate: stop arrow tool' : 'Annotate: arrow',
        run: () => setAnnotationMode(m => (m === 'arrow' ? 'off' : 'arrow')),
      });
      items.push({
        id: 'ctx.text', group: 'annotate',
        label: annotationMode === 'text' ? 'Annotate: stop text tool' : 'Annotate: text label',
        run: () => setAnnotationMode(m => (m === 'text' ? 'off' : 'text')),
      });
    }
    if (roi) {
      items.push({ id: 'ctx.roiClear', group: 'roi', label: 'Clear ROI', run: () => setROI(null) });
      const cls = pick('mode.classifier');
      if (cls) items.push({ ...cls, group: 'roi' });
    }
    for (const id of ['mode.histogram', 'mode.grid']) {
      const a = pick(id);
      if (a) items.push({ ...a, group: 'display' });
    }
    const fig = pick('act.figure');
    if (fig) items.push({ ...fig, group: 'capture' });
    const figO = pick('act.figureOverlays');
    if (figO) items.push({ ...figO, group: 'capture' });
    if (imageData) {
      items.push({
        id: 'ctx.copystate', group: 'clipboard', label: 'Copy render state', shortcut: 'Ctrl+C',
        run: () => {
          const json = JSON.stringify(serializeRenderState(), null, 2);
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(json).then(
              () => addStatusLog('success', 'Render state copied to clipboard'),
              (err) => addStatusLog('error', 'Failed to copy render state', err && err.message),
            );
          } else {
            addStatusLog('error', 'Clipboard API unavailable');
          }
        },
      });
    }
    items.push({
      id: 'ctx.palette', group: 'more', label: 'All commands…', shortcut: 'Ctrl+Shift+{',
      run: () => setCommandPaletteOpen(true),
    });
    return items;
  }, [paletteActions, imageData, roi, annotationMode, fitToBounds, serializeRenderState, addStatusLog]);

  const handleViewerContextMenu = useCallback((e) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // Long-press → context menu on touch devices (iOS Safari has no
  // contextmenu event; Android fires both — the second set is a no-op).
  const longPressTimerRef = useRef(null);
  const handleViewerPointerDown = useCallback((e) => {
    if (e.pointerType !== 'touch') return;
    const { clientX, clientY } = e;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      setContextMenu({ x: clientX, y: clientY });
    }, 550);
  }, []);
  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // NOTE: Duplicate block removed — all handlers defined above
  return (
    <div id="app"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget.contains(e.relatedTarget)) return; setDragOver(false); }}
      onDrop={handleFileDrop}
    >
      <PagesBanner />
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        actions={paletteActions}
      />
      <ContextMenu
        open={!!contextMenu}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        items={contextMenuItems}
        onClose={() => setContextMenu(null)}
      />
      {/* Drag-and-drop overlay */}
      {dragOver && (
        <div className="dropzone">
          <p className="dropzone__label">
            {fileType === 'local-tif' && mosaicFiles.length > 0
              ? `Drop GeoTIFFs to add to mosaic (${mosaicFiles.length} loaded)`
              : (fileType === 'nisar' && nisarProductType === 'GCOV' && nisarFile)
                ? `Drop GCOV files to add to mosaic (${gcovMosaicFiles.length} secondary)`
                : 'Drop HDF5, GeoTIFF, or GeoJSON file'}
          </p>
        </div>
      )}
      {/* GeoJSON feature popup */}
      {geojsonPopup && (
        <div
          className="feature-popup"
          role="dialog"
          aria-label="Feature properties"
          style={{ left: geojsonPopup.x + 12, top: geojsonPopup.y - 12 }}
        >
          <header className="u-between u-mb-sm">
            <h2 className="feature-popup__title">{geojsonPopup.geometry?.type || 'Feature'}</h2>
            <CloseButton onClick={() => setGeojsonPopup(null)} label="Close feature popup" />
          </header>
          <p className="feature-popup__layer">{geojsonPopup.layer}</p>
          <table className="feature-popup__table">
            <tbody>
              {Object.entries(geojsonPopup.properties).map(([key, val]) => (
                <tr key={key}>
                  <th scope="row">{key}</th>
                  <td>{String(val ?? '')}</td>
                </tr>
              ))}
              {Object.keys(geojsonPopup.properties).length === 0 && (
                <tr><td className="feature-popup__empty">No properties</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {/* Header */}
      <div className="header">
        <h1><span className="sar">SAR</span>dine</h1>
        <span className="subtitle">SAR Data INspection and Exploration</span>
      </div>

      {/* Main Layout */}
      <div className="main-layout">
        <ActivityRail
          groups={RAIL_GROUPS}
          active={activePanel}
          open={panelOpen}
          onSelect={handleRailSelect}
          onPalette={() => setCommandPaletteOpen(true)}
        />
        {/* Controls Panel — one rail group visible at a time */}
        <div
          ref={controlsPanelRef}
          className={`controls-panel${panelOpen ? '' : ' closed'}${sheetExpanded ? ' expanded' : ''}`}
        >
          <button
            className="sheet-handle"
            aria-label={sheetExpanded ? 'Collapse panel' : 'Expand panel'}
            onClick={handleSheetClick}
            onPointerDown={handleSheetPointerDown}
            onPointerMove={handleSheetPointerMove}
            onPointerUp={handleSheetPointerUp}
            onPointerCancel={handleSheetPointerUp}
          />
          {!imageData && (activePanel === 'analysis' || (activePanel === 'export' && !compareMode)) && (
            <div className="control-section u-note">
              Load a scene to enable {activePanel === 'analysis'
                ? 'ROI, annotation, and profile tools'
                : 'export and share options'}.
            </div>
          )}
          {activePanel === 'data' && (<>
          {/* Data Source Selection */}
          <CollapsibleSection title="Data Source">
            <div className="control-group">
              <select value={fileType} onChange={(e) => setFileType(e.target.value)}>
                <option value="nisar">Local HDF5 (NISAR GCOV)</option>
                <option value="nisar-gunw">Local HDF5 (NISAR GUNW)</option>
                <option value="local-tif">Local GeoTIFF</option>
                <option value="remote">Remote URL / S3</option>
                <option value="cmr">NISAR Search (CMR)</option>
              </select>
            </div>
          </CollapsibleSection>

          {/* Earthdata Login — only relevant for hosted builds, but always
              shown so users can configure even in dev. */}
          <CollapsibleSection title="Earthdata Login" defaultOpen={isHostedBuild() && !edlToken}>
            <div className="u-lede u-mb-sm">
              {isHostedBuild()
                ? 'Required for streaming NISAR / Sentinel-1 / OPERA from NASA DAACs. Your token is stored only in this browser.'
                : 'Optional in dev (the Vite proxy bypasses auth). Useful for testing the hosted flow.'}
            </div>
            <div className="control-group">
              <label className="u-sm">EDL token</label>
              <input
                type="password"
                placeholder="Paste your Earthdata Login token"
                value={edlToken}
                onChange={(e) => {
                  setEdlTokenState(e.target.value);
                  setEDLToken(e.target.value);
                  setEdlValidation(null);
                }}
                style={{
                  width: '100%', padding: '4px 6px', fontSize: 'var(--text-sm)',
                  background: 'var(--sardine-bg-panel)',
                  border: '1px solid var(--sardine-border)',
                  color: 'var(--sardine-text-primary, #e8edf5)',
                  borderRadius: '2px',
                }}
              />
              <div className="u-hint u-mt-2xs">
                <a href="https://urs.earthdata.nasa.gov/profile" target="_blank" rel="noopener noreferrer" className="u-accent">
                  Open Earthdata profile →
                </a>
                <br/>
                Then click <strong>Generate Token</strong> in the left sidebar.
              </div>
              <div className="u-hint u-mt-sm">
                <strong>Where your token goes:</strong> it stays in this browser's
                localStorage and is sent only to NASA servers{isHostedBuild()
                  ? ' via the relay Worker below (needed because DAACs don’t send CORS headers). SARdine is a research project — the Worker doesn’t log or store tokens, and its ~200-line source is in the repo (sardine-edl-proxy/). Don’t want to take our word for it? Deploy your own copy and paste its URL below.'
                  : ' (the local dev proxy relays it).'}{' '}
                EDL tokens are read-only data-access credentials for mostly-public
                data, they expire, and you can{' '}
                <a href="https://urs.earthdata.nasa.gov/user_tokens" target="_blank" rel="noopener noreferrer" className="u-accent">revoke them anytime</a>.
              </div>
            </div>
            {isHostedBuild() && (
              <Field label="Proxy URL" className="control-group">
                <input
                  type="text"
                  value={edlProxyUrl}
                  onChange={(e) => {
                    setEdlProxyUrl(e.target.value);
                    setProxyUrl(e.target.value);
                    setEdlValidation(null);
                  }}
                  style={{
                    width: '100%', padding: '4px 6px', fontSize: 'var(--text-sm)',
                    background: 'var(--sardine-bg-panel)',
                    border: '1px solid var(--sardine-border)',
                    color: 'var(--sardine-text-primary, #e8edf5)',
                    borderRadius: '2px',
                  }}
                />
              </Field>
            )}
            <div className="control-group u-row-sm">
              <button
                onClick={async () => {
                  setEdlValidating(true);
                  setEdlValidation(null);
                  const result = validateEDLToken(edlToken);
                  setEdlValidation(result);
                  setEdlValidating(false);
                  if (result.ok) {
                    addStatusLog('success',
                      `Earthdata token valid — ${result.username}, ${result.daysLeft} day${result.daysLeft === 1 ? '' : 's'} left`);
                  } else {
                    addStatusLog('error', `Earthdata token check failed: ${result.error}`);
                  }
                }}
                disabled={!edlToken || edlValidating} className="u-flex1 u-sm">
                {edlValidating ? 'Checking…' : 'Test token'}
              </button>
              {edlValidation?.ok && (
                <span className="u-sm u-accent" role="status">
                  ✓ {edlValidation.username} · expires {edlValidation.expiresAt.toISOString().slice(0, 10)}
                  {' '}({edlValidation.daysLeft}d)
                </span>
              )}
              {edlValidation && !edlValidation.ok && (
                // Show the reason inline. It used to live in a `title` tooltip,
                // which is invisible to touch and keyboard users and hid the one
                // detail that makes the failure actionable.
                <span className="u-xs" style={{ color: 'var(--sardine-orange)' }} role="alert">
                  ✗ {edlValidation.error}
                </span>
              )}
            </div>
          </CollapsibleSection>

          </>)}

          {/* Share link — remote sources carry the data URL; local files get a
              ?file= state link (render + view params + filename hint) that
              applies when the same file is loaded again (W008). Compare mode
              emits a ?compare= link from the URL-backed panels. */}
          {activePanel === 'export' && (sharedRawUrl || imageData || compareMode) && (
            <CollapsibleSection title="Share Link" defaultOpen={false}>
              <div className="u-lede u-mb-sm">
                {compareMode
                  ? 'Compare grid — the link reopens the grid with its URL-loaded panels. Local-file panels cannot travel in a URL and are skipped.'
                  : sharedRawUrl
                    ? 'Shareable URL with current data + render state. Recipient still needs their own Earthdata token for DAAC sources.'
                    : 'Local file — the link carries the render + view state (no data travels). Open it, then load the same file to reproduce this view.'}
              </div>
              <div className="control-group u-row-sm">
                <button
                  disabled={!compareMode && !sharedRawUrl && !localShareName}
                  title={compareMode
                    ? 'Copy a compare link (URL-loaded panels only)'
                    : sharedRawUrl
                      ? 'Copy a deep link that reproduces this view'
                      : localShareName
                        ? 'Copy a state link — open it, then load this file again to reproduce the view'
                        : 'No shareable source loaded'}
                  onClick={async () => {
                    // Compare grid → ?compare= link from the URL-backed panels.
                    if (compareMode) {
                      const gridPanels = compareGridRef.current?.getPanels?.() || [];
                      const urlPanels = gridPanels.filter((p) => p.url)
                        .map((p) => ({ url: p.url, label: p.name }));
                      if (urlPanels.length === 0) {
                        addStatusLog('warning', 'Compare link needs URL-loaded panels — local-file panels cannot travel in a URL');
                        return;
                      }
                      try {
                        const link = buildCompareLink({ panels: urlPanels });
                        await navigator.clipboard.writeText(link);
                        const skipped = gridPanels.length - urlPanels.length;
                        addStatusLog('success',
                          `Compare link copied (${urlPanels.length} panel${urlPanels.length > 1 ? 's' : ''}${skipped ? `, ${skipped} local skipped` : ''})`,
                          link);
                      } catch (e) {
                        addStatusLog('error', `Failed to copy compare link: ${e.message}`);
                      }
                      return;
                    }
                    if (!sharedRawUrl && !localShareName) return;
                    try {
                      // W016: active ROI → ?bbox= (WGS84). ROI pixel range →
                      // file-CRS bounds → inverse-reproject when projected.
                      let roiBbox;
                      if (roi && imageData?.width && imageData?.height) {
                        try {
                          const fileBbox = imageData.worldBounds || imageData.bounds;
                          const sub = computeSubsetBounds(
                            { startRow: roi.top, startCol: roi.left, numRows: roi.height, numCols: roi.width },
                            {
                              worldBounds: fileBbox,
                              width: imageData.width,
                              height: imageData.height,
                              xCoords: imageData.xCoords || null,
                              yCoords: imageData.yCoords || null,
                            });
                          const crs = imageData.crs || 'EPSG:4326';
                          roiBbox = crs === 'EPSG:4326' ? sub : projectedToWGS84(sub, crs);
                        } catch { /* omit bbox from the link */ }
                      }
                      const view = {
                        colormap, reverseColormap, useDecibels,
                        contrastMin, contrastMax, stretchMode, gamma,
                        selectedPolarization, selectedFrequency,
                        multiLook, compositeId, displayMode,
                        viewCenter, viewZoom, roiBbox,
                      };
                      const link = sharedRawUrl
                        ? buildShareLink({
                            dataUrl: sharedRawUrl,
                            // RGB COG composite: carry the full per-band URL
                            // list (raw, un-proxied) so the link round-trips.
                            dataUrls: (fileType === 'cog' && cogRgbRequest?.urls?.length >= 2)
                              ? cogRgbRequest.urls : undefined,
                            dataType: fileType === 'cog' ? 'cog'
                              : fileType === 'nitf' ? 'nitf'
                              : 'nisar',
                            view,
                          })
                        : buildShareLink({ localFile: localShareName, view });
                      await navigator.clipboard.writeText(link);
                      addStatusLog('success',
                        sharedRawUrl
                          ? 'Share link copied to clipboard'
                          : `State link copied — reopen it and load ${localShareName} to reproduce this view`,
                        link);
                    } catch (e) {
                      addStatusLog('error', `Failed to copy share link: ${e.message}`);
                    }
                  }} className="u-flex1 u-sm">
                  Copy share link
                </button>
              </div>
            </CollapsibleSection>
          )}

          {activePanel === 'data' && (<>
          {/* Local GeoTIFF Input */}
          {fileType === 'local-tif' && (
            <CollapsibleSection title="Load Local GeoTIFF">
              <div className="control-group">
                <label>Select one or more .tif files, or a .vrt with its sources</label>
                <input
                  type="file"
                  accept=".tif,.tiff,.vrt"
                  multiple
                  id="local-tif-input" className="u-hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    if (files.length === 0) return;
                    const vrtFile = files.find(f => isVRTPath(f.name));
                    if (vrtFile) {
                      handleLoadVRT({ file: vrtFile, companions: files.filter(f => f !== vrtFile) });
                    } else if (files.length > 1) {
                      handleLocalTIFMultiSelect(files);
                    } else {
                      handleLocalTIFMultiSelect(files);
                    }
                  }}
                />
                <button
                  className="btn-secondary u-full"
                  onClick={() => document.getElementById('local-tif-input').click()}
                  
                >
                  {imageData?.sliceCount > 1
                    ? `${imageData.sliceCount} files loaded - Change...`
                    : imageData?.data ? 'Change File...' : 'Choose File(s)...'}
                </button>
                {loading && loadProgress > 0 && loadProgress < 100 && (
                  <div className="progress-track u-mt-sm">
                    <div className="progress-fill" style={{ width: `${loadProgress}%`, transition: 'width 0.3s ease' }} />
                  </div>
                )}
              </div>

              {/* Compare grid — open up to 4 GeoTIFFs / NISAR .h5 side by side / 2×2 */}
              <Field label="Compare (up to 4, synced)" className="control-group">
                <input
                  type="file"
                  accept=".tif,.tiff,.h5,.hdf5,.he5"
                  multiple
                  id="compare-grid-input" className="u-hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    if (files.length === 0) return;
                    setCompareInitialFiles(files);
                    setCompareMode(true);
                    e.target.value = '';
                  }}
                />
                <button
                  className={compareMode ? 'btn-primary' : 'btn-secondary'}
                  onClick={() => {
                    if (compareMode) { setCompareMode(false); setCompareInitialFiles(null); setCompareInitialUrls(null); }
                    else document.getElementById('compare-grid-input').click();
                  }}
                  style={{ width: '100%' }}
                >
                  {compareMode ? 'Exit Compare Grid' : 'Compare Files…'}
                </button>
              </Field>

              {imageData?.sliceCount > 1 && (
                <div className="control-group u-note">
                  Mosaic: {imageData.sliceCount} slices, {imageData.width}x{imageData.height} px
                  {imageData.crs && <span> · CRS: {imageData.crs}</span>}
                </div>
              )}
              {imageData?.sliceNames && (
                <div className="control-group u-note u-break">
                  {imageData.sliceNames.join(', ')}
                </div>
              )}
              {mosaicFiles.length > 0 && (
                <div className="control-group u-row-sm">
                  <input
                    type="file"
                    accept=".tif,.tiff"
                    multiple
                    id="local-tif-add-input" className="u-hidden"
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      if (files.length > 0) appendMosaicTIFs(files);
                      e.target.value = '';
                    }}
                  />
                  <button
                    className="btn-secondary u-flex1"
                    onClick={() => document.getElementById('local-tif-add-input').click()}
                    
                    title="Add more GeoTIFFs to the current mosaic (must share CRS)"
                  >
                    + Add to Mosaic
                  </button>
                  {mosaicFiles.length > 1 && (
                    <button
                      className="btn-secondary u-flex1"
                      onClick={clearMosaic}
                      
                      title="Remove all mosaicked files"
                    >
                      Clear Mosaic
                    </button>
                  )}
                </div>
              )}
            </CollapsibleSection>
          )}

          {/* NISAR HDF5 Input */}
          {(fileType === 'nisar' || fileType === 'nisar-gunw') && (
            <CollapsibleSection title={`Load NISAR ${nisarProductType}`}>
              <Field label="HDF5 File" className="control-group">
                <input
                  type="file"
                  accept=".h5,.hdf5,.he5"
                  id="nisar-file-input" className="u-hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      handleNISARFileSelect(file);
                    }
                  }}
                />
                <button
                  className="btn-secondary u-full"
                  onClick={() => document.getElementById('nisar-file-input').click()}
                  
                >
                  {nisarFile ? 'Change File...' : 'Choose File...'}
                </button>
              </Field>

              {nisarFile && (
                <div className="control-group u-hint u-break">
                  {nisarFile.name} ({(nisarFile.size / 1e9).toFixed(2)} GB)
                </div>
              )}

              {/* GCOV mosaic — visible only for GCOV (not GUNW) */}
              {fileType === 'nisar' && nisarProductType === 'GCOV' && nisarFile && (
                <>
                  <div className="control-group u-row-sm">
                    <input
                      type="file"
                      accept=".h5,.hdf5,.he5"
                      multiple
                      id="gcov-mosaic-add-input" className="u-hidden"
                      onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        if (files.length > 0) appendGcovMosaicFiles(files);
                        e.target.value = '';
                      }}
                    />
                    <button
                      className="btn-secondary u-flex1"
                      onClick={() => document.getElementById('gcov-mosaic-add-input').click()}
                      
                      title="Add NISAR GCOV files to mosaic alongside the primary (must share CRS)"
                    >
                      + Add GCOV to Mosaic
                    </button>
                    {(gcovMosaicFiles.length > 0 || gcovMosaicLayers.length > 0) && (
                      <button
                        className="btn-secondary u-flex1"
                        onClick={clearGcovMosaic}
                        
                        title="Remove all secondary GCOV layers"
                      >
                        Clear Mosaic
                      </button>
                    )}
                  </div>
                  {gcovMosaicFiles.length > 0 && (
                    <div className="control-group u-note">
                      Mosaic: {gcovMosaicLayers.length} of {gcovMosaicFiles.length} secondary
                      {gcovMosaicFiles.length === 1 ? ' file' : ' files'} loaded
                      <div className="u-xs u-break u-mt-xs">
                        {gcovMosaicFiles.map(f => f.name).join(', ')}
                      </div>
                    </div>
                  )}
                </>
              )}
            </CollapsibleSection>
          )}

          {/* Remote Bucket Browser */}
          {fileType === 'remote' && (
            <CollapsibleSection title="Browse Remote Data">
              {/* Direct URL input (pre-signed S3, HTTPS) */}
              <Field label="Direct URL" className="control-group">
                <input
                  type="text"
                  value={directUrl}
                  onChange={(e) => setDirectUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleDirectUrlSubmit(); }}
                  placeholder="https://…/*.h5 or *.tif (auto-detected)"
                  style={{ fontFamily: 'monospace', fontSize: 'var(--text-sm)' }}
                />
              </Field>
              <button
                className="btn-secondary"
                onClick={handleDirectUrlSubmit}
                disabled={loading || !directUrl.trim()}
                style={{ width: '100%', marginBottom: '12px' }}
              >
                Load from URL
              </button>

              <DataDiscovery
                onSelectFile={handleRemoteFileSelect}
                onStatus={addStatusLog}
                serverOrigin=""
              />

            </CollapsibleSection>
          )}

          {/* Scene Catalog (GeoJSON) */}
          {fileType === 'catalog' && (
            <CollapsibleSection title="Scene Catalog">
              <SceneCatalog
                onSelectScene={(sceneInfo) => {
                  handleRemoteFileSelect({
                    url: sceneInfo.url,
                    name: sceneInfo.name,
                    size: sceneInfo.size || 0,
                    type: sceneInfo.type || 'nisar',
                    // A catalog feature may carry its own token; otherwise fall
                    // back to the stored EDL token. Without this the request
                    // goes out unauthenticated and the DAAC's OAuth redirect
                    // 401s with no indication the token was simply missing.
                    token: sceneInfo.token || getEDLToken() || undefined,
                  });
                }}
                onStatus={addStatusLog}
                onLayersChange={setCatalogLayers}
              />
            </CollapsibleSection>
          )}

          {/* NISAR CMR Search */}
          {fileType === 'cmr' && (
            <CollapsibleSection title="NISAR Search (CMR)">
              <NISARSearch
                onSelectScene={(sceneInfo) => {
                  // Fetch metadata only — user clicks "Load Dataset" to stream data
                  handleRemoteFileSelect({
                    url: sceneInfo.url,
                    name: sceneInfo.name,
                    size: sceneInfo.size || 0,
                    type: sceneInfo.type || 'nisar',
                    token: sceneInfo.token,
                  });
                  // Auto-open OverviewMap to show geographic context
                  setOverviewMapVisible(true);
                }}
                onSelectTimeSeries={async ({ scenes, token: tsToken, type }) => {
                  addStatusLog('info', `Loading time series: ${scenes.length} scenes`);
                  setLoading(true);
                  setError(null);
                  try {
                    const fetchHeaders = tsToken ? { 'Authorization': `Bearer ${tsToken}` } : undefined;
                    const urls = scenes.map(s => s.url);

                    // Load first scene fully to get datasets and viewer state
                    const firstScene = scenes[0];
                    await handleRemoteFileSelect({
                      url: firstScene.url,
                      name: `${scenes.length}-scene time series (${firstScene.name})`,
                      size: 0,
                      type: type || 'nisar',
                      token: tsToken,
                    });

                    addStatusLog('success', `Time series initialized with ${scenes.length} scenes`,
                      scenes.map(s => {
                        const date = s.datetime ? new Date(s.datetime).toISOString().slice(0, 10) : '?';
                        return `${date}: ${s.name.slice(-30)}`;
                      }).join('\n'));

                    // Store the full scene list for later ROI-based time series extraction
                    // (loadNISARTimeSeriesROI can be called once user defines an ROI)
                    handleRemoteFileSelect._timeSeriesScenes = scenes;
                    handleRemoteFileSelect._timeSeriesToken = tsToken;
                  } catch (e) {
                    setError(`Time series load failed: ${e.message}`);
                    addStatusLog('error', 'Time series load failed', e.message);
                  } finally {
                    setLoading(false);
                  }
                }}
                onTokenChange={setEarthdataToken}
                onStatus={addStatusLog}
                onLayersChange={setStacLayers}
                onGranulesChange={setCmrFootprints}
                viewBounds={overviewBounds}
                onZoomToBounds={(bbox) => {
                  const [minX, minY, maxX, maxY] = bbox;
                  setViewCenter([(minX + maxX) / 2, (minY + maxY) / 2]);
                  const span = Math.max(maxX - minX, maxY - minY);
                  setViewZoom(Math.log2(360 / span) - 1);
                }}
              />
            </CollapsibleSection>
          )}

          {/* Shared NISAR Dataset Controls — shown whenever datasets are detected (local or remote) */}
          {nisarDatasets.length > 0 && (
            <CollapsibleSection title="Dataset" defaultOpen={true}>
              {/* Source indicator */}
              <div className="control-group u-hint u-break">
                {nisarFile ? nisarFile.name : remoteName || 'Remote'}
                {nisarFile && ` (${(nisarFile.size / 1e9).toFixed(2)} GB)`}
                {nisarProductType !== 'GCOV' && (
                  <span style={{ marginLeft: '6px', color: 'var(--sardine-cyan)', fontWeight: 600 }}>
                    {nisarProductType}
                  </span>
                )}
              </div>

              <Field label="Frequency" className="control-group">
                <select
                  value={selectedFrequency}
                  onChange={(e) => {
                    setSelectedFrequency(e.target.value);
                    const freqDs = nisarDatasets.filter(d => d.frequency === e.target.value);
                    if (freqDs.length > 0) {
                      setSelectedPolarization(freqDs[0].polarization);
                      if (nisarProductType === 'GUNW') {
                        setSelectedLayer(freqDs[0].layer);
                        setSelectedGunwDataset(freqDs[0].dataset);
                      }
                      // Update contrast from metadata stats for the new frequency
                      const ds = freqDs[0];
                      if (ds?.stats?.mean_value > 0 && ds?.stats?.sample_stddev > 0) {
                        const meanDb = toDb(ds.stats.mean_value, 0);
                        const stdDb = Math.abs(toDb(ds.stats.sample_stddev / ds.stats.mean_value, 0));
                        setContrastMin(Math.round(meanDb - 2 * stdDb));
                        setContrastMax(Math.round(meanDb + 2 * stdDb));
                      }
                    }
                  }}
                >
                  {[...new Set(nisarDatasets.map(d => d.frequency))].map(f => (
                    <option key={f} value={f}>Frequency {f}</option>
                  ))}
                </select>
              </Field>

              {/* GUNW-specific: Layer group selector */}
              {nisarProductType === 'GUNW' && (
                <Field label="Layer" className="control-group">
                  <select
                    value={selectedLayer}
                    onChange={(e) => {
                      setSelectedLayer(e.target.value);
                      // Auto-select first dataset + polarization in the new layer
                      const layerDs = nisarDatasets.filter(d =>
                        d.frequency === selectedFrequency && d.layer === e.target.value
                      );
                      if (layerDs.length > 0) {
                        setSelectedPolarization(layerDs[0].polarization);
                        setSelectedGunwDataset(layerDs[0].dataset);
                      }
                    }}
                  >
                    {[...new Set(nisarDatasets
                      .filter(d => d.frequency === selectedFrequency)
                      .map(d => d.layer)
                    )].map(l => (
                      <option key={l} value={l}>
                        {GUNW_LAYER_LABELS[l] || l}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              {/* GUNW-specific: Dataset selector within layer */}
              {nisarProductType === 'GUNW' && (
                <Field label="Dataset" className="control-group">
                  <select
                    value={selectedGunwDataset}
                    onChange={(e) => setSelectedGunwDataset(e.target.value)}
                  >
                    {[...new Set(nisarDatasets
                      .filter(d =>
                        d.frequency === selectedFrequency &&
                        d.layer === selectedLayer
                      )
                      .map(d => d.dataset)
                    )].map(ds => (
                      <option key={ds} value={ds}>
                        {GUNW_DATASET_LABELS[ds] || ds}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              <Field label="Polarization" className="control-group">
                <select
                  value={selectedPolarization}
                  onChange={(e) => {
                    const pol = e.target.value;
                    setSelectedPolarization(pol);
                    // Update contrast from metadata stats for the new polarization
                    const ds = nisarDatasets.find(d => d.frequency === selectedFrequency && d.polarization === pol);
                    if (ds?.stats?.mean_value > 0 && ds?.stats?.sample_stddev > 0) {
                      const meanDb = toDb(ds.stats.mean_value, 0);
                      const stdDb = Math.abs(toDb(ds.stats.sample_stddev / ds.stats.mean_value, 0));
                      setContrastMin(Math.round(meanDb - 2 * stdDb));
                      setContrastMax(Math.round(meanDb + 2 * stdDb));
                    }
                  }}
                >
                  {[...new Set(nisarDatasets
                    .filter(d => nisarProductType === 'GUNW'
                      ? (d.frequency === selectedFrequency && d.layer === selectedLayer)
                      : d.frequency === selectedFrequency
                    )
                    .map(d => d.polarization)
                  )].map(pol => (
                    <option key={pol} value={pol}>
                      {pol}
                    </option>
                  ))}
                </select>
              </Field>

              {/* Display mode — single band, RGB composite (GCOV only), or multi-temporal */}
              <Field label="Display Mode" className="control-group">
                <select
                  value={displayMode}
                  onChange={(e) => setDisplayMode(e.target.value)}
                >
                  <option value="single">Single Band</option>
                  {nisarProductType === 'GCOV' && (
                    <option value="rgb" disabled={availableComposites.length === 0}>
                      RGB Composite
                    </option>
                  )}
                  {nisarProductType === 'GCOV' && (
                    <option value="index" disabled={availableIndices.length === 0}>
                      Index (RVI)
                    </option>
                  )}
                  <option value="multi-temporal">Multi-temporal RGB (3 dates)</option>
                </select>
              </Field>

              {displayMode === 'index' && availableIndices.length > 0 && nisarProductType === 'GCOV' && (
                <div className="control-group">
                  <label>Index</label>
                  <select
                    value={indexId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setIndexId(id);
                      const match = availableIndices.find(i => i.id === id);
                      if (match) setIndexForm(match.form);
                    }}
                  >
                    {availableIndices.map(i => (
                      <option key={i.id} value={i.id}>{i.name}</option>
                    ))}
                  </select>
                  <div className="u-note u-mt-2xs">
                    {availableIndices.find(i => i.id === indexId)?.description || ''}
                    {' · '}
                    {indexForm === 'quad' ? 'quad-pol form' : 'dual-pol form'}
                  </div>
                </div>
              )}

              {displayMode === 'rgb' && availableComposites.length > 0 && nisarProductType === 'GCOV' && (
                <div className="control-group">
                  <label>Composite</label>
                  <select
                    value={compositeId || ''}
                    onChange={(e) => setCompositeId(e.target.value)}
                  >
                    {availableComposites.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <div className="u-note u-mt-2xs">
                    {availableComposites.find(c => c.id === compositeId)?.description || ''}
                  </div>
                </div>
              )}

              {/* Multi-temporal RGB: file pickers for Green and Blue acquisitions */}
              {displayMode === 'multi-temporal' && (
                <div className="control-group">
                  <label style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                    File 1 (R) — already selected above
                  </label>
                  {/* File 2 → Green */}
                  <div className="u-mt-sm">
                    <label className="u-sm">File 2 (G)</label>
                    <input
                      type="file"
                      accept=".h5,.hdf5,.he5"
                      id="nisar-file2-input" className="u-hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setNisarFile2(f);
                      }}
                    />
                    <button
                      className="btn-secondary u-full u-mt-2xs"
                      onClick={() => document.getElementById('nisar-file2-input').click()}
                      
                    >
                      {nisarFile2 ? nisarFile2.name.slice(0, 30) + (nisarFile2.name.length > 30 ? '…' : '') : 'Choose File 2...'}
                    </button>
                  </div>
                  {/* File 3 → Blue */}
                  <div className="u-mt-sm">
                    <label className="u-sm">File 3 (B)</label>
                    <input
                      type="file"
                      accept=".h5,.hdf5,.he5"
                      id="nisar-file3-input" className="u-hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setNisarFile3(f);
                      }}
                    />
                    <button
                      className="btn-secondary u-full u-mt-2xs"
                      onClick={() => document.getElementById('nisar-file3-input').click()}
                      
                    >
                      {nisarFile3 ? nisarFile3.name.slice(0, 30) + (nisarFile3.name.length > 30 ? '…' : '') : 'Choose File 3...'}
                    </button>
                  </div>
                  <div className="u-hint u-mt-xs">
                    {nisarProductType === 'GUNW'
                      ? `Same ${selectedLayer}/${selectedGunwDataset} (${selectedPolarization}) loaded from each file.`
                      : `Same ${selectedFrequency}/${selectedPolarization} dataset loaded from each file.`}
                  </div>
                </div>
              )}

              {/* GUNW-specific: Coherence mask toggle */}
              {nisarProductType === 'GUNW' && selectedGunwDataset !== 'coherenceMagnitude' && (
                <div className="control-group">
                  <div className="control-row">
                    <input
                      type="checkbox"
                      id="cohMask"
                      checked={useCoherenceMask}
                      onChange={(e) => setUseCoherenceMask(e.target.checked)}
                    />
                    <label htmlFor="cohMask">Coherence Mask</label>
                  </div>
                  {useCoherenceMask && (
                    <>
                      <div className="u-between u-mt-xs">
                        <span className="u-note">Threshold</span>
                        <span className="value-display">{coherenceThreshold.toFixed(2)}</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={coherenceThreshold}
                        onChange={(e) => setCoherenceThreshold(Number(e.target.value))}
                      />
                    </>
                  )}
                </div>
              )}

              <div className="u-row">
                <button
                  onClick={remoteUrl ? handleLoadRemoteNISAR : handleLoadNISAR}
                  disabled={loading} className="u-flex1">
                  {loading ? 'Loading...' : displayMode === 'rgb' ? 'Load RGB Composite' : displayMode === 'multi-temporal' ? 'Load Multi-temporal RGB' : 'Load Dataset'}
                </button>

                {/* GUNW paired view: phase + coherence side-by-side */}
                {nisarProductType === 'GUNW' && (
                  <button
                    className="btn-secondary"
                    disabled={loading}
                    style={{ fontSize: 'var(--text-xs)', padding: '4px 8px', whiteSpace: 'nowrap' }}
                    title="Load unwrapped phase + coherence side-by-side"
                    onClick={async () => {
                      setLoading(true);
                      try {
                        const reader = gunwDatasets?._streamReader || null;
                        const opts = { frequency: selectedFrequency, polarization: selectedPolarization, band: nisarFile ? undefined : 'LSAR' };

                        // Load phase
                        const phase = await loadNISARGUNW(nisarFile, {
                          ...opts, layer: 'unwrappedInterferogram', dataset: 'unwrappedPhase', _streamReader: reader,
                        });
                        // Load coherence
                        const coh = await loadNISARGUNW(nisarFile, {
                          ...opts, layer: 'unwrappedInterferogram', dataset: 'coherenceMagnitude', _streamReader: reader,
                        });

                        const phaseRm = phase.renderMode || {};
                        const cohRm = coh.renderMode || {};
                        setGunwPairedView({
                          left: {
                            getTile: phase.getTile, bounds: phase.bounds,
                            contrastLimits: phaseRm.defaultRange || [-Math.PI, Math.PI],
                            useDecibels: false, colormap: phaseRm.colormap || 'twilight',
                          },
                          right: {
                            getTile: coh.getTile, bounds: coh.bounds,
                            contrastLimits: cohRm.defaultRange || [0, 1],
                            useDecibels: false, colormap: cohRm.colormap || 'viridis',
                          },
                        });
                        addStatusLog('success', 'Paired view loaded: Phase + Coherence');
                      } catch (e) {
                        addStatusLog('error', 'Failed to load paired view', e.message);
                      } finally {
                        setLoading(false);
                      }
                    }}
                  >
                    Paired
                  </button>
                )}
              </div>
            </CollapsibleSection>
          )}

          {/* Multi-band COG picker — unified with NITF/NISAR via DatasetPicker.
              Auto-hides for single-band TIFs (the typical SAR case). */}
          {fileType === 'local-tif' && cogDatasets.length > 1 && (
            <CollapsibleSection title="COG Bands" defaultOpen={true}>
              <DatasetPicker
                datasets={cogDatasets}
                mode="single"
                selectedId={selectedCogId}
                onSelect={handleSelectCogDataset}
                showRGBToggle={false}
              />
            </CollapsibleSection>
          )}

          {/* NITF dataset picker — unified across single + multi-image NITF.
              Auto-hides when there's only one image segment (typical case). */}
          {fileType === 'nitf' && nitfDatasets.length > 1 && (
            <CollapsibleSection title="NITF Image Segments" defaultOpen={true}>
              <div className="control-group u-hint u-break">
                {nitfFile?.name}
                {nitfFile && ` (${(nitfFile.size / 1e9).toFixed(2)} GB)`}
              </div>
              <DatasetPicker
                datasets={nitfDatasets}
                mode="single"
                selectedId={selectedNitfId}
                onSelect={handleSelectNitfDataset}
                showRGBToggle={false}
              />
            </CollapsibleSection>
          )}

          {/* Current Session Status */}
          </>)}

          {/* Scene status card — pinned above every panel group */}
          {imageData && (
            <div style={{
              background: 'var(--sardine-bg-raised)',
              border: '1px solid var(--sardine-border)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-md)',
              marginBottom: 'var(--space-md)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-md)',
            }}>
              <div style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: loading ? 'var(--sardine-cyan)' : 'var(--status-success)',
                boxShadow: loading ? '0 0 6px var(--sardine-cyan)' : '0 0 6px var(--sardine-green-glow)',
                animation: loading ? 'pulse 2s infinite' : 'none',
                flexShrink: 0,
              }} />
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-sm)',
                fontWeight: 600,
                letterSpacing: '1px',
                textTransform: 'uppercase',
                color: 'var(--text-secondary)',
                flex: 1,
              }}>
                {loading ? 'Processing' : 'Data Loaded'}
              </div>
              <button
                onClick={handleReload}
                disabled={loading}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--sardine-cyan)',
                  background: 'var(--sardine-cyan-bg)',
                  border: '1px solid var(--sardine-cyan-dim)',
                  padding: '4px 12px',
                  borderRadius: 'var(--radius-sm)',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  transition: 'all var(--transition-fast)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  opacity: loading ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!loading) {
                    e.target.style.background = 'var(--sardine-cyan)';
                    e.target.style.color = 'var(--sardine-bg)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!loading) {
                    e.target.style.background = 'var(--sardine-cyan-bg)';
                    e.target.style.color = 'var(--sardine-cyan)';
                  }
                }}
              >
                {loading ? '⟳ Reloading...' : '⟳ Reload'}
              </button>
              <button
                onClick={fitToBounds}
                disabled={!imageData?.bounds}
                title="Reset view to image bounds"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-muted)',
                  background: 'var(--surface-alt)',
                  border: '1px solid var(--sardine-border)',
                  padding: '4px 12px',
                  borderRadius: 'var(--radius-sm)',
                  cursor: imageData?.bounds ? 'pointer' : 'not-allowed',
                  transition: 'all var(--transition-fast)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  opacity: imageData?.bounds ? 1 : 0.5,
                }}
                onMouseEnter={(e) => {
                  if (imageData?.bounds) {
                    e.target.style.background = 'var(--sardine-cyan-bg)';
                    e.target.style.color = 'var(--sardine-cyan)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (imageData?.bounds) {
                    e.target.style.background = 'var(--surface-alt)';
                    e.target.style.color = 'var(--text-muted)';
                  }
                }}
              >
                ⊞ Fit View
              </button>
            </div>
          )}

          {activePanel === 'layers' && (<>
          {/* Overture Maps Overlay */}
          <CollapsibleSection title="Overture Maps" defaultOpen={false}>
            <div className="control-group">
              <div className="control-row">
                <input
                  type="checkbox"
                  id="overtureEnabled"
                  checked={overtureEnabled}
                  onChange={(e) => {
                    setOvertureEnabled(e.target.checked);
                    if (!e.target.checked) setOvertureData(null);
                    addStatusLog('info', e.target.checked
                      ? 'Overture Maps overlay enabled'
                      : 'Overture Maps overlay disabled');
                  }}
                />
                <label htmlFor="overtureEnabled">
                  Enable Overlay
                  {overtureLoading && <span className="u-accent u-ml-sm">⟳</span>}
                </label>
              </div>
            </div>

            {overtureEnabled && (
              <>
                <div className="control-group">
                  <label>Themes</label>
                  {Object.entries(OVERTURE_THEMES).map(([key, theme]) => (
                    <div className="control-row" key={key}>
                      <input
                        type="checkbox"
                        id={`overture-${key}`}
                        checked={overtureThemes.includes(key)}
                        onChange={(e) => {
                          setOvertureThemes(prev =>
                            e.target.checked
                              ? [...prev, key]
                              : prev.filter(t => t !== key)
                          );
                        }}
                      />
                      <label htmlFor={`overture-${key}`}>
                        <span style={{
                          display: 'inline-block',
                          width: '10px',
                          height: '10px',
                          borderRadius: '2px',
                          backgroundColor: `rgba(${(theme.color || theme.lineColor || [150,150,150,200]).join(',')})`,
                          marginRight: '6px',
                          verticalAlign: 'middle',
                        }} />
                        {theme.label}
                      </label>
                    </div>
                  ))}
                </div>

                <div className="control-group">
                  <div className="u-between">
                    <label>Opacity</label>
                    <span className="value-display">{(overtureOpacity * 100).toFixed(0)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={overtureOpacity}
                    onChange={(e) => setOvertureOpacity(Number(e.target.value))}
                  />
                </div>

                {overtureData && (
                  <div className="u-note">
                    {Object.entries(overtureData).map(([key, fc]) => (
                      <div key={key}>{OVERTURE_THEMES[key]?.label}: {fc.features?.length || 0} features</div>
                    ))}
                  </div>
                )}
              </>
            )}
          </CollapsibleSection>

          {/* Optical Peek — WMTS raster reprojected into image CRS via GPU warp grid */}
          <CollapsibleSection title="Optical Peek" defaultOpen={false}>
            <div className="control-group">
              <div className="control-row">
                <input
                  type="checkbox"
                  id="opticalPeekEnabled"
                  checked={opticalPeekEnabled}
                  onChange={(e) => {
                    setOpticalPeekEnabled(e.target.checked);
                    addStatusLog('info', e.target.checked
                      ? `Optical peek enabled (${opticalPeekProvider})`
                      : 'Optical peek disabled');
                  }}
                />
                <label htmlFor="opticalPeekEnabled">Enable Overlay</label>
              </div>
            </div>

            {opticalPeekEnabled && (
              <>
                <Field label="Source" className="control-group">
                  <select
                    value={opticalPeekProvider}
                    onChange={(e) => setOpticalPeekProvider(e.target.value)}
                  >
                    <option value="esri">Esri World Imagery</option>
                    <option value="osm">OpenStreetMap</option>
                  </select>
                </Field>
                <div className="control-group">
                  <label>Opacity: {opticalPeekOpacity.toFixed(2)}</label>
                  <input
                    type="range" min="0" max="1" step="0.05"
                    value={opticalPeekOpacity}
                    onChange={(e) => setOpticalPeekOpacity(parseFloat(e.target.value))}
                  />
                </div>
              </>
            )}
          </CollapsibleSection>

          </>)}

          {/* Display Settings */}
          {activePanel === 'display' && (
          <CollapsibleSection title="Display">

            <Field label="UI Theme" className="control-group">
              <select value={uiTheme} onChange={(e) => setUiTheme(e.target.value)}>
                <option value="">Dark</option>
                <option value="sardine">SARdine (navy)</option>
                <option value="light">Light</option>
              </select>
            </Field>

            {/* Colormap selector — hidden in RGB composite mode */}
            {sidebarDisplayMode !== 'rgb' && (
              <div className="control-group">
                <label>Colormap</label>
                <select value={colormap} onChange={(e) => setColormap(e.target.value)}>
                  <optgroup label="Sequential (perceptually uniform)">
                    <option value="grayscale">Grayscale</option>
                    <option value="sardine">SARdine (cubehelix, SAR-tuned)</option>
                    <option value="viridis">Viridis</option>
                    <option value="inferno">Inferno</option>
                    <option value="plasma">Plasma</option>
                    <option value="magma">Magma</option>
                    <option value="cividis">Cividis (CVD-safe)</option>
                    <option value="batlow">Batlow (Crameri)</option>
                  </optgroup>
                  <optgroup label="Sequential (high-contrast / domain)">
                    <option value="turbo">Turbo (jet replacement)</option>
                    <option value="coherence">Coherence</option>
                    <option value="flood">Flood Alert</option>
                  </optgroup>
                  <optgroup label="Diverging">
                    <option value="rdbu">RdBu (InSAR displacement)</option>
                    <option value="diverging">Diverging</option>
                    <option value="polarimetric">Polarimetric</option>
                  </optgroup>
                  <optgroup label="Cyclic (wrapped phase)">
                    <option value="romaO">romaO (Crameri)</option>
                    <option value="twilight">Twilight</option>
                    <option value="phase">Phase (HSV)</option>
                  </optgroup>
                  <optgroup label="Categorical">
                    <option value="label">Label</option>
                  </optgroup>
                </select>
                <div className="control-row u-mt-xs">
                  <input
                    type="checkbox"
                    id="reverseColormap"
                    checked={reverseColormap}
                    disabled={colormap === 'label'}
                    onChange={(e) => setReverseColormap(e.target.checked)}
                  />
                  <label htmlFor="reverseColormap">Reverse</label>
                </div>
              </div>
            )}

            <div className="control-group">
              <div className="control-row">
                <input
                  type="checkbox"
                  id="useDb"
                  checked={effectiveUseDecibels}
                  disabled={nisarProductType === 'GUNW' || displayMode === 'index'}
                  onChange={(e) => setUseDecibels(e.target.checked)}
                />
                <label htmlFor="useDb">dB Scaling{(nisarProductType === 'GUNW' || displayMode === 'index') ? ' (N/A)' : ''}</label>
              </div>
            </div>

            <div className="control-group">
              <div className="control-row">
                <input
                  type="checkbox"
                  id="showGrid"
                  checked={showGrid}
                  onChange={(e) => setShowGrid(e.target.checked)}
                />
                <label htmlFor="showGrid">Coordinate Grid</label>
              </div>
              <div className="control-row">
                <input
                  type="checkbox"
                  id="pixelExplorer"
                  checked={pixelExplorer}
                  onChange={(e) => setPixelExplorer(e.target.checked)}
                />
                <label htmlFor="pixelExplorer">Pixel Explorer</label>
                {pixelExplorer && (
                  <select
                    value={pixelWindowSize}
                    onChange={(e) => setPixelWindowSize(Number(e.target.value))}
                    style={{ marginLeft: '8px', fontSize: 'var(--text-sm)', width: '55px' }}
                    title="Averaging window size around cursor"
                  >
                    <option value={1}>1×1</option>
                    <option value={3}>3×3</option>
                    <option value={5}>5×5</option>
                    <option value={7}>7×7</option>
                    <option value={11}>11×11</option>
                  </select>
                )}
              </div>
            </div>

          </CollapsibleSection>
          )}

          {/* Export settings */}
          {activePanel === 'export' && imageData?.getExportStripe && (
          <CollapsibleSection title="Export Settings">
            {imageData && imageData.getExportStripe && (
              <div className="control-group">
                <label className="u-sm u-mb-xs">
                  Multilook Window (Export)
                </label>
                <div style={{ display: 'flex', gap: '4px', marginBottom: '4px' }}>
                  {[1, 2, 4, 8, 16].map(size => (
                    <button
                      key={size}
                      className={exportMultilookWindow === size ? '' : 'btn-secondary'}
                      style={{ flex: 1, fontSize: 'var(--text-sm)', padding: '3px 6px' }}
                      onClick={() => setExportMultilookWindow(size)}
                      title={size === 1 ? 'No multilook (full resolution)' : `${size}×${size} averaging window`}
                    >
                      {size === 1 ? 'None' : `${size}×${size}`}
                    </button>
                  ))}
                </div>
                {imageData.pixelSpacing && (
                  <div className="u-hint u-mt-2xs">
                    Source: {imageData.pixelSpacing.x?.toFixed(1)}m × {imageData.pixelSpacing.y?.toFixed(1)}m posting
                    {exportMultilookWindow > 1 && ` → ${(imageData.pixelSpacing.x * exportMultilookWindow).toFixed(1)}m export`}
                  </div>
                )}
              </div>
            )}

            {/* Export mode toggle */}
            {imageData && imageData.getExportStripe && (
              <div className="control-group u-mt-md">
                <label className="u-sm u-mb-xs">
                  Export Data
                </label>
                <div className="u-row">
                  {[
                    { id: 'raw', label: 'Raw', desc: 'Float32 linear power — for analysis (QGIS, Python)' },
                    { id: 'rendered', label: 'Displayed', desc: 'RGBA with current dB/contrast/colormap — as seen on screen' },
                  ].map(mode => (
                    <button
                      key={mode.id}
                      className={exportMode === mode.id ? '' : 'btn-secondary'}
                      style={{ flex: 1, fontSize: 'var(--text-sm)', padding: '3px 6px' }}
                      onClick={() => setExportMode(mode.id)}
                      title={mode.desc}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
                <div className="u-hint u-mt-2xs">
                  {exportMode === 'raw'
                    ? 'Float32 linear power values — suitable for analysis'
                    : `RGBA with ${effectiveUseDecibels ? 'dB' : 'linear'} stretch, ${colormap} colormap`}
                </div>
              </div>
            )}

          </CollapsibleSection>
          )}

          {/* ROI (Region of Interest) info */}
          {activePanel === 'analysis' && imageData && (
          <CollapsibleSection title="Region of Interest">
            {imageData && (
              <div className="u-sm">
                {roi ? (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: 'rgba(255, 200, 50, 0.08)',
                    border: '1px solid rgba(255, 200, 50, 0.3)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '4px 8px',
                  }}>
                    <span style={{ color: 'var(--status-dry)' }}>
                      ROI: {roi.width} × {roi.height} px
                    </span>
                    <div className="u-row">
                      <button
                        onClick={() => setClassifierOpen(prev => !prev)}
                        title="Feature space classifier (C)"
                        style={{
                          background: classifierOpen ? 'rgba(78,201,212,0.15)' : 'none',
                          border: classifierOpen ? '1px solid rgba(78,201,212,0.4)' : '1px solid transparent',
                          color: classifierOpen ? '#4ec9d4' : 'var(--text-muted)',
                          cursor: 'pointer', padding: '0 4px', fontSize: 'var(--text-xs)', borderRadius: 3,
                        }}
                      >
                        Classify
                      </button>
                      <button
                        onClick={() => setROI(null)}
                        style={{
                          background: 'none', border: 'none', color: 'var(--text-muted)',
                          cursor: 'pointer', padding: '0 2px', fontSize: 'var(--text-sm)',
                        }}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                    Shift+drag on image to select ROI for export
                  </div>
                )}

                {/* Load RGB Composite into ROI */}
                {roi && (nisarFile || remoteUrl) && availableComposites.length > 0 && displayMode === 'single' && (
                  <div style={{
                    marginTop: '4px', padding: '4px 8px',
                    background: 'rgba(78, 201, 212, 0.06)',
                    border: '1px solid rgba(78, 201, 212, 0.2)',
                    borderRadius: 'var(--radius-sm)',
                  }}>
                    <div className="u-row">
                      <select
                        value={roiCompositeId || ''}
                        onChange={(e) => setRoiCompositeId(e.target.value || null)}
                        style={{
                          flex: 1, fontSize: 'var(--text-xs)',
                          background: 'var(--surface-2)', color: 'var(--ink)',
                          border: '1px solid var(--sardine-border)',
                          borderRadius: 'var(--radius-sm)', padding: '2px 4px',
                        }}
                      >
                        <option value="">Select composite...</option>
                        {availableComposites.map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      <button
                        onClick={handleLoadRoiRGB}
                        disabled={!roiCompositeId || roiRGBLoading}
                        style={{
                          fontSize: 'var(--text-xs)', padding: '3px 8px',
                          background: roiCompositeId ? 'rgba(78, 201, 212, 0.15)' : 'transparent',
                          border: '1px solid rgba(78, 201, 212, 0.3)',
                          color: 'var(--sardine-cyan)', borderRadius: 'var(--radius-sm)',
                          cursor: roiCompositeId ? 'pointer' : 'default',
                          opacity: roiCompositeId ? 1 : 0.4,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {roiRGBLoading ? 'Loading...' : 'RGB in ROI'}
                      </button>
                    </div>
                    {roiRGBData && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--sardine-cyan)', marginTop: '2px' }}>
                        RGB overlay active ({roiCompositeId})
                      </div>
                    )}
                  </div>
                )}

                {/* Time-Series file input for ROI */}
                {roi && nisarFile && (
                  <div style={{
                    marginTop: '4px', padding: '4px 8px',
                    background: 'rgba(46, 204, 113, 0.06)',
                    border: '1px solid rgba(46, 204, 113, 0.2)',
                    borderRadius: 'var(--radius-sm)',
                  }}>
                    <div className="u-row">
                      <label style={{
                        flex: 1, fontSize: 'var(--text-xs)', cursor: 'pointer',
                        color: 'var(--text-muted)',
                      }}>
                        <input
                          type="file"
                          multiple
                          accept=".h5,.hdf5" className="u-hidden"
                          onChange={(e) => setRoiTSFiles(Array.from(e.target.files || []))}
                        />
                        {roiTSFiles.length > 0
                          ? `${roiTSFiles.length} file${roiTSFiles.length > 1 ? "s" : ""} selected`
                          : 'Select .h5 files...'}
                      </label>
                      <button
                        onClick={handleLoadRoiTimeSeries}
                        disabled={!roiTSFiles.length || roiTSLoading}
                        style={{
                          fontSize: 'var(--text-xs)', padding: '3px 8px',
                          background: roiTSFiles.length ? 'rgba(46, 204, 113, 0.15)' : 'transparent',
                          border: '1px solid rgba(46, 204, 113, 0.3)',
                          color: 'var(--status-success)', borderRadius: 'var(--radius-sm)',
                          cursor: roiTSFiles.length ? 'pointer' : 'default',
                          opacity: roiTSFiles.length ? 1 : 0.4,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {roiTSLoading ? 'Loading...' : 'Time Series'}
                      </button>
                    </div>
                    {roiTSFrames && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--status-success)', marginTop: '2px' }}>
                        {roiTSFrames.length} frames loaded
                      </div>
                    )}
                  </div>
                )}

                {/* WKT ROI Input */}
                <div className="u-mt-xs">
                  <div className="u-row">
                    <input
                      type="text"
                      value={wktInput}
                      onChange={(e) => { setWktInput(e.target.value); setWktError(null); }}
                      onKeyDown={(e) => e.key === 'Enter' && handleWktApply()}
                      placeholder="BBOX(west, south, east, north) or POLYGON(...)"
                      style={{
                        flex: 1, fontSize: 'var(--text-xs)',
                        background: 'var(--surface-2)', color: 'var(--ink)',
                        border: wktError ? '1px solid var(--sardine-red)' : '1px solid var(--sardine-border)',
                        borderRadius: 'var(--radius-sm)', padding: '3px 6px',
                        fontFamily: "'JetBrains Mono', monospace",
                      }}
                    />
                    <button
                      onClick={handleWktApply}
                      disabled={!wktInput.trim()}
                      style={{
                        fontSize: 'var(--text-xs)', padding: '3px 8px',
                        background: wktInput.trim() ? 'rgba(255, 200, 50, 0.15)' : 'transparent',
                        border: '1px solid rgba(255, 200, 50, 0.3)',
                        color: 'var(--status-dry)', borderRadius: 'var(--radius-sm)',
                        cursor: wktInput.trim() ? 'pointer' : 'default',
                        opacity: wktInput.trim() ? 1 : 0.4,
                      }}
                    >
                      Apply
                    </button>
                  </div>
                  {wktError && (
                    <div style={{ color: 'var(--sardine-red)', fontSize: 'var(--text-xs)', marginTop: '2px' }}>
                      {wktError}
                    </div>
                  )}
                </div>
              </div>
            )}

          </CollapsibleSection>
          )}

          {/* Export buttons */}
          {activePanel === 'export' && (imageData || compareMode) && (
          <CollapsibleSection title="Export">
            {(imageData || compareMode) && (
              <div>
                <div className="u-row-sm">
                {imageData?.getExportStripe && (
                  <button
                    onClick={handleExportGeoTIFF}
                    disabled={exporting} className="u-flex1">
                    {exporting
                      ? `Exporting... ${exportProgress}%`
                      : `Export ${roi ? 'ROI ' : ''}GeoTIFF (${exportMode === 'raw' ? 'Float32' : 'Rendered'})`}
                  </button>
                )}
                {/* Save Figure — PNG (flattened) or SVG (embedded raster base
                    + editable vector chrome for Illustrator/Inkscape). */}
                <div style={{ flex: 1, display: 'flex' }}>
                  <button
                    onClick={() => (roi && !compareMode ? handleSaveFigureWithOverlays('png') : handleSaveFigure('png'))}
                    title={compareMode ? 'Save the compare grid as a stitched PNG figure' : 'Save figure as a flattened PNG'}
                    style={{ flex: 1, borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                  >
                    Save Figure (PNG)
                  </button>
                  <button
                    onClick={() => (roi && !compareMode ? handleSaveFigureWithOverlays('svg') : handleSaveFigure('svg'))}
                    title="Save figure as SVG — SAR image embedded, chrome (scale bar, labels, legend, grid) editable vector"
                    style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: 'none', paddingLeft: '10px', paddingRight: '10px' }}
                  >
                    SVG
                  </button>
                </div>
                {imageData && (
                <button
                  onClick={handleSaveFigureGeoTIFF}
                  title="Save current viewport as georeferenced GeoTIFF" className="u-flex1">
                  Save Figure (GeoTIFF)
                </button>
                )}
                </div>
                {exporting && (
                  <div className="progress-track u-mt-sm">
                    <div className="progress-fill" style={{ width: `${exportProgress}%`, transition: 'width 0.3s ease' }} />
                  </div>
                )}
                {/* Figure style — publication (light) vs presentation (dark). */}
                <div className="control-group u-mt-md">
                  <div className="control-row u-between">
                    <label className="u-note-2" title="Publication = light, open, editorial (Nature/RSE house style). Presentation = dark, for slides/projector.">
                      Figure style
                    </label>
                    <div className="u-row">
                      {[['publication', 'Publication'], ['dark', 'Presentation']].map(([val, lbl], i) => (
                        <button
                          key={val}
                          onClick={() => { setFigureTheme(val); try { localStorage.setItem('sardine.figureTheme', val); } catch {} }}
                          className={figureTheme === val ? '' : 'btn-secondary'}
                          style={{
                            fontSize: 'var(--text-xs)', padding: '3px 10px',
                            borderTopLeftRadius: i === 0 ? undefined : 0, borderBottomLeftRadius: i === 0 ? undefined : 0,
                            borderTopRightRadius: i === 0 ? 0 : undefined, borderBottomRightRadius: i === 0 ? 0 : undefined,
                            borderLeft: i === 0 ? undefined : 'none',
                            fontWeight: figureTheme === val ? 600 : 400,
                          }}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {/* Figure coordinate grid — full gridlines, edge ticks only, or none. */}
                <div className="control-group u-mt-sm">
                  <div className="control-row u-between">
                    <label className="u-note-2" title="Coordinate grid on exported figures: full gridlines, edge ticks + labels only, or off.">
                      Figure grid
                    </label>
                    <div className="u-row">
                      {[['lines', 'Lines'], ['ticks', 'Ticks'], ['off', 'Off']].map(([val, lbl], i, arr) => (
                        <button
                          key={val}
                          onClick={() => { setFigureGridMode(val); try { localStorage.setItem('sardine.figureGrid', val); } catch {} }}
                          className={figureGridMode === val ? '' : 'btn-secondary'}
                          style={{
                            fontSize: 'var(--text-xs)', padding: '3px 10px',
                            borderTopLeftRadius: i === 0 ? undefined : 0, borderBottomLeftRadius: i === 0 ? undefined : 0,
                            borderTopRightRadius: i === arr.length - 1 ? undefined : 0, borderBottomRightRadius: i === arr.length - 1 ? undefined : 0,
                            borderLeft: i === 0 ? undefined : 'none',
                            fontWeight: figureGridMode === val ? 600 : 400,
                          }}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {/* Colorbar caption — always editable; empty falls back to dB/linear. */}
                <div className="control-group u-mt-sm">
                  <div className="control-row u-between">
                    <label htmlFor="colorbarLabel" className="u-note-2" title="Caption drawn along the figure colorbar. Leave empty for automatic 'dB' / 'linear'.">
                      Colorbar label
                    </label>
                    <input
                      id="colorbarLabel"
                      type="text"
                      value={colorbarLabel}
                      placeholder="auto (dB / linear)"
                      onChange={(e) => { setColorbarLabel(e.target.value); try { localStorage.setItem('sardine.colorbarLabel', e.target.value); } catch {} }}
                      onKeyDown={(e) => e.stopPropagation()}
                      style={{ width: '55%', fontSize: 'var(--text-sm)', padding: '3px 6px' }}
                    />
                  </div>
                </div>
                {/* Attribution stamps the single-scene export; compare-grid
                    panels don't carry it. */}
                {imageData && (
                <div className="control-group u-mt-sm">
                  <div className="control-row">
                    <input
                      type="checkbox"
                      id="attributionEnabled"
                      checked={attributionEnabled}
                      onChange={(e) => setAttributionEnabled(e.target.checked)}
                    />
                    <label htmlFor="attributionEnabled" title="Stamp vendor copyright + CSDA + 'Processed by Nick Steiner' onto the PNG">
                      Add attribution to PNG
                    </label>
                  </div>
                  {attributionEnabled && (() => {
                    const src = (fileType === 'nisar' || fileType === 'nisar-gunw') ? nisarFile?.name : cogUrl;
                    const detected = detectVendor(src);
                    const effective = attributionVendor || detected || '';
                    return (
                      <select
                        value={attributionVendor}
                        onChange={(e) => {
                          setAttributionVendor(e.target.value);
                          try { localStorage.setItem('sardine.attribution.vendor', e.target.value); } catch {}
                        }}
                        title={detected ? `Auto-detected from filename: ${detected}` : 'Pick the sensor that acquired this scene'}
                        style={{
                          width: '100%',
                          marginTop: '4px',
                          padding: '4px 6px',
                          fontSize: 'var(--text-sm)',
                          background: 'var(--sardine-bg-panel)',
                          border: `1px solid ${effective ? 'var(--sardine-cyan, #4ec9d4)' : 'var(--sardine-border, #1e3a5f)'}`,
                          color: 'var(--sardine-text-primary, #e8edf5)',
                          borderRadius: '2px',
                        }}
                      >
                        <option value="">
                          {detected ? `Auto: ${detected}` : 'Sensor (none / generic)'}
                        </option>
                        {VENDOR_OPTIONS.map(({ key, label }) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                    );
                  })()}
                  {attributionEnabled && (
                    <input
                      type="text"
                      placeholder={`Processed by… (default: ${DEFAULT_PROCESSOR})`}
                      value={attributionProcessor}
                      onChange={(e) => {
                        setAttributionProcessor(e.target.value);
                        try { localStorage.setItem('sardine.attribution.processor', e.target.value); } catch {}
                      }}
                      title="Override the 'Processed by' name. Persists across sessions; leave blank to use default."
                      style={{
                        width: '100%',
                        marginTop: '4px',
                        padding: '4px 6px',
                        fontSize: 'var(--text-sm)',
                        background: 'var(--sardine-bg-panel)',
                        border: '1px solid var(--sardine-border)',
                        color: 'var(--sardine-text-primary, #e8edf5)',
                        borderRadius: '2px',
                      }}
                    />
                  )}
                </div>
                )}
              </div>
            )}
          </CollapsibleSection>
          )}

          {/* Annotation toolbar — arrows + text labels baked into PNG export */}
          {activePanel === 'analysis' && imageData && (
          <CollapsibleSection title="Annotate">
                <div className="control-group">
                  <label className="u-note-2">
                    Annotate
                    {annotations.length > 0 && (
                      <span className="u-accent u-ml-sm">· {annotations.length}</span>
                    )}
                  </label>
                  <div className="u-row u-mt-xs">
                    {[
                      { key: 'off',   label: 'Off' },
                      { key: 'arrow', label: 'Arrow' },
                      { key: 'text',  label: 'Text' },
                    ].map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => setAnnotationMode(key)}
                        title={
                          key === 'arrow' ? 'Click tail, click head, type caption (Esc cancels)'
                          : key === 'text' ? 'Click to place a text label'
                          : 'Disable annotation tool (selection still works)'
                        }
                        style={{
                          flex: 1,
                          padding: '4px 6px',
                          fontSize: 'var(--text-sm)',
                          background: annotationMode === key ? 'var(--sardine-cyan-bg, rgba(78,201,212,0.08))' : 'transparent',
                          color: annotationMode === key ? 'var(--sardine-cyan, #4ec9d4)' : 'var(--sardine-text-secondary, #8fa4c4)',
                          border: `1px solid ${annotationMode === key ? 'var(--sardine-cyan, #4ec9d4)' : 'var(--sardine-border, #1e3a5f)'}`,
                          borderRadius: '2px',
                          cursor: 'pointer',
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {/* Size presets — standardized S/M/L (line weight + text scale together) */}
                  <div className="u-row u-mt-xs">
                    {[
                      { key: 'small',  label: 'S' },
                      { key: 'medium', label: 'M' },
                      { key: 'large',  label: 'L' },
                    ].map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => {
                          setAnnotationSize(key);
                          // Retro-apply to the selected annotation so users can resize
                          // an existing arrow/label without redrawing it.
                          if (selectedAnnotationId) {
                            setAnnotations(anns => anns.map(a =>
                              a.id === selectedAnnotationId ? { ...a, size: key, fontSize: undefined } : a
                            ));
                          }
                        }}
                        title={
                          `${key.charAt(0).toUpperCase() + key.slice(1)} — thicker lines & larger text`
                          + (selectedAnnotationId ? ' (also resizes the selected annotation)' : '')
                        }
                        style={{
                          flex: 1,
                          padding: '4px 6px',
                          fontSize: 'var(--text-sm)',
                          fontWeight: 600,
                          background: annotationSize === key ? 'var(--sardine-cyan-bg, rgba(78,201,212,0.08))' : 'transparent',
                          color: annotationSize === key ? 'var(--sardine-cyan, #4ec9d4)' : 'var(--sardine-text-secondary, #8fa4c4)',
                          border: `1px solid ${annotationSize === key ? 'var(--sardine-cyan, #4ec9d4)' : 'var(--sardine-border, #1e3a5f)'}`,
                          borderRadius: '2px',
                          cursor: 'pointer',
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '4px', marginTop: '4px', alignItems: 'center' }}>
                    {ANNOTATION_COLOR_KEYS.map((key) => (
                      <button
                        key={key}
                        onClick={() => setAnnotationColor(key)}
                        title={`Color: ${key}`}
                        style={{
                          width: 18, height: 18,
                          padding: 0,
                          background: ANNOTATION_COLORS[key],
                          border: annotationColor === key
                            ? `2px solid var(--sardine-text-primary, #e8edf5)`
                            : `1px solid var(--sardine-border, #1e3a5f)`,
                          borderRadius: '50%',
                          cursor: 'pointer',
                          boxShadow: annotationColor === key ? `0 0 0 1px ${ANNOTATION_COLORS[key]}` : 'none',
                        }}
                      />
                    ))}
                    <button
                      onClick={() => { setAnnotations([]); setSelectedAnnotationId(null); }}
                      disabled={annotations.length === 0}
                      title="Remove all annotations"
                      style={{
                        marginLeft: 'auto',
                        padding: '2px 8px',
                        fontSize: 'var(--text-xs)',
                        background: 'transparent',
                        color: annotations.length === 0 ? 'var(--sardine-text-disabled, #3a5070)' : 'var(--sardine-text-secondary, #8fa4c4)',
                        border: '1px solid var(--sardine-border, #1e3a5f)',
                        borderRadius: '2px',
                        cursor: annotations.length === 0 ? 'not-allowed' : 'pointer',
                      }}
                    >
                      Clear
                    </button>
                  </div>
                  {/* Markup GeoJSON I/O (W004) — annotations + ROI + class regions */}
                  <div className="u-row u-mt-xs">
                    <button
                      onClick={handleSaveMarkup}
                      disabled={annotations.length === 0 && !roi && classRegions.length === 0}
                      title="Download annotations, ROI, and class regions as GeoJSON"
                      style={{
                        flex: 1,
                        padding: '4px 6px',
                        fontSize: 'var(--text-sm)',
                        background: 'transparent',
                        color: (annotations.length === 0 && !roi && classRegions.length === 0)
                          ? 'var(--sardine-text-disabled, #3a5070)' : 'var(--sardine-text-secondary, #8fa4c4)',
                        border: '1px solid var(--sardine-border, #1e3a5f)',
                        borderRadius: '2px',
                        cursor: (annotations.length === 0 && !roi && classRegions.length === 0) ? 'not-allowed' : 'pointer',
                      }}
                    >
                      Save Markup
                    </button>
                    <button
                      onClick={() => markupFileInputRef.current?.click()}
                      title="Load markup GeoJSON (annotations, ROI, class regions)"
                      style={{
                        flex: 1,
                        padding: '4px 6px',
                        fontSize: 'var(--text-sm)',
                        background: 'transparent',
                        color: 'var(--sardine-text-secondary, #8fa4c4)',
                        border: '1px solid var(--sardine-border, #1e3a5f)',
                        borderRadius: '2px',
                        cursor: 'pointer',
                      }}
                    >
                      Load Markup
                    </button>
                    <input
                      ref={markupFileInputRef}
                      type="file"
                      accept=".geojson,.json" className="u-hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleLoadMarkupFile(f);
                        e.target.value = '';
                      }}
                    />
                  </div>
                </div>
          </CollapsibleSection>
          )}

          {/* Model plugins (W025) — heuristic / ML / ONNX / remote as peers */}
          {activePanel === 'analysis' && (
            <CollapsibleSection title="Models" defaultOpen={true}>
              <ModelPanel
                models={modelList}
                hasData={!!imageData}
                hasRoi={!!roi}
                busyId={modelBusyId}
                progress={modelProgress}
                runInfo={modelRunInfo}
                onRun={handleRunModel}
                onCancel={handleCancelModel}
                overlayActive={!!modelOverlay}
                onClearOverlay={() => setModelOverlay(null)}
                preview={modelPreview}
                canFit={!!classifierData && classRegions.length >= 2}
                fitHint={!roi
                  ? 'Shift+drag an ROI, open the classifier (C), draw ≥2 class regions.'
                  : (!classifierOpen
                    ? 'Open the classifier (C) and draw ≥2 class regions in feature space.'
                    : 'Draw ≥2 class regions in the scatter plot — they become training labels.')}
                liveFit={liveFit}
                onLiveFitChange={setLiveFit}
                onFit={() => fitHeadFromLabels(true)}
                onApplyHead={handleApplyHead}
                onSaveHead={handleSaveHead}
                headManifest={headManifest}
                headMetrics={headMetrics}
                onLoadManifestFile={handleLoadManifestFile}
              />
            </CollapsibleSection>
          )}

          {/* ROI profile plots (toggle views from command palette) */}
          {activePanel === 'analysis' && roi && activeViewer === 'main' && (
            <CollapsibleSection title="ROI Profiles" defaultOpen={true}>
              <ROIProfilePanel
                profileData={roiProfile}
                show={profileShow}
                useDecibels={effectiveUseDecibels}
              />
            </CollapsibleSection>
          )}

          {activePanel === 'export' && isRGBDisplayMode && compositeId && (
              <div style={{ marginTop: '6px', display: 'flex' }}>
                <button
                  onClick={() => handleExportColorbar('png')}
                  className="btn-secondary"
                  title="Export the ternary RGB colorbar as PNG"
                  style={{ flex: 1, fontSize: 'var(--text-sm)', padding: '4px 8px', borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                >
                  Export Colorbar (PNG)
                </button>
                <button
                  onClick={() => handleExportColorbar('svg')}
                  className="btn-secondary"
                  title="Export the colorbar as SVG — triangle embedded, labels and range table editable vector"
                  style={{ fontSize: 'var(--text-sm)', padding: '4px 10px', borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: 'none' }}
                >
                  SVG
                </button>
              </div>
          )}

          {/* Histogram & Contrast */}
          {activePanel === 'display' && (
          <CollapsibleSection title="Contrast">
            {/* Histogram scope toggle — shown when histogram exists, or always in RGB mode so
                user can trigger the first computation via the Viewport/ROI buttons */}
            {(histogramData || (imageData && isRGBDisplayMode)) && (
              <div className="control-group u-mb-sm">
                <div className="u-row">
                  {['global', 'viewport', 'roi'].map(scope => {
                    const hasH5Stats = (imageData?.stats?.mean_value > 0 && imageData?.stats?.sample_stddev > 0)
                      || (isRGBDisplayMode && imageData?.bandStats && Object.keys(imageData.bandStats).length > 0);
                    const label = scope === 'global' ? (hasH5Stats ? 'Metadata' : 'Global') : scope === 'viewport' ? 'Viewport' : 'ROI';
                    const disabled = scope === 'roi' && !roi;
                    return (
                      <button
                        key={scope}
                        className={histogramScope === scope ? '' : 'btn-secondary'}
                        style={{ flex: 1, fontSize: 'var(--text-sm)', padding: '3px 6px', opacity: disabled ? 0.4 : 1 }}
                        disabled={disabled}
                        onClick={() => {
                          if (histogramScope === scope) {
                            // Already active — re-run
                            handleRecomputeHistogram();
                          } else {
                            setHistogramScope(scope);
                          }
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Active viewer indicator when split view */}
            {(roiRGBData || roiTSFrames) && (
              <div className="control-group" style={{ padding: '2px 0' }}>
                <div style={{
                  display: 'flex', gap: '4px', fontSize: 'var(--text-xs)',
                }}>
                  <button
                    onClick={() => setActiveViewer('main')}
                    style={{
                      flex: 1, padding: '3px 6px', borderRadius: 'var(--radius-sm)',
                      background: activeViewer === 'main' ? 'rgba(255, 200, 50, 0.15)' : 'transparent',
                      border: activeViewer === 'main' ? '1px solid rgba(255, 200, 50, 0.4)' : '1px solid var(--sardine-border)',
                      color: activeViewer === 'main' ? '#ffc832' : 'var(--text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    Main
                  </button>
                  {roiRGBData && (
                    <button
                      onClick={() => setActiveViewer('roi-rgb')}
                      style={{
                        flex: 1, padding: '3px 6px', borderRadius: 'var(--radius-sm)',
                        background: activeViewer === 'roi-rgb' ? 'rgba(78, 201, 212, 0.15)' : 'transparent',
                        border: activeViewer === 'roi-rgb' ? '1px solid rgba(78, 201, 212, 0.4)' : '1px solid var(--sardine-border)',
                        color: activeViewer === 'roi-rgb' ? '#4ec9d4' : 'var(--text-muted)',
                        cursor: 'pointer',
                      }}
                    >
                      ROI RGB
                    </button>
                  )}
                  {roiTSFrames && (
                    <button
                      onClick={() => setActiveViewer('roi-ts')}
                      style={{
                        flex: 1, padding: '3px 6px', borderRadius: 'var(--radius-sm)',
                        background: activeViewer === 'roi-ts' ? 'rgba(46, 204, 113, 0.15)' : 'transparent',
                        border: activeViewer === 'roi-ts' ? '1px solid rgba(46, 204, 113, 0.4)' : '1px solid var(--sardine-border)',
                        color: activeViewer === 'roi-ts' ? '#2ecc71' : 'var(--text-muted)',
                        cursor: 'pointer',
                      }}
                    >
                      Time Series
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* RGB per-channel histograms (main RGB mode, multi-temporal, or ROI RGB viewer) */}
            {(sidebarDisplayMode === 'rgb' || sidebarDisplayMode === 'multi-temporal') && sidebarHistogramData && (
              <HistogramPanel
                histograms={sidebarHistogramData}
                mode="rgb"
                contrastLimits={sidebarIsRoiTS
                  ? (roiTSContrastLimits || { R: [0, 1], G: [0, 1], B: [0, 1] })
                  : (sidebarIsRoiRGB
                    ? (roiRGBContrastLimits || { R: [0, 1], G: [0, 1], B: [0, 1] })
                    : (rgbContrastLimits || { R: [0, 1], G: [0, 1], B: [0, 1] }))}
                useDecibels={sidebarIsRoiTS ? false : (sidebarIsRoiRGB ? false : effectiveUseDecibels)}
                logScale={nisarProductType !== 'GCOV'}
                onContrastChange={sidebarIsRoiTS ? setRoiTSContrastLimits : (sidebarIsRoiRGB ? setRoiRGBContrastLimits : setRgbContrastLimits)}
                onAutoStretch={handleAutoStretch}
                showHeader={false}
              />
            )}

            {/* Single-band histogram */}
            {sidebarDisplayMode !== 'rgb' && sidebarDisplayMode !== 'multi-temporal' && sidebarHistogramData?.single && (
              <HistogramPanel
                histograms={sidebarHistogramData}
                mode="single"
                contrastLimits={sidebarIsRoiTS ? roiTSContrastLimits : contrastLimits}
                useDecibels={effectiveUseDecibels}
                logScale={nisarProductType !== 'GCOV'}
                onContrastChange={sidebarIsRoiTS
                  ? (([min, max]) => setRoiTSContrastLimits([Math.round(min), Math.round(max)]))
                  : (([min, max]) => { setContrastMin(min); setContrastMax(max); })
                }
                onAutoStretch={handleAutoStretch}
                showHeader={false}
              />
            )}

            {/* GUNW phase controls: LOS displacement toggle + symmetric range presets */}
            {nisarProductType === 'GUNW' && imageData && (
              <div className="control-group">
                {/* LOS displacement toggle (radians → meters) */}
                {(selectedGunwDataset === 'unwrappedPhase' || selectedGunwDataset === 'wrappedInterferogram' || selectedGunwDataset === 'ionospherePhaseScreen') && (
                  <div className="control-row u-mb-sm">
                    <input
                      type="checkbox"
                      id="losToggle"
                      checked={losDisplacement}
                      onChange={(e) => {
                        const toLOS = e.target.checked;
                        setLosDisplacement(toLOS);
                        // d = phase · λ/(4π). The rendered data is converted by the
                        // same factor via the valueScale layer prop; here we convert
                        // the user-facing contrast limits between rad and m.
                        const lambda = gunwDatasets?.metadata?.wavelength || 0.2384;
                        const scale = lambda / (4 * Math.PI);
                        if (toLOS) {
                          // radians → meters
                          setContrastMin(Number((contrastMin * scale).toFixed(4)));
                          setContrastMax(Number((contrastMax * scale).toFixed(4)));
                        } else {
                          // meters → radians
                          setContrastMin(Number((contrastMin / scale).toFixed(3)));
                          setContrastMax(Number((contrastMax / scale).toFixed(3)));
                          setVerticalDisplacement(false);
                        }
                      }}
                    />
                    <label htmlFor="losToggle">
                      LOS Displacement
                      <span className="u-hint u-ml-xs">
                        {losDisplacement ? '(m)' : '(rad)'}
                      </span>
                    </label>
                  </div>
                )}

                {/* Vertical displacement toggle — requires incidence angle grid */}
                {losDisplacement && gunwIncidenceAngleGrid && (
                  <div className="control-row u-mb-sm">
                    <input
                      type="checkbox"
                      id="vertDispToggle"
                      checked={verticalDisplacement}
                      onChange={(e) => setVerticalDisplacement(e.target.checked)}
                    />
                    <label htmlFor="vertDispToggle">
                      Vertical Displacement
                      <span className="u-hint u-ml-xs">
                        d<sub>vert</sub> = d<sub>LOS</sub> / cos({'\u03B8'})
                      </span>
                    </label>
                  </div>
                )}

                {/* Symmetric range presets */}
                <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', width: '100%', marginBottom: '2px' }}>Range Presets</span>
                  {(() => {
                    const scale = losDisplacement ? (gunwDatasets?.metadata?.wavelength || 0.2384) / (4 * Math.PI) : 1;
                    const unit = losDisplacement ? 'm' : 'rad';
                    const presets = [
                      { label: String.fromCharCode(0xB1) + String.fromCharCode(0x03C0), val: Math.PI },
                      { label: String.fromCharCode(0xB1) + '2' + String.fromCharCode(0x03C0), val: 2 * Math.PI },
                      { label: String.fromCharCode(0xB1) + '10' + String.fromCharCode(0x03C0), val: 10 * Math.PI },
                      { label: 'Auto', val: null },
                    ];
                    return presets.map(p => (
                      <button
                        key={p.label}
                        className="btn-secondary"
                        style={{ flex: 1, fontSize: 'var(--text-xs)', padding: '2px 4px', minWidth: '40px' }}
                        onClick={() => {
                          if (p.val === null) {
                            // Auto: use histogram p2/p98 if available
                            const stats = histogramData?.single;
                            if (stats) {
                              const p2 = losDisplacement ? stats.p2 * scale : stats.p2;
                              const p98 = losDisplacement ? stats.p98 * scale : stats.p98;
                              const absMax = Math.max(Math.abs(p2), Math.abs(p98));
                              setContrastMin(Number((-absMax).toFixed(3)));
                              setContrastMax(Number(absMax.toFixed(3)));
                            }
                          } else {
                            const v = p.val * scale;
                            setContrastMin(Number((-v).toFixed(4)));
                            setContrastMax(Number(v.toFixed(4)));
                          }
                        }}
                        title={p.val !== null ? `${(-p.val * scale).toFixed(3)} to ${(p.val * scale).toFixed(3)} ${unit}` : 'Auto symmetric from histogram'}
                      >
                        {p.label}
                      </button>
                    ));
                  })()}
                </div>

                {/* Phase corrections panel */}
                {selectedGunwDataset === 'unwrappedPhase' && correctionLayers && Object.keys(correctionLayers).length > 0 && (() => {
                  const btnStyle = (active) => ({
                    fontSize: 'var(--text-xs)',
                    padding: '3px 6px',
                    border: `1px solid ${active ? 'var(--sardine-cyan)' : 'var(--sardine-border)'}`,
                    borderRadius: '3px',
                    background: active ? 'var(--sardine-cyan)' : 'transparent',
                    color: active ? '#000' : 'var(--ink)',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  });
                  const resetContrast = () => {
                    // Corrections shift the effective data range — reset to wide default
                    const rm = imageData?.renderMode;
                    const [lo, hi] = rm?.defaultRange || [-50, 50];
                    setContrastMin(lo);
                    setContrastMax(hi);
                  };
                  const toggle = (key) => {
                    const next = new Set(enabledCorrections);
                    if (next.has(key)) next.delete(key); else next.add(key);
                    setEnabledCorrections(next);
                    resetContrast();
                  };
                  // Corrections the ISCE3 processor already subtracted from the
                  // unwrapped phase — subtracting again would double-correct.
                  const gm = gunwDatasets?.metadata || {};
                  const isApplied = (v) => v === true || v === 1 || String(v).toLowerCase() === 'true';
                  const alreadyApplied = new Set();
                  if (isApplied(gm.appliedIonosphereCorrection)) alreadyApplied.add('ionosphere');
                  if (isApplied(gm.appliedTroposphereCorrection)) { alreadyApplied.add('troposphereWet'); alreadyApplied.add('troposphereHydrostatic'); }
                  if (isApplied(gm.appliedSolidEarthTidesCorrection)) alreadyApplied.add('solidEarthTides');
                  const appliedTitle = 'Already applied by the processor — applying again would double-correct';
                  const availableKeys = Object.keys(CORRECTION_TYPES).filter(k => !!correctionLayers[k] && !alreadyApplied.has(k));
                  const allEnabled = availableKeys.length > 0 && availableKeys.every(k => enabledCorrections.has(k));
                  return (
                    <div style={{ marginTop: '8px', borderTop: '1px solid var(--sardine-border)', paddingTop: '6px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span className="u-note">Phase Corrections</span>
                        <button
                          style={{ ...btnStyle(allEnabled), fontSize: 'var(--text-xs)', padding: '2px 5px' }}
                          onClick={() => { setEnabledCorrections(allEnabled ? new Set() : new Set(availableKeys)); resetContrast(); }}
                        >{allEnabled ? 'Clear All' : 'Apply All'}</button>
                      </div>
                      {/* Ionosphere — same-grid correction */}
                      {correctionLayers.ionosphere && (
                        <div style={{ marginBottom: '3px' }}>
                          <button style={btnStyle(enabledCorrections.has('ionosphere'))} onClick={() => toggle('ionosphere')}
                            disabled={alreadyApplied.has('ionosphere')}
                            title={alreadyApplied.has('ionosphere') ? appliedTitle : undefined}>
                            Ionosphere{alreadyApplied.has('ionosphere') ? ' (applied)' : ''}
                          </button>
                        </div>
                      )}
                      {/* Metadata cube corrections */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                        {correctionLayers.troposphereWet && (
                          <button style={btnStyle(enabledCorrections.has('troposphereWet'))} onClick={() => toggle('troposphereWet')}
                            disabled={alreadyApplied.has('troposphereWet')}
                            title={alreadyApplied.has('troposphereWet') ? appliedTitle : undefined}>
                            Tropo (Wet){alreadyApplied.has('troposphereWet') ? ' (applied)' : ''}
                          </button>
                        )}
                        {correctionLayers.troposphereHydrostatic && (
                          <button style={btnStyle(enabledCorrections.has('troposphereHydrostatic'))} onClick={() => toggle('troposphereHydrostatic')}
                            disabled={alreadyApplied.has('troposphereHydrostatic')}
                            title={alreadyApplied.has('troposphereHydrostatic') ? appliedTitle : undefined}>
                            Tropo (Hydro){alreadyApplied.has('troposphereHydrostatic') ? ' (applied)' : ''}
                          </button>
                        )}
                        {correctionLayers.solidEarthTides && (
                          <button style={btnStyle(enabledCorrections.has('solidEarthTides'))} onClick={() => toggle('solidEarthTides')}
                            disabled={alreadyApplied.has('solidEarthTides')}
                            title={alreadyApplied.has('solidEarthTides') ? appliedTitle : undefined}>
                            Solid Earth Tides{alreadyApplied.has('solidEarthTides') ? ' (applied)' : ''}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Brightness (Window/Level) slider — shifts window center (single-band only) */}
            {sidebarDisplayMode !== 'rgb' && (
              <div className="control-group">
                <div className="u-between">
                  <label>Brightness</label>
                  <ScrubNumber
                    value={(contrastMin + contrastMax) / 2}
                    onChange={(newCenter) => {
                      const halfWidth = (contrastMax - contrastMin) / 2;
                      setContrastMin(newCenter - halfWidth);
                      setContrastMax(newCenter + halfWidth);
                    }}
                    min={effectiveUseDecibels ? -50 : 0}
                    max={effectiveUseDecibels ? 10 : 200}
                    step={effectiveUseDecibels ? 0.5 : 1}
                    precision={1}
                    suffix={effectiveUseDecibels ? 'dB' : ''}
                    width={64}
                  />
                </div>
                <input
                  type="range"
                  min={effectiveUseDecibels ? -50 : 0}
                  max={effectiveUseDecibels ? 10 : 200}
                  step={1}
                  value={Math.round((contrastMin + contrastMax) / 2)}
                  onChange={(e) => {
                    const newCenter = Number(e.target.value);
                    const halfWidth = (contrastMax - contrastMin) / 2;
                    setContrastMin(Math.round(newCenter - halfWidth));
                    setContrastMax(Math.round(newCenter + halfWidth));
                  }}
                />
                {/* Direct min/max scrubbers — Figma-style numeric editing */}
                <div style={{ display: 'flex', gap: 6, marginTop: 4, justifyContent: 'flex-end', alignItems: 'center' }}>
                  <ScrubNumber
                    value={contrastMin}
                    onChange={setContrastMin}
                    step={effectiveUseDecibels ? 0.5 : 0.05}
                    precision={effectiveUseDecibels ? 1 : 3}
                    label="min"
                    width={64}
                  />
                  <ScrubNumber
                    value={contrastMax}
                    onChange={setContrastMax}
                    step={effectiveUseDecibels ? 0.5 : 0.05}
                    precision={effectiveUseDecibels ? 1 : 3}
                    label="max"
                    width={64}
                  />
                </div>
              </div>
            )}

            {/* Stretch mode + Gamma */}
            <Field label="Stretch" className="control-group">
              <select value={stretchMode} onChange={(e) => setStretchMode(e.target.value)}>
                {Object.entries(STRETCH_MODES).map(([id, mode]) => (
                  <option key={id} value={id}>{mode.name}</option>
                ))}
              </select>
            </Field>

            {(stretchMode === 'gamma' || stretchMode === 'sigmoid') && (
              <div className="control-group">
                <div className="u-between">
                  <label>Gamma</label>
                  <ScrubNumber value={gamma} onChange={setGamma} min={0.1} max={5.0} step={0.02} precision={2} width={56} />
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={5.0}
                  step={0.05}
                  value={gamma}
                  onChange={(e) => setGamma(Number(e.target.value))}
                />
              </div>
            )}

            {/* Saturation — only shown in RGB display modes */}
            {isRGBDisplayMode && imageData?.getRGBTile && (
              <div className="control-group">
                <div className="u-between">
                  <label>Saturation</label>
                  <ScrubNumber value={rgbSaturation} onChange={setRgbSaturation} min={0} max={3} step={0.02} precision={2} width={56} />
                </div>
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.05}
                  value={rgbSaturation}
                  onChange={(e) => setRgbSaturation(Number(e.target.value))}
                />
              </div>
            )}

            {/* Color deficiency mode — only shown in RGB display modes */}
            {isRGBDisplayMode && imageData?.getRGBTile && (
              <Field label="Color deficiency" className="control-group">
                <select
                  value={colorblindMode}
                  onChange={(e) => {
                    setColorblindMode(e.target.value);
                    addStatusLog('info', e.target.value === 'off'
                      ? 'Color deficiency mode off'
                      : `Color deficiency: ${e.target.value}`);
                  }}
                  style={{ width: '100%', marginTop: '4px' }}
                >
                  <option value="off">Off</option>
                  <option value="deuteranopia">Deuteranopia / Protanopia</option>
                  <option value="tritanopia">Tritanopia</option>
                </select>
              </Field>
            )}

            {/* Multi-look toggle — hidden on main branch, needs more work */}
            {/* Speckle filter — hidden on main branch, needs more work */}

            {/* Mask toggles — only shown when mask dataset is available */}
            {imageData?.hasMask && (
              <div className="control-group">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="checkbox"
                    id="maskInvalid"
                    checked={maskInvalid}
                    onChange={(e) => {
                      setMaskInvalid(e.target.checked);
                      addStatusLog('info', e.target.checked
                        ? 'Invalid mask enabled — invalid/fill pixels hidden'
                        : 'Invalid mask disabled');
                    }}
                  />
                  <label htmlFor="maskInvalid" className="u-m0">
                    Mask invalid
                    <span className="u-hint u-ml-xs">
                      {maskInvalid ? '(0, 255)' : '(off)'}
                    </span>
                  </label>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                  <input
                    type="checkbox"
                    id="maskLayoverShadow"
                    checked={maskLayoverShadow}
                    onChange={(e) => {
                      setMaskLayoverShadow(e.target.checked);
                      addStatusLog('info', e.target.checked
                        ? 'Layover/shadow mask enabled'
                        : 'Layover/shadow mask disabled');
                    }}
                  />
                  <label htmlFor="maskLayoverShadow" className="u-m0">
                    Mask layover/shadow
                    <span className="u-hint u-ml-xs">
                      {maskLayoverShadow ? '(active)' : '(off)'}
                    </span>
                  </label>
                </div>
              </div>
            )}

            {/* Incidence angle mask — only for GCOV with metadata cube */}
            {incidenceAngleGrid && nisarProductType === 'GCOV' && (
              <div className="control-group">
                <div className="control-row">
                  <input
                    type="checkbox"
                    id="incAngleMask"
                    checked={useIncidenceAngleMask}
                    onChange={(e) => setUseIncidenceAngleMask(e.target.checked)}
                  />
                  <label htmlFor="incAngleMask">
                    Incidence Angle Mask
                    <span className="u-hint u-ml-xs">
                      {useIncidenceAngleMask ? `${incAngleMin}°–${incAngleMax}°` : '(off)'}
                    </span>
                  </label>
                </div>
                {useIncidenceAngleMask && (
                  <>
                    <div className="u-between u-mt-xs">
                      <span className="u-note">Near range (min)</span>
                      <span className="value-display">{incAngleMin}°</span>
                    </div>
                    <input
                      type="range" min={0} max={60} step={1}
                      value={incAngleMin}
                      onChange={(e) => setIncAngleMin(Number(e.target.value))}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
                      <span className="u-note">Far range (max)</span>
                      <span className="value-display">{incAngleMax}°</span>
                    </div>
                    <input
                      type="range" min={0} max={60} step={1}
                      value={incAngleMax}
                      onChange={(e) => setIncAngleMax(Number(e.target.value))}
                    />
                  </>
                )}
                {incidenceScatterData && (
                  <IncidenceScatter
                    scatterData={incidenceScatterData}
                    angleMin={incAngleMin}
                    angleMax={incAngleMax}
                    onAngleRangeChange={({ min, max }) => {
                      if (min !== undefined) setIncAngleMin(min);
                      if (max !== undefined) setIncAngleMax(max);
                    }} className="u-mt-sm"
                  />
                )}
              </div>
            )}
          </CollapsibleSection>
          )}

          {/* NOTE: Tone Mapping UI hidden — feature only wired for SARTiledCOGLayer,
             not for HDF5/BitmapLayer/GPULayer paths. The implementation lives in
             src/utils/tone-mapping.js (adaptive log, percentile gamma, local contrast,
             scene analysis). Re-enable here once wired end-to-end for all render paths.
             See also: toneMapping state vars + useMemo below, SARTiledCOGLayer.renderTile(),
             and src/index.js tone-mapping exports. */}
        </div>

        {/* Viewer Container */}
        <div
          className="viewer-container"
          style={{ '--bottom-dock': statusCollapsed ? '32px' : '310px' }}
          onContextMenu={handleViewerContextMenu}
          onPointerDown={handleViewerPointerDown}
          onPointerMove={cancelLongPress}
          onPointerUp={cancelLongPress}
          onPointerCancel={cancelLongPress}
        >
          {/* W030: determinate load panel — chunk counts, bytes, and a Cancel
              that reaches the range reads. Stays up past `loading` while the
              overview prefetch is still streaming bytes. */}
          {(loading || loadProgress > 0) && (
            <div className="load-panel" role="status" aria-live="polite">
              <div className="load-panel-title">
                {fileType === 'cmr' && loading && !loadDetail
                  ? 'Streaming NISAR metadata from DAAC'
                  : loadPhaseLabel(loadDetail)}
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.max(2, loadProgress)}%`, transition: 'width 0.3s ease' }}
                />
              </div>
              <div className="load-panel-detail">{loadDetailText(loadProgress, loadDetail)}</div>
              {loadCancellable && (
                <button className="btn-secondary load-cancel" onClick={cancelActiveLoad}>Cancel</button>
              )}
            </div>
          )}

          {/* W031: a dropped VRT whose sources are absolute local paths — the
              browser needs the user to grant the folder that holds them. */}
          {vrtSourcePrompt && (
            <div className="error-stack">
              <div className="error" role="alert">
                <span className="error-text">
                  {vrtSourcePrompt.file.name}: {vrtSourcePrompt.total} source file{vrtSourcePrompt.total === 1 ? '' : 's'} not
                  found — the VRT points at {vrtSourcePrompt.missing[0].replace(/[\\/][^\\/]*$/, '/')}
                </span>
                <button className="btn-secondary" onClick={chooseVrtSourceFolder}>
                  Choose source folder…
                </button>
                <button
                  className="error-dismiss"
                  aria-label="Dismiss"
                  onClick={() => setVrtSourcePrompt(null)}
                >
                  ×
                </button>
              </div>
            </div>
          )}

          {/* W030: errors accumulate and are dismissed individually — the
              previous single div meant the last failure to land was the only
              one anybody ever saw. */}
          {errors.length > 0 && (
            <div className="error-stack">
              {errors.map(err => (
                <div className="error" role="alert" key={err.id}>
                  <span className="error-text">
                    {err.message}
                    {err.count > 1 && <span className="error-count"> ×{err.count}</span>}
                  </span>
                  <button
                    className="error-dismiss"
                    aria-label="Dismiss this error"
                    onClick={() => dismissError(err.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {errors.length > 1 && (
                <button className="btn-secondary error-dismiss-all" onClick={() => setError(null)}>
                  Dismiss all
                </button>
              )}
            </div>
          )}

          {!loading && loadProgress === 0 && !imageData && !compareMode && (
            <div className="empty-state">
              <h2 className="empty-state-title">Open a SAR scene</h2>
              <p className="empty-state-lede">{EMPTY_STATE_HINTS[fileType] || EMPTY_STATE_HINTS.nisar}</p>
              <div className="empty-state-actions">
                <button
                  className="btn-primary"
                  onClick={() => document.getElementById('nisar-file-input')?.click()}
                >
                  Choose a NISAR .h5 file
                </button>
                <span className="empty-state-or">or drop one anywhere on this window</span>
              </div>
              <div className="empty-state-url">
                <label htmlFor="empty-state-url-input">Paste a URL to a GCOV granule or COG</label>
                <div className="empty-state-url-row">
                  <input
                    id="empty-state-url-input"
                    type="text"
                    placeholder="https://…/NISAR_L2_GCOV_….h5"
                    value={directUrl}
                    onChange={(e) => setDirectUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleDirectUrlSubmit(); }}
                  />
                  <button className="btn-secondary" onClick={handleDirectUrlSubmit}>Open</button>
                </div>
              </div>
              <button className="empty-state-demo" onClick={openHeroDemo}>
                Or open the demo scene: Pacaya-Samiria floodplain, dual-pol L-band
              </button>
            </div>
          )}

          {/* Compare Grid: up to 4 GeoTIFFs, synced pan/zoom */}
          {compareMode && (
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
              <button
                onClick={() => { setCompareMode(false); setCompareInitialFiles(null); setCompareInitialUrls(null); }}
                style={{
                  position: 'absolute', top: '8px', right: '8px', zIndex: 2000,
                  background: 'rgba(0,0,0,0.7)', color: 'var(--text-muted)',
                  border: '1px solid var(--sardine-border)', borderRadius: 'var(--radius-sm)',
                  padding: '2px 8px', fontSize: 'var(--text-xs)', cursor: 'pointer',
                }}
              >
                Close Compare
              </button>
              <CompareGrid
                ref={compareGridRef}
                initialFiles={compareInitialFiles}
                initialUrls={compareInitialUrls}
                initialBbox={compareInitialBbox}
                onStatus={(level, msg, detail) => addStatusLog(level, msg, detail)}
                onExport={handleSaveFigure}
                figureTheme={figureTheme}
                onFigureThemeChange={(t) => { setFigureTheme(t); try { localStorage.setItem('sardine.figureTheme', t); } catch {} }}
              />
            </div>
          )}

          {/* GUNW Paired View: Phase + Coherence side-by-side */}
          {!compareMode && gunwPairedView && (
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
              <button
                onClick={() => setGunwPairedView(null)}
                style={{
                  position: 'absolute', top: '8px', right: '8px', zIndex: 10,
                  background: 'rgba(0,0,0,0.7)', color: 'var(--text-muted)',
                  border: '1px solid var(--sardine-border)', borderRadius: 'var(--radius-sm)',
                  padding: '2px 8px', fontSize: 'var(--text-xs)', cursor: 'pointer',
                }}
              >
                Close Paired View
              </button>
              <ComparisonViewer
                leftImage={gunwPairedView.left}
                rightImage={gunwPairedView.right}
                leftLabel="Unwrapped Phase"
                rightLabel="Coherence"
                width="100%"
                height="100%"
              />
            </div>
          )}

          {imageData && !gunwPairedView && !compareMode && (
            <div className="viewer-split">
              {/* Loading overlay — shown on top of existing data while new data streams */}
              {loading && (
                <div className="viewer-loading">
                  <p className="viewer-loading__label">Loading dataset...</p>
                </div>
              )}
              {/* Main viewer (single-channel full extent) */}
              <div
                onClick={() => roiRGBData && setActiveViewer('main')}
                className={`viewer-pane${roiRGBData && activeViewer === 'main' ? ' viewer-pane--active viewer-pane--main' : ''}`}>
                <SARViewer
                  ref={viewerRef}
                  cogUrl={imageData?.cogUrl}
                  getTile={imageData?.getTile}
                  tileVersion={tileVersion}
                  imageData={imageData?.data ? imageData : null}
                  bounds={imageData?.bounds || [-180, -90, 180, 90]}
                  contrastLimits={effectiveContrastLimits}
                  useDecibels={effectiveUseDecibels}
                  colormap={colormap}
                  reverseColormap={reverseColormap}
                  gamma={gamma}
                  stretchMode={stretchMode}
                  compositeId={isRGBDisplayMode ? compositeId : null}
                  multiLook={multiLook}
                  maskInvalid={maskInvalid}
                  maskLayoverShadow={maskLayoverShadow}
                  useCoherenceMask={useCoherenceMask || useIncidenceAngleMask}
                  coherenceThreshold={useIncidenceAngleMask ? incAngleMin : coherenceThreshold}
                  coherenceThresholdMax={useIncidenceAngleMask ? incAngleMax : 1.0}
                  coherenceMaskMode={useIncidenceAngleMask ? 1 : 0}
                  incidenceAngleData={useIncidenceAngleMask ? incidenceAngleGrid : (verticalDisplacement ? gunwIncidenceAngleGrid : null)}
                  verticalDisplacement={verticalDisplacement}
                  valueScale={losDisplacement ? (gunwDatasets?.metadata?.wavelength || 0.2384) / (4 * Math.PI) : 1}
                  epsg={imageData?.epsg ?? imageData?.crs ?? null}
                  correctionLayers={correctionLayers}
                  enabledCorrections={enabledCorrections}
                  speckleFilterType={nisarProductType === 'GUNW' ? 'none' : speckleFilterType}
                  speckleKernelSize={speckleKernelSize}
                  rgbSaturation={rgbSaturation}
                  colorblindMode={colorblindMode}
                  classMode={!!mainClassInfo}
                  classPalette={mainClassInfo?.palette || null}
                  classPaletteEntries={mainClassInfo?.entries || 0}
                  showGrid={showGrid}
                  opacity={1}
                  width="100%"
                  height="100%"
                  onViewStateChange={handleViewStateChange}
                  onTilesLoadingChange={setTilesLoading}
                  initialViewState={initialViewState}
                  extraLayers={[...opticalPeekLayers, ...overtureLayers, ...catalogLayers, ...stacLayers, ...geojsonOverlayLayers]}
                  roi={roi}
                  onROIChange={setROI}
                  transectEnabled={transectEnabled}
                  transectLine={transectLine}
                  onTransectLineChange={setTransectLine}
                  imageWidth={imageData?.sourceWidth || imageData?.width}
                  imageHeight={imageData?.sourceHeight || imageData?.height}
                  getPixelValue={imageData?.getPixelValue}
                  pixelExplorer={pixelExplorer}
                  pixelWindowSize={pixelWindowSize}
                  xCoords={imageData?.xCoords}
                  yCoords={imageData?.yCoords}
                  roiProfile={null}
                  profileShow={{ v: false, h: false, i: false }}
                  classificationMap={modelOverlay ? modelOverlay.map : (classifierOpen ? classificationMap : null)}
                  classRegions={modelOverlay ? modelOverlay.regions : classRegions}
                  classifierRoiDims={modelOverlay ? modelOverlay.dims : classifierRoiDims}
                  mosaicLayers={gcovMosaicLayers}
                  medicalMode={medicalMode}
                  setContrastLimits={(lim) => {
                    if (!Array.isArray(lim) || lim.length !== 2) return;
                    setContrastMin(lim[0]);
                    setContrastMax(lim[1]);
                  }}
                  histogramData={histogramData}
                  inverted={medicalInverted}
                  setInverted={setMedicalInverted}
                  annotations={annotations}
                  annotationMode={annotationMode}
                  annotationColor={annotationColor}
                  annotationSize={annotationSize}
                  onAnnotationsChange={setAnnotations}
                  selectedAnnotationId={selectedAnnotationId}
                  onSelectAnnotation={setSelectedAnnotationId}
                />
              </div>

              {/* ROI RGB viewer (side-by-side, only when ROI RGB loaded) */}
              {roiRGBData && roiRGBBounds && roiRGBContrastLimits && (
                <>
                  <div className="viewer-splitter" role="separator" />
                  <div
                    onClick={() => setActiveViewer('roi-rgb')}
                    className={`viewer-pane viewer-pane--rgb${activeViewer === 'roi-rgb' ? ' viewer-pane--active' : ''}`}>
                    <p className="viewer-badge viewer-badge--rgb">ROI RGB: {roiCompositeId}</p>
                    <button
                      onClick={() => { setRoiRGBData(null); setRoiRGBBounds(null); setRoiRGBContrastLimits(null); setRoiRGBHistogramData(null); setActiveViewer('main'); }}
                      className="viewer-action viewer-action--tr"
                    >
                      Close
                    </button>
                    <SARViewer
                      ref={roiRGBViewerRef}
                      getTile={roiRGBData.getTile}
                      bounds={roiRGBBounds}
                      contrastLimits={roiRGBContrastLimits}
                      useDecibels={false}
                      colormap={colormap}
                      reverseColormap={reverseColormap}
                      gamma={gamma}
                      stretchMode={stretchMode}
                      compositeId={roiCompositeId}
                      showGrid={showGrid}
                      opacity={1}
                      width="100%"
                      height="100%"
                    />
                  </div>
                </>
              )}

              {/* ROI Time-Series viewer (side-by-side, only when frames loaded) */}
              {roiTSFrames && roiTSBounds && roiTSContrastLimits && (
                <>
                  <div className="viewer-splitter" role="separator" />
                  <div
                    onClick={() => setActiveViewer('roi-ts')}
                    className={`viewer-pane viewer-pane--ts${activeViewer === 'roi-ts' ? ' viewer-pane--active' : ''}`}>
                    <p className="viewer-badge viewer-badge--ts">
                      {roiTSFrames[roiTSIndex]?.label || 'Frame ' + roiTSIndex}
                      {' '}({roiTSIndex + 1}/{roiTSFrames.length})
                    </p>
                    <Toolbar className="viewer-actions viewer-actions--tr">
                      {roiTSFrames[roiTSIndex]?.getExportStripe && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleExportTSFrame(); }}
                          disabled={exporting}
                          className="viewer-action viewer-action--ts"
                        >
                          {exporting ? `${exportProgress}%` : `Export GeoTIFF (${exportMode === 'raw' ? 'Float32' : 'Rendered'})`}
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); setRoiTSFrames(null); setRoiTSBounds(null); setRoiTSContrastLimits(null); setRoiTSHistogramData(null); setRoiTSPlaying(false); setActiveViewer('main'); }}
                        className="viewer-action"
                      >
                        Close
                      </button>
                    </Toolbar>
                    {/* Playback controls */}
                    <div className="viewer-playbar" role="group" aria-label="Time-series playback">
                      <button
                        onClick={(e) => { e.stopPropagation(); setRoiTSIndex(prev => (prev - 1 + roiTSFrames.length) % roiTSFrames.length); }}
                        className="viewer-playbar__btn" aria-label="Previous frame"
                      >◀</button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setRoiTSPlaying(prev => !prev); }}
                        className="viewer-playbar__btn" aria-label={roiTSPlaying ? 'Pause' : 'Play'}
                      >{roiTSPlaying ? '⏸' : '▶'}</button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setRoiTSIndex(prev => (prev + 1) % roiTSFrames.length); }}
                        className="viewer-playbar__btn" aria-label="Next frame"
                      >▶</button>
                      <input
                        type="range"
                        min={0}
                        max={roiTSFrames.length - 1}
                        value={roiTSIndex}
                        onChange={(e) => { e.stopPropagation(); setRoiTSIndex(Number(e.target.value)); }}
                        onClick={(e) => e.stopPropagation()}
                        className="viewer-playbar__scrub"
                        aria-label="Frame"
                      />
                      <span className="viewer-playbar__label">
                        {roiTSFrames[roiTSIndex]?.label}
                      </span>
                    </div>
                    <SARViewer
                      ref={roiTSViewerRef}
                      getTile={roiTSFrames[roiTSIndex]?.getTile}
                      tileVersion={roiTSIndex}
                      bounds={roiTSBounds}
                      contrastLimits={roiTSContrastLimits}
                      useDecibels={roiTSFrames[roiTSIndex]?.isRGB ? false : (nisarProductType === 'GUNW' ? false : useDecibels)}
                      compositeId={roiTSFrames[roiTSIndex]?.compositeId || null}
                      colormap={colormap}
                      reverseColormap={reverseColormap}
                      gamma={gamma}
                      stretchMode={stretchMode}
                      showGrid={showGrid}
                      opacity={1}
                      width="100%"
                      height="100%"
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* Satellite Map — Bing VirtualEarth aerial, toggleable, next to globe */}
          <SatelliteMap
            wgs84Bounds={wgs84Bounds}
            visible={satelliteMapVisible}
            onToggle={() => setSatelliteMapVisible(v => !v)}
          />

          {/* Overview Map — toggleable overlay, bottom-left */}
          <OverviewMap
            wgs84Bounds={wgs84Bounds}
            visible={overviewMapVisible}
            onToggle={() => setOverviewMapVisible(v => !v)}
            cmrFootprints={fileType === 'cmr' ? cmrFootprints : null}
            onSelectFootprint={fileType === 'cmr' ? (idx) => {
              const fp = cmrFootprints[idx];
              if (!fp?.dataUrl) {
                addStatusLog('warning', `No data URL for granule ${fp?.id || idx}`);
                return;
              }
              // Fetch metadata — user then clicks "Load Dataset" to stream
              handleRemoteFileSelect({
                url: fp.dataUrl,
                name: fp.id || `Granule ${idx}`,
                size: 0,
                type: 'nisar',
                token: earthdataToken || undefined,
              });
              addStatusLog('info', `Selected: ${fp.id}`);
            } : null}
            onViewBoundsChange={fileType === 'cmr' ? setOverviewBounds : null}
          />

          {/* Metadata Panel — overlaid on viewer, top-right */}
          <MetadataPanel
            imageData={imageData}
            fileType={fileType}
            fileName={nisarFile?.name || cogUrl || null}
          />

          {/* Histogram Inset — viewport-snapped, bottom-right */}
          {showHistogramOverlay && histogramData && (
            <HistogramOverlay
              histograms={histogramData}
              mode={isRGBDisplayMode ? 'rgb' : displayMode}
              contrastLimits={isRGBDisplayMode ? rgbContrastLimits : [contrastMin, contrastMax]}
              useDecibels={effectiveUseDecibels}
              logScale={nisarProductType !== 'GCOV'}
              polarization={selectedPolarization}
              compositeId={compositeId}
              onClose={() => setShowHistogramOverlay(false)}
            />
          )}

          {/* Feature Space Classifier */}
          {classifierOpen && roi && classifierData && (
            <ScatterClassifier
              scatterData={classifierData}
              xLabel={`${classifierBands.x} (dB)`}
              yLabel={`${classifierBands.y} (dB)`}
              classRegions={classRegions}
              onClassRegionsChange={setClassRegions}
              classificationMap={classificationMap}
              classifierRoiDims={classifierRoiDims}
              incidenceRange={incidenceRange}
              onIncidenceRangeChange={setIncidenceRange}
              onClose={() => setClassifierOpen(false)}
            />
          )}
        </div>
      </div>

      {/* Status Window */}
      <StatusWindow
        logs={statusLogs}
        isCollapsed={statusCollapsed}
        onToggle={() => setStatusCollapsed(!statusCollapsed)}
        activeTab={bottomTab}
        onTabChange={setBottomTab}
        tabs={transectEnabled ? [{
          id: 'transect',
          label: 'Transect',
          content: (
            <TransectProfilePanel
              data={transectData}
              enabled={transectEnabled}
              useDecibels={effectiveUseDecibels}
              width={transectWidth}
              onWidthChange={setTransectWidth}
              line={transectLine}
            />
          ),
        }] : []}
      />

      {/* Footer */}
      <footer className="app-footer">
        <span><a href="https://github.com/nicksteiner/sardine" target="_blank" rel="noopener noreferrer">SARdine</a> v1.0 · MIT</span>
        <span>steinerlab - ccny</span>
        <Toolbar className="app-footer__meta" wrap={false}>
          deck.gl{multiLook ? ' · multi-look' : ''}
          {gpuInfo.webgpu
            ? ' · WebGPU'
            : <span className="app-footer__gpu"> · no WebGPU (histogram CPU-only)</span>}
          <Field label="workers" inline value={workerCount} className="app-footer__workers">
            <input
              type="range"
              min={1}
              max={workerInfo.cores * 2}
              value={workerCount}
              onChange={(e) => {
                const n = Number(e.target.value);
                setWorkerCount(n);
                setPoolWorkerCount(n);
              }}
            />
          </Field>
        </Toolbar>
      </footer>

      {/* Histogram overlay moved inside viewer-container */}
    </div>
  );
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[SARdine] Uncaught error:', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <main className="crash">
          <h1 className="crash__title">Something went wrong</h1>
          <pre className="crash__message">{this.state.error?.message}</pre>
          <Button variant="primary" size="md" onClick={() => this.setState({ hasError: false, error: null })}>
            Try Again
          </Button>
        </main>
      );
    }
    return this.props.children;
  }
}

// Mount the app (guard against Vite HMR re-execution)
const container = document.getElementById('app');
if (!container._reactRoot) {
  container._reactRoot = createRoot(container);
}
container._reactRoot.render(<ErrorBoundary><App /></ErrorBoundary>);
