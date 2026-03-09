import React, { useState, useCallback, useEffect, useMemo, useRef, Component } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/sardine-theme.css';
import { SARViewer, loadCOG, loadLocalTIFs, loadCOGFullImage, autoContrastLimits, loadNISARGCOV, listNISARDatasets, loadMultiBandCOG, loadTemporalCOGs } from '../src/index.js';
import { loadNISARRGBComposite, listNISARDatasetsFromUrl, loadNISARGCOVFromUrl, wktToROI } from '../src/loaders/nisar-loader.js';
import { validateWKT } from '../src/utils/wkt.js';
import { computeSubsetBounds } from '../src/utils/roi-subset.js';
import { autoSelectComposite, getAvailableComposites, getRequiredDatasets, getRequiredComplexDatasets } from '../src/utils/sar-composites.js';
import { DataDiscovery } from '../src/components/DataDiscovery.jsx';
import { isNISARFile, isCOGFile } from '../src/utils/bucket-browser.js';
import { writeRGBAGeoTIFF, writeFloat32GeoTIFF, downloadBuffer } from '../src/utils/geotiff-writer.js';
import { createRGBTexture, computeRGBBands } from '../src/utils/sar-composites.js';
import { computeChannelStats, sampleViewportStats } from '../src/utils/stats.js';
import { computeChannelStatsAuto } from '../src/gpu/gpu-stats.js';
import { applySpeckleFilter, getFilterTypes } from '../src/gpu/spatial-filter.js';
import { StatusWindow } from '../src/components/StatusWindow.jsx';
import { MetadataPanel } from '../src/components/MetadataPanel.jsx';
import { OverviewMap } from '../src/components/OverviewMap.jsx';
import { HistogramPanel } from '../src/components/Histogram.jsx';
import { HistogramOverlay } from '../src/components/HistogramOverlay.jsx';
import { exportFigure, exportFigureWithOverlays, exportRGBColorbar, downloadBlob } from '../src/utils/figure-export.js';
import { STRETCH_MODES, applyStretch } from '../src/utils/stretch.js';
import { getColormap } from '../src/utils/colormap.js';
import { OVERTURE_THEMES, fetchAllOvertureThemes, projectedToWGS84 } from '../src/loaders/overture-loader.js';
import { createOvertureLayers } from '../src/layers/OvertureLayer.js';
import { SceneCatalog } from '../src/components/SceneCatalog.jsx';
import { STACSearch } from '../src/components/STACSearch.jsx';
import { ROIProfilePlot } from '../src/components/ROIProfilePlot.jsx';
import ScatterClassifier from '../src/components/ScatterClassifier.jsx';
import ClassificationOverlay from '../src/components/ClassificationOverlay.jsx';

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

/**
 * CollapsibleSection - A control panel section with a clickable header to collapse/expand.
 */
function CollapsibleSection({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="control-section">
      <h3
        className={`collapsible${open ? '' : ' collapsed'}`}
        onClick={() => setOpen(o => !o)}
      >{title}</h3>
      <div className={`section-body${open ? '' : ' collapsed'}`}>
        {children}
      </div>
    </div>
  );
}

/**
 * SARdine - SAR Data INspection and Exploration
 * Phase 1: Basic Viewer + Phase 2: State as Markdown
 */
function App() {
  // Data source state: format × source → derived fileType for conditional rendering
  const [dataFormat, setDataFormat] = useState('geotiff'); // 'geotiff' | 'nisar'
  const [dataSource, setDataSource] = useState('local');   // 'local' | 'url' | 's3' | 'catalog' | 'stac'

  const fileType = useMemo(() => {
    if (dataSource === 'catalog') return 'catalog';
    if (dataSource === 'stac') return 'stac';
    if (dataFormat === 'geotiff') return dataSource === 'local' ? 'local-tif' : 'cog';
    return dataSource === 'local' ? 'nisar' : 'remote';
  }, [dataFormat, dataSource]);

  const setFileType = useCallback((ft) => {
    const map = {
      'local-tif': ['geotiff', 'local'], 'cog': ['geotiff', 'url'],
      'nisar': ['nisar', 'local'], 'remote': ['nisar', 's3'],
      'catalog': ['geotiff', 'catalog'], 'stac': ['geotiff', 'stac'],
    };
    const [f, s] = map[ft] || ['geotiff', 'local'];
    setDataFormat(f);
    setDataSource(s);
  }, []);
  const [cogUrl, setCogUrl] = useState('');
  const [imageData, setImageData] = useState(null);
  const [tileVersion, setTileVersion] = useState(0); // bumped on progressive tile refinement
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const [error, setError] = useState(null);

  // Load generation counter — incremented on each new load to discard stale results
  const loadGenRef = useRef(0);

  // Remote source state
  const [remoteUrl, setRemoteUrl] = useState(null);
  const [remoteName, setRemoteName] = useState(null);
  const [directUrl, setDirectUrl] = useState('');

  // NISAR-specific state
  const [nisarFile, setNisarFile] = useState(null);
  const [nisarDatasets, setNisarDatasets] = useState([]);
  const [selectedFrequency, setSelectedFrequency] = useState('A');
  const [selectedPolarization, setSelectedPolarization] = useState('HHHH');

  // RGB composite state
  const [displayMode, setDisplayMode] = useState('single'); // 'single' | 'rgb'
  const [compositeId, setCompositeId] = useState(null);
  const [availableComposites, setAvailableComposites] = useState([]);

  // Per-channel contrast for RGB mode (linear values)
  const [rgbContrastLimits, setRgbContrastLimits] = useState(null);
  // Histogram data: {single: stats} or {R: stats, G: stats, B: stats}
  const [histogramData, setHistogramData] = useState(null);

  // Multi-file state
  const [multiFileMode, setMultiFileMode] = useState(false);
  const [multiFileModeType, setMultiFileModeType] = useState('multi-band'); // 'multi-band' or 'temporal'
  const [fileList, setFileList] = useState(['']); // Array of URLs
  const [bandNames, setBandNames] = useState([]); // Auto-detected or manual

  // Viewer settings
  const [colormap, setColormap] = useState('grayscale');
  const [useDecibels, setUseDecibels] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [pixelExplorer, setPixelExplorer] = useState(false);
  const [pixelWindowSize, setPixelWindowSize] = useState(1);
  const [contrastMin, setContrastMin] = useState(-25);
  const [contrastMax, setContrastMax] = useState(0);
  const [gamma, setGamma] = useState(1.0);
  const [stretchMode, setStretchMode] = useState('linear');
  const [multiLook, setMultiLook] = useState(false);
  const [useMask, setUseMask] = useState(false);
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

  // Feature space classifier state
  const [classifierOpen, setClassifierOpen] = useState(false);
  const [classRegions, setClassRegions] = useState([]); // [{name, color, xMin, xMax, yMin, yMax}]
  const [classifierData, setClassifierData] = useState(null); // {x: Float32Array, y: Float32Array, valid: Uint8Array, w, h}
  const [classifierBands, setClassifierBands] = useState({ x: 'HHHH', y: 'HVHV' });
  const [classificationMap, setClassificationMap] = useState(null); // Uint8Array per ROI pixel
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

  // Overture Maps overlay state
  const [overtureEnabled, setOvertureEnabled] = useState(false);
  const [overtureThemes, setOvertureThemes] = useState(['buildings']); // enabled themes
  const [overtureData, setOvertureData] = useState(null);
  const [overtureLoading, setOvertureLoading] = useState(false);
  const [overtureOpacity, setOvertureOpacity] = useState(0.7);
  const overtureDebounceRef = useRef(null);

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

  // Status window state
  const [statusLogs, setStatusLogs] = useState([]);
  const [statusCollapsed, setStatusCollapsed] = useState(true);

  // Overview map state
  const [overviewMapVisible, setOverviewMapVisible] = useState(false);

  // Clear ROI and classifier when image data changes (new file/dataset loaded)
  useEffect(() => {
    setROI(null);
    setRoiProfile(null);
    setWktInput('');
    setWktError(null);
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
      if (roi) console.log('[ROI Profile] Skipping:', { roi: !!roi, hasGetExportStripe: !!imageData?.getExportStripe });
      setRoiProfile(null);
      return;
    }
    console.log('[ROI Profile] Computing for ROI:', roi);
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
            const v = useDecibels ? 10 * Math.log10(r) : r;
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
          console.log('[ROI Profile] Computed:', { exportW, exportH, vCount, mean: mean.toFixed(2), vMin: vMin.toFixed(2), vMax: vMax.toFixed(2) });
          setRoiProfile({ rowMeans, colMeans, hist, histMin: vMin, histMax: vMax, mean, count: vCount, exportW, exportH, useDecibels });
        }
      } catch (e) {
        console.error('[ROI Profile] Error:', e);
        if (!cancelled) setRoiProfile(null);
      }
    };

    run();
    return () => { cancelled = true; };
  }, [roi, imageData, useDecibels]);

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
            x[i] = 10 * Math.log10(xr);
            y[i] = 10 * Math.log10(yr);
            valid[i] = 1;
          }
        }

        // Evaluate incidence angle over ROI if metadata cube available
        let incidence = null;
        console.log('[Classifier] metadataCube:', !!imageData.metadataCube, 'xCoords:', !!imageData.xCoords, 'yCoords:', !!imageData.yCoords);
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
          console.log('[Classifier] Scatter data ready:', { exportW, exportH, validCount, hasIncidence: !!incidence });
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
    if (!nisarFile || !roi || !roiCompositeId || !imageData) return;

    setRoiRGBLoading(true);
    try {
      const requiredPols = getRequiredDatasets(roiCompositeId);
      const requiredComplexPols = getRequiredComplexDatasets(roiCompositeId);

      addStatusLog('info', `Loading ROI RGB composite: ${roiCompositeId} (${requiredPols.join(', ')})`);

      const data = await loadNISARRGBComposite(nisarFile, {
        frequency: selectedFrequency,
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
        roiHists = {};
        for (const ch of ['R', 'G', 'B']) {
          const stats = computeChannelStats(rawValues[ch], false);
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
  }, [nisarFile, roi, roiCompositeId, selectedFrequency, imageData, addStatusLog]);

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

      const frames = [];
      for (let i = 0; i < roiTSFiles.length; i++) {
        const file = roiTSFiles[i];
        addStatusLog('info', `Loading file ${i + 1}/${roiTSFiles.length}: ${file.name}`);
        try {
          const data = await loadNISARGCOV(file, {
            frequency: selectedFrequency,
            polarization: selectedPolarization,
          });
          // Extract date from identification metadata or filename
          const ident = data.identification || {};
          const date = ident.zeroDopplerStartTime || ident.rangeBeginningDateTime || file.name;
          const label = typeof date === 'string' && date.length > 10 ? date.slice(0, 10) : file.name.replace(/\.[^.]+$/, '');
          frames.push({
            getTile: data.getTile,
            bounds: data.bounds,
            label,
            date,
            width: data.width,
            height: data.height,
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

      // Compute histogram from first frame for contrast
      const [minX, minY, maxX, maxY] = subBounds;
      const regionW = maxX - minX;
      const regionH = maxY - minY;
      let tsHist = null;
      let tsContrast = [-25, 0]; // dB default
      try {
        const stats = await sampleViewportStats(
          frames[0].getTile, regionW, regionH, useDecibels, 128,
          minX, minY, frames[0].height,
        );
        if (stats) {
          tsHist = { single: stats };
          tsContrast = [Number(stats.p2.toFixed(1)), Number(stats.p98.toFixed(1))];
        }
      } catch (histErr) {
        addStatusLog('warning', `Time-series histogram error: ${histErr.message}`);
      }

      setRoiTSBounds(subBounds);
      setRoiTSFrames(frames);
      setRoiTSContrastLimits(tsContrast);
      setRoiTSHistogramData(tsHist);
      setActiveViewer('roi-ts');

      addStatusLog('success', `Time-series loaded: ${frames.length} frames`,
        frames.map(f => f.label).join(', '));
    } catch (err) {
      addStatusLog('error', `Time-series load failed: ${err.message}`);
    } finally {
      setRoiTSLoading(false);
    }
  }, [roiTSFiles, roi, imageData, selectedFrequency, selectedPolarization, useDecibels, addStatusLog]);

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
    if (displayMode === 'rgb' && rgbContrastLimits) {
      return rgbContrastLimits;
    }
    return contrastLimits;
  }, [displayMode, rgbContrastLimits, contrastLimits]);

  // Sidebar context: which viewer are the controls targeting?
  const sidebarIsRoiRGB = activeViewer === 'roi-rgb' && !!roiRGBData;
  const sidebarIsRoiTS = activeViewer === 'roi-ts' && !!roiTSFrames;
  const sidebarHistogramData = sidebarIsRoiTS ? roiTSHistogramData : (sidebarIsRoiRGB ? roiRGBHistogramData : histogramData);
  const sidebarDisplayMode = sidebarIsRoiRGB ? 'rgb' : (sidebarIsRoiTS ? 'single' : displayMode);

  // Auto-stretch: reset to 2-98% percentiles from cached histogram
  const handleAutoStretch = useCallback(() => {
    // If ROI RGB viewer is active, auto-stretch its contrast
    // If ROI time-series viewer is active
    if (activeViewer === 'roi-ts' && roiTSHistogramData?.single) {
      const p2 = Number(roiTSHistogramData.single.p2.toFixed(1));
      const p98 = Number(roiTSHistogramData.single.p98.toFixed(1));
      setRoiTSContrastLimits([p2, p98]);
      addStatusLog('success', `Time-series contrast reset to ${p2} – ${p98}`);
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

    if (displayMode === 'rgb') {
      const newLimits = {};
      for (const ch of ['R', 'G', 'B']) {
        if (histogramData[ch]) {
          newLimits[ch] = [histogramData[ch].p2, histogramData[ch].p98];
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
  }, [histogramData, displayMode, addStatusLog, activeViewer, roiRGBData, roiRGBHistogramData, roiTSHistogramData]);

  // Recompute histogram (viewport-aware)
  const handleRecomputeHistogram = useCallback(async () => {
    console.log('[histogram] handleRecomputeHistogram called, scope:', histogramScope, 'displayMode:', displayMode, 'hasGetTile:', !!imageData?.getTile, 'hasGetRGBTile:', !!imageData?.getRGBTile, 'compositeId:', compositeId);
    if (!imageData || !imageData.getTile) {
      addStatusLog('warning', 'No tile data available for histogram');
      return;
    }
    if (histogramScope === 'roi' && !roi) {
      addStatusLog('warning', 'No ROI drawn — draw a region with Shift+drag first');
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

      if (displayMode === 'rgb' && imageData.getRGBTile && compositeId) {
        // RGB histogram — sample 3×3 tiles from the region
        const tileSize = 256;
        const rawValues = { R: [], G: [], B: [] };
        const gridSize = 3;
        const totalTiles = gridSize * gridSize;
        const stepX = regionW / gridSize;
        const stepY = regionH / gridSize;
        let done = 0;

        for (let ty = 0; ty < gridSize; ty++) {
          for (let tx = 0; tx < gridSize; tx++) {
            const left = regionX + tx * stepX;
            const right = regionX + (tx + 1) * stepX;
            const top = regionY + ty * stepY;
            const bottom = regionY + (ty + 1) * stepY;

            const tileData = await imageData.getRGBTile({
              x: tx, y: ty, z: 0,
              bbox: { left, top, right, bottom },
            });

            if (tileData && tileData.bands) {
              const rgbBands = computeRGBBands(tileData.bands, compositeId, tileSize);
              for (const ch of ['R', 'G', 'B']) {
                const arr = rgbBands[ch];
                // Subsample every 4th pixel for efficiency
                for (let i = 0; i < arr.length; i += 4) {
                  if (arr[i] > 0 && !isNaN(arr[i])) rawValues[ch].push(arr[i]);
                }
              }
            }

            done++;
            addStatusLog('info', `Histogram: sampling tile ${done}/${totalTiles}`);
          }
        }

        addStatusLog('info', 'Histogram: computing statistics (GPU)...');
        const hists = {};
        let hasAnyStats = false;
        for (const ch of ['R', 'G', 'B']) {
          const arr = rawValues[ch] instanceof Float32Array ? rawValues[ch] : new Float32Array(rawValues[ch]);
          hists[ch] = await computeChannelStatsAuto(arr, useDecibels);
          if (hists[ch]) hasAnyStats = true;
        }
        if (hasAnyStats) {
          setHistogramData(hists);
          addStatusLog('success', `${scopeLabel} histogram updated (RGB, ${useDecibels ? 'dB' : 'linear'})`);
        } else {
          addStatusLog('info', `${scopeLabel} histogram: no valid pixels in region`);
        }
      } else {
        // Single-band histogram — pass origin offset for correct viewport sampling
        console.log('[histogram] single-band path: region', { regionX, regionY, regionW, regionH }, 'useDecibels:', useDecibels);
        const stats = await sampleViewportStats(
          imageData.getTile, regionW, regionH, useDecibels, 128,
          regionX, regionY, imageData.height,
          (done, total) => addStatusLog('info', `Histogram: sampling tile ${done}/${total}`),
        );
        console.log('[histogram] single-band stats:', stats ? { p2: stats.p2, p98: stats.p98, count: stats.count } : null);
        if (stats) {
          console.log('[histogram] CALLING setHistogramData, new min:', stats.min.toFixed(2), 'max:', stats.max.toFixed(2), 'count:', stats.count);
          setHistogramData({ single: stats });
          addStatusLog('success', `${scopeLabel} histogram: ${stats.p2.toFixed(1)} to ${stats.p98.toFixed(1)}`);
        } else {
          console.log('[histogram] single-band: no stats returned');
        }
      }
    } catch (e) {
      console.error('[histogram] recompute error:', e);
      addStatusLog('warning', 'Histogram recompute failed', e.message);
    }
  }, [imageData, histogramScope, viewCenter, viewZoom, displayMode, compositeId, useDecibels, roi, addStatusLog]);

  // Recompute histogram when scope changes
  useEffect(() => {
    if (imageData) recomputeRef.current();
  }, [histogramScope, imageData]);

  // Auto-show histogram overlay when histogram data becomes available
  useEffect(() => {
    if (histogramData) setShowHistogramOverlay(true);
  }, [histogramData]);

  // Fall back to global scope if ROI is cleared while in ROI scope
  useEffect(() => {
    if (!roi && histogramScope === 'roi') setHistogramScope('global');
  }, [roi, histogramScope]);

  // Auto-recompute histogram when viewport changes (viewport scope, debounced)
  const recomputeRef = useRef(handleRecomputeHistogram);
  recomputeRef.current = handleRecomputeHistogram;
  const vcx = viewCenter[0];
  const vcy = viewCenter[1];
  useEffect(() => {
    if (!imageData || !showHistogramOverlay || histogramScope !== 'viewport') return;
    const timer = setTimeout(() => {
      recomputeRef.current();
    }, 800);
    return () => clearTimeout(timer);
  }, [vcx, vcy, viewZoom, imageData, showHistogramOverlay, histogramScope]);

  // Auto-recompute histogram when ROI changes (ROI scope only)
  useEffect(() => {
    if (!imageData || !roi || histogramScope !== 'roi') return;
    const timer = setTimeout(() => {
      recomputeRef.current();
    }, 300);
    return () => clearTimeout(timer);
  }, [roi, imageData, histogramScope]);

  // Recompute histogram when switching between dB and linear mode
  const useDecibelsRef = useRef(useDecibels);
  useEffect(() => {
    if (useDecibels !== useDecibelsRef.current) {
      useDecibelsRef.current = useDecibels;
      // Recompute histogram in the new scale (both single-band and RGB)
      if (imageData) {
        handleRecomputeHistogram();
      }
    }
  }, [useDecibels, imageData, handleRecomputeHistogram]);

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
    dataset: fileType === 'nisar' ? { frequency: selectedFrequency, polarization: selectedPolarization } : null,
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

    // Validate URL format
    try {
      new URL(cogUrl);
    } catch {
      setError('Invalid URL format. Please enter a valid HTTP(S) URL.');
      addStatusLog('error', `Invalid URL: ${cogUrl}`);
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

      // Auto-calculate contrast limits from a sample
      try {
        addStatusLog('info', 'Calculating auto-contrast from sample data...');

        // Load a small sample from a middle overview for contrast calculation
        const sampleOverview = Math.min(2, metadata.imageCount - 1);
        const sampleData = await loadCOGFullImage(cogUrl, 512);

        if (sampleData && sampleData.data) {
          const limits = autoContrastLimits(sampleData.data, useDecibels);
          setContrastMin(Math.round(limits[0]));
          setContrastMax(Math.round(limits[1]));
          addStatusLog('success', 'Auto-contrast calculated',
            `Range: ${limits[0].toFixed(2)} to ${limits[1].toFixed(2)}${useDecibels ? ' dB' : ''}`);
        } else {
          addStatusLog('warning', 'No data available for contrast calculation');
        }
      } catch (e) {
        addStatusLog('warning', 'Could not auto-calculate contrast limits', e.message);
        console.warn('Could not auto-calculate contrast limits:', e);
      }

      // Update view to fit bounds
      if (data.bounds) {
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

      addStatusLog('success', 'COG loaded and ready to display');
    } catch (e) {
      setError(`Failed to load COG: ${e.message}`);
      setImageData(null);
      addStatusLog('error', 'Failed to load COG', e.message);
      console.error('COG loading error:', e);
    } finally {
      setLoading(false);
    }
  }, [cogUrl, useDecibels, addStatusLog, multiFileMode, multiFileModeType, fileList, bandNames]);

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

  // Handle NISAR file selection - read metadata to get available datasets
  const handleNISARFileSelect = useCallback(async (file) => {
    if (!file) return;

    setNisarFile(file);
    setNisarDatasets([]);
    setLoading(true);
    setError(null);
    addStatusLog('info', `Reading NISAR GCOV metadata from: ${file.name}`);

    try {
      const datasets = await listNISARDatasets(file);
      setNisarDatasets(datasets);

      // Set defaults to first available dataset
      if (datasets.length > 0) {
        setSelectedFrequency(datasets[0].frequency);
        setSelectedPolarization(datasets[0].polarization);
      }

      // Compute available composites and auto-select
      const composites = getAvailableComposites(datasets);
      setAvailableComposites(composites);

      // Pre-select a composite for when the user switches to RGB mode,
      // but always default to single-band display
      const autoComposite = autoSelectComposite(datasets);
      setCompositeId(autoComposite);
      setDisplayMode('single');

      if (autoComposite) {
        addStatusLog('info', `RGB composite available: ${composites.find(c => c.id === autoComposite)?.name || autoComposite}`);
      }

      addStatusLog('success', `Found ${datasets.length} datasets`,
        datasets.map(d => `${d.frequency}/${d.polarization}`).join(', '));
    } catch (e) {
      setError(`Failed to read NISAR file: ${e.message}`);
      addStatusLog('error', 'Failed to read NISAR metadata', e.message);
    } finally {
      setLoading(false);
    }
  }, [addStatusLog]);

  // Handle local TIF file selection (single or multi-select mosaic)
  const handleLocalTIFMultiSelect = useCallback(async (files) => {
    if (!files || files.length === 0) return;

    setLoading(true);
    setLoadProgress(0);
    setError(null);
    const names = files.map(f => f.name);
    addStatusLog('info', `Loading ${files.length} local GeoTIFF${files.length > 1 ? 's' : ''}: ${names.join(', ')}`);

    try {
      const gen = ++loadGenRef.current;
      const data = await loadLocalTIFs(files, (pct) => setLoadProgress(pct));
      if (gen !== loadGenRef.current) return;

      setImageData(data);
      const label = data.sliceCount > 1
        ? `Mosaic: ${data.sliceCount} slices, ${data.width}x${data.height} px`
        : `Loaded: ${data.width}x${data.height} px`;
      addStatusLog('success', label);

      // Auto-contrast with dB detection
      try {
        const sampleData = data.data;
        if (sampleData) {
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
            ? vals.map(v => 10 * Math.log10(Math.max(v, 1e-10)))
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
        }
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
  }, [addStatusLog, autoFitIfNewScene]);

  // Handle remote file selection from DataDiscovery browser
  const handleRemoteFileSelect = useCallback(async (fileInfo) => {
    const { url, name, size, type } = fileInfo;
    addStatusLog('info', `Remote file selected: ${name}`);

    if (type === 'cog') {
      // Load as COG directly
      setCogUrl(url);
      setFileType('cog');
      addStatusLog('info', `Loading COG from: ${url}`);
      return;
    }

    // NISAR HDF5 — stream from URL
    setRemoteUrl(url);
    setRemoteName(name);
    setNisarDatasets([]);
    setLoading(true);
    setError(null);

    try {
      addStatusLog('info', `Streaming NISAR metadata from: ${name}`);
      const result = await listNISARDatasetsFromUrl(url);
      const datasets = result.datasets || result;
      // Store the stream reader to reuse when loading (avoids re-downloading metadata)
      if (result._streamReader) {
        handleRemoteFileSelect._cachedReader = result._streamReader;
      }
      setNisarDatasets(datasets);

      if (datasets.length > 0) {
        setSelectedFrequency(datasets[0].frequency);
        setSelectedPolarization(datasets[0].polarization);
      }

      const composites = getAvailableComposites(datasets);
      setAvailableComposites(composites);
      const autoComp = autoSelectComposite(datasets);
      setCompositeId(autoComp);
      setDisplayMode('single');

      addStatusLog('success', `Found ${datasets.length} remote datasets`,
        datasets.map(d => `${d.frequency}/${d.polarization}`).join(', '));
    } catch (e) {
      setError(`Failed to read remote NISAR file: ${e.message}`);
      addStatusLog('error', 'Remote metadata read failed', e.message);
    } finally {
      setLoading(false);
    }
  }, [addStatusLog]);

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

    handleRemoteFileSelect({ url, name, size: 0, type });
  }, [directUrl, handleRemoteFileSelect, addStatusLog]);

  // Load remote NISAR dataset by URL (single band or RGB composite)
  const handleLoadRemoteNISAR = useCallback(async () => {
    if (!remoteUrl) return;
    const gen = ++loadGenRef.current;

    setLoading(true);
    setError(null);

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
      } else {
        // Single band mode
        addStatusLog('info', `Loading remote NISAR: ${selectedFrequency}/${selectedPolarization}`);

        data = await loadNISARGCOVFromUrl(remoteUrl, {
          frequency: selectedFrequency,
          polarization: selectedPolarization,
          _streamReader: handleRemoteFileSelect._cachedReader || null,
        });

        // Progressive refinement: when background Phase 2 completes, bump version
        // so SARViewer re-creates its TileLayer and fetches the refined tiles.
        if (data.mode === 'streaming') {
          data.onRefine = () => setTileVersion(v => v + 1);
          // Eagerly warm chunk cache (fire-and-forget — tiles use coarse mosaic
          // from cached chunks while remaining chunks load in background)
          if (data.prefetchOverviewChunks) {
            data.prefetchOverviewChunks().catch(e =>
              console.warn('[SARdine] Overview prefetch failed:', e.message)
            );
          }
        }

        addStatusLog('success', `Remote NISAR loaded: ${data.width}×${data.height}`,
          `URL: ${remoteUrl}`);
      }

      if (gen !== loadGenRef.current) return; // stale load
      setImageData(data);

      // Auto-fit view only if this is a new scene (different track-frame)
      autoFitIfNewScene(data.bounds);

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
            // Sample using world-coordinate bounds so getTile receives world-space bboxes
            const [gMinX, gMinY, gMaxX, gMaxY] = data.bounds;
            const stats = await sampleViewportStats(
              data.getTile, gMaxX - gMinX, gMaxY - gMinY, useDecibels, 128,
              gMinX, gMinY,
            );
            if (stats) {
              setHistogramData({ single: stats });
              setContrastMin(Number(stats.p2.toFixed(useDecibels ? 1 : 3)));
              setContrastMax(Number(stats.p98.toFixed(useDecibels ? 1 : 3)));
              const unit = useDecibels ? 'dB' : '';
              addStatusLog('success', `Auto-contrast: ${stats.p2.toFixed(useDecibels ? 1 : 3)} to ${stats.p98.toFixed(useDecibels ? 1 : 3)} ${unit}`);
            }
          } catch (e) {
            addStatusLog('warning', 'Background histogram failed', e.message);
          }
        })();
      }
    } catch (e) {
      setError(`Failed to load remote NISAR: ${e.message}`);
      addStatusLog('error', 'Remote load failed', e.message);
    } finally {
      setLoading(false);
    }
  }, [remoteUrl, selectedFrequency, selectedPolarization, displayMode, compositeId, useDecibels, addStatusLog, autoFitIfNewScene]);

  // Load selected NISAR dataset (single band or RGB composite)
  const handleLoadNISAR = useCallback(async () => {
    if (!nisarFile) {
      setError('Please select a NISAR GCOV HDF5 file');
      addStatusLog('error', 'No NISAR file selected');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let data;

      if (displayMode === 'rgb' && compositeId) {
        // RGB composite mode
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
        // Single band mode
        addStatusLog('info', `Loading NISAR dataset: ${selectedFrequency}/${selectedPolarization}`);

        data = await loadNISARGCOV(nisarFile, {
          frequency: selectedFrequency,
          polarization: selectedPolarization,
        });

        addStatusLog('success', 'NISAR dataset loaded',
          `${data.width}x${data.height}, CRS: ${data.crs}`);

        // Use embedded statistics for auto-contrast if available
        if (data.stats && data.stats.mean_value !== undefined) {
          const { mean_value, sample_stddev } = data.stats;
          if (mean_value > 0 && sample_stddev > 0) {
            const meanDb = 10 * Math.log10(mean_value);
            const stdDb = Math.abs(10 * Math.log10(sample_stddev / mean_value));
            setContrastMin(Math.round(meanDb - 2 * stdDb));
            setContrastMax(Math.round(meanDb + 2 * stdDb));
            addStatusLog('info', 'Auto-contrast from HDF5 statistics',
              `${(meanDb - 2 * stdDb).toFixed(1)} to ${(meanDb + 2 * stdDb).toFixed(1)} dB`);
          }
        }
      }

      setImageData(data);

      // Auto-fit view only if this is a new scene (different track-frame)
      autoFitIfNewScene(data.bounds);

      // Compute histograms for per-channel contrast
      try {
        if (displayMode === 'rgb' && data.getRGBTile) {
          addStatusLog('info', 'Computing per-channel histograms (linear)...');
          const tileSize = 256;
          const gridSize = 3;
          // Use world-coordinate bounds for bbox sampling
          const [rgbMinX, rgbMinY, rgbMaxX, rgbMaxY] = data.bounds;
          const stepX = (rgbMaxX - rgbMinX) / gridSize;
          const stepY = (rgbMaxY - rgbMinY) / gridSize;
          const rawValues = { R: [], G: [], B: [] };

          for (let ty = 0; ty < gridSize; ty++) {
            for (let tx = 0; tx < gridSize; tx++) {
              const left = rgbMinX + tx * stepX;
              const right = rgbMinX + (tx + 1) * stepX;
              // OrthographicView bbox: top = min Y (south), bottom = max Y (north)
              const top = rgbMinY + ty * stepY;
              const bottom = rgbMinY + (ty + 1) * stepY;

              const tileData = await data.getRGBTile({
                x: tx, y: ty, z: 0,
                bbox: { left, top, right, bottom },
              });

              if (tileData && tileData.bands) {
                const rgbBands = computeRGBBands(tileData.bands, compositeId, tileSize);
                for (const ch of ['R', 'G', 'B']) {
                  const arr = rgbBands[ch];
                  // Subsample every 4th pixel for efficiency
                  for (let i = 0; i < arr.length; i += 4) {
                    if (arr[i] > 0 && !isNaN(arr[i])) rawValues[ch].push(arr[i]);
                  }
                }
              }
            }
          }

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
          setUseDecibels(false); // Linear for RGB composites
          addStatusLog('success', 'Per-channel contrast set (linear 2–98%)',
            ['R', 'G', 'B'].map(ch => hists[ch] ? `${ch}: ${lims[ch][0].toExponential(2)}–${lims[ch][1].toExponential(2)}` : '').join(', '));
        } else if (data.getTile) {
          addStatusLog('info', 'Computing histogram from tile samples...');
          // Sample using world-coordinate bounds so getTile receives world-space bboxes
          const [hMinX, hMinY, hMaxX, hMaxY] = data.bounds;
          const stats = await sampleViewportStats(
            data.getTile, hMaxX - hMinX, hMaxY - hMinY, useDecibels, 128,
            hMinX, hMinY,
          );
          if (stats) {
            setHistogramData({ single: stats });
            // Keep decimal precision for dB values (don't round)
            setContrastMin(Number(stats.p2.toFixed(useDecibels ? 1 : 3)));
            setContrastMax(Number(stats.p98.toFixed(useDecibels ? 1 : 3)));
            const unit = useDecibels ? 'dB' : '';
            addStatusLog('success', `Auto-contrast from 2–98%: ${stats.p2.toFixed(useDecibels ? 1 : 3)} to ${stats.p98.toFixed(useDecibels ? 1 : 3)} ${unit}`);
          }
        }
      } catch (e) {
        addStatusLog('warning', 'Could not compute histogram', e.message);
      }

      addStatusLog('success', 'NISAR GCOV loaded and ready to display');
    } catch (e) {
      setError(`Failed to load NISAR dataset: ${e.message}`);
      setImageData(null);
      addStatusLog('error', 'Failed to load NISAR dataset', e.message);
      console.error('NISAR loading error:', e);
    } finally {
      setLoading(false);
    }
  }, [nisarFile, selectedFrequency, selectedPolarization, displayMode, compositeId, addStatusLog, autoFitIfNewScene]);

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
    console.log('[Export] GeoTIFF export started');

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
      // Count complete multilook windows from the grid-aligned start to the ROI right/bottom edge.
      // Using floor(right/ml) - floor(left/ml) avoids under-counting when ROI edges
      // don't align to the multilook grid (the previous floor(width/ml) formula missed
      // valid windows straddling the alignment boundary).
      const roiEndCol = roiActive
        ? Math.floor(Math.min(roiClamped.left + roiClamped.width, sourceWidth) / effectiveMl)
        : Math.floor(sourceWidth / effectiveMl);
      const roiEndRow = roiActive
        ? Math.floor(Math.min(roiClamped.top + roiClamped.height, sourceHeight) / effectiveMl)
        : Math.floor(sourceHeight / effectiveMl);
      const exportWidth = roiEndCol - roiStartCol;
      const exportHeight = roiEndRow - roiStartRow;

      // Guard against zero-size exports (ROI smaller than multilook window)
      if (exportWidth < 1 || exportHeight < 1) {
        addStatusLog('error', `ROI too small for multilook ${effectiveMl}x${effectiveMl}. ` +
          `Need at least ${effectiveMl}x${effectiveMl} pixels, got ${roiClamped?.width || 0}x${roiClamped?.height || 0}.`);
        setExporting(false);
        return;
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
        if (displayMode === 'rgb' && compositeId && effectiveContrastLimits && !Array.isArray(effectiveContrastLimits)) {
          const limStr = ['R', 'G', 'B'].map(ch => {
            const lim = effectiveContrastLimits[ch];
            return lim ? `${ch}:[${lim[0].toExponential(1)},${lim[1].toExponential(1)}]` : '';
          }).filter(Boolean).join(' ');
          addStatusLog('info', `Render: composite="${compositeId}", ${useDecibels ? 'dB' : 'linear'}, per-channel ${limStr}, ${stretchMode}, gamma=${gamma}`);
        } else {
          addStatusLog('info', `Render: ${useDecibels ? 'dB' : 'linear'}, contrast [${contrastMin}, ${contrastMax}], ${colormap}, ${stretchMode}, gamma=${gamma}`);
        }
        addStatusLog('info', `Format: GeoTIFF (RGBA uint8, 512x512 tiles, DEFLATE)`);
      } else {
        addStatusLog('info', `Format: GeoTIFF (Float32, 512x512 tiles, DEFLATE)`);
      }

      // Allocate output arrays for each band (power + complex)
      const bands = {};
      const allBandNames = [...bandNames, ...complexBandNames];
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

        // Copy stripe data into output arrays (power + complex bands)
        for (const name of allBandNames) {
          if (stripe.bands[name]) {
            bands[name].set(stripe.bands[name], startRow * exportWidth);
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
              useDecibels, gamma, stretchMode,
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
          addStatusLog('info', `Applying ${useDecibels ? 'dB' : 'linear'} + ${colormap} colormap...`);
          const colormapFunc = getColormap(colormap);
          const cMin = contrastMin;
          const cMax = contrastMax;
          const needsStretch = stretchMode !== 'linear' || gamma !== 1.0;
          const rgbaData = new Uint8ClampedArray(numPixels * 4);
          const bandData = bands[bandNames[0]];

          for (let i = 0; i < numPixels; i++) {
            const amplitude = bandData[i];
            let value;
            if (useDecibels) {
              const db = 10 * Math.log10(Math.max(amplitude, 1e-10));
              value = (db - cMin) / (cMax - cMin);
            } else {
              value = (amplitude - cMin) / (cMax - cMin);
            }
            value = Math.max(0, Math.min(1, value));
            if (needsStretch) value = applyStretch(value, stretchMode, gamma);
            const [r, g, b] = colormapFunc(value);
            rgbaData[i * 4] = r;
            rgbaData[i * 4 + 1] = g;
            rgbaData[i * 4 + 2] = b;
            rgbaData[i * 4 + 3] = (amplitude === 0 || isNaN(amplitude)) ? 0 : 255;
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
  }, [imageData, exportMultilookWindow, exportMode, contrastMin, contrastMax, useDecibels, colormap, stretchMode, gamma, displayMode, compositeId, effectiveContrastLimits, roi, addStatusLog]);

  // Save current view as PNG figure with overlays
  const handleSaveFigure = useCallback(async () => {
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
      const blob = await exportFigure(glCanvas, {
        colormap,
        contrastLimits: effectiveContrastLimits,
        useDecibels,
        compositeId: displayMode === 'rgb' ? compositeId : null,
        viewState: vs,
        bounds: imageData?.bounds,
        filename: fileType === 'nisar' ? nisarFile?.name : cogUrl,
        crs: imageData?.crs || '',
        histogramData: showHistogramOverlay ? histogramData : null,
        polarization: selectedPolarization,
        identification: imageData?.identification || null,
      });

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const figName = `sardine_figure_${ts}.png`;
      downloadBlob(blob, figName);
      addStatusLog('success', `Figure saved: ${figName}`);

      // Force deck.gl to re-render so the canvas doesn't stay blank
      viewerRef.current.redraw();
    } catch (e) {
      addStatusLog('error', 'Figure export failed', e.message);
      console.error('Figure export error:', e);
    }
  }, [colormap, effectiveContrastLimits, useDecibels, displayMode, compositeId, imageData, fileType, nisarFile, cogUrl, addStatusLog, showHistogramOverlay, histogramData, selectedPolarization]);

  // Enhanced figure export — captures all overlays (ROI box, profile plots, pixel explorer)
  const handleSaveFigureWithOverlays = useCallback(async () => {
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
      const blob = await exportFigureWithOverlays(glCanvas, {
        colormap,
        contrastLimits: effectiveContrastLimits,
        useDecibels,
        compositeId: displayMode === 'rgb' ? compositeId : null,
        viewState: vs,
        bounds: imageData?.bounds,
        filename: fileType === 'nisar' ? nisarFile?.name : cogUrl,
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
      });

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const figName = `sardine_figure_${ts}.png`;
      downloadBlob(blob, figName);
      addStatusLog('success', `Figure with overlays saved: ${figName}`);

      viewerRef.current.redraw();
    } catch (e) {
      addStatusLog('error', 'Figure export failed', e.message);
      console.error('Figure export error:', e);
    }
  }, [colormap, effectiveContrastLimits, useDecibels, displayMode, compositeId, imageData, fileType, nisarFile, cogUrl, roi, roiProfile, profileShow, addStatusLog, showHistogramOverlay, histogramData, selectedPolarization, classifierOpen, classificationMap, classRegions, classifierRoiDims]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
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
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSaveFigure, handleSaveFigureWithOverlays, roi]);

  const handleExportColorbar = useCallback(async () => {
    if (displayMode !== 'rgb' || !compositeId) {
      addStatusLog('error', 'Colorbar export requires RGB composite mode');
      return;
    }

    try {
      const blob = await exportRGBColorbar({
        compositeId,
        contrastLimits: effectiveContrastLimits,
        useDecibels,
        stretchMode,
        gamma,
      });

      if (!blob) {
        addStatusLog('error', 'Failed to generate colorbar');
        return;
      }

      const filename = `colorbar_${compositeId}.png`;
      downloadBlob(blob, filename);
      addStatusLog('success', `Colorbar saved: ${filename}`);
    } catch (e) {
      addStatusLog('error', 'Colorbar export failed', e.message);
      console.error('Colorbar export error:', e);
    }
  }, [compositeId, effectiveContrastLimits, useDecibels, stretchMode, gamma, displayMode, addStatusLog]);

  // Reload/restart current rendering
  const handleReload = useCallback(() => {
    if (!imageData) {
      addStatusLog('warning', 'No data loaded to reload');
      return;
    }

    addStatusLog('info', 'Reloading current view...');

    // Force re-render by clearing and re-loading
    setImageData(null);
    setHistogramData(null);

    // Trigger re-load after a short delay
    setTimeout(() => {
      if (fileType === 'nisar' && nisarFile) {
        // Re-trigger NISAR load by updating a dependency
        setSelectedFrequency(prev => prev); // Force useEffect re-run
      } else if (fileType === 'cog' && cogUrl) {
        // Re-trigger COG load
        setCogUrl(prev => prev);
      }
      addStatusLog('success', 'Reload triggered');
    }, 100);
  }, [imageData, fileType, nisarFile, cogUrl, addStatusLog]);

  // Fetch Overture features when viewport changes (debounced)
  useEffect(() => {
    if (!overtureEnabled || overtureThemes.length === 0) return;

    // Clear previous debounce
    if (overtureDebounceRef.current) {
      clearTimeout(overtureDebounceRef.current);
    }

    overtureDebounceRef.current = setTimeout(async () => {
      try {
        setOvertureLoading(true);

        let wgs84Bbox;

        if (imageData) {
          // Calculate viewport bbox in pixel/projected coordinates
          const vpHalfW = (imageData.width / Math.pow(2, viewZoom)) * 500;
          const vpHalfH = (imageData.height / Math.pow(2, viewZoom)) * 500;
          const cx = viewCenter[0];
          const cy = viewCenter[1];

          const projBbox = [
            cx - vpHalfW,
            cy - vpHalfH,
            cx + vpHalfW,
            cy + vpHalfH,
          ];

          // Convert to WGS84 for Overture queries
          const crs = imageData.crs || 'EPSG:4326';
          wgs84Bbox = projectedToWGS84(
            imageData.worldBounds || projBbox,
            crs
          );
        } else {
          // No imageData (STAC mode) - compute bbox from viewCenter/viewZoom
          const cx = viewCenter[0];
          const cy = viewCenter[1];
          const span = 360 / Math.pow(2, viewZoom + 1);
          // Clamp latitude to avoid poles (Web Mercator limit)
          const minLat = Math.max(-85, cy - span/2);
          const maxLat = Math.min(85, cy + span/2);
          wgs84Bbox = [cx - span/2, minLat, cx + span/2, maxLat];
        }

        addStatusLog('info', `Fetching Overture data: [${wgs84Bbox.map(b => b.toFixed(4)).join(', ')}]`);

        const data = await fetchAllOvertureThemes(overtureThemes, wgs84Bbox, {
          onProgress: (pct) => {
            if (pct === 100) addStatusLog('info', 'Overture fetch complete');
          },
        });

        setOvertureData(data);

        const totalFeatures = Object.values(data).reduce(
          (sum, fc) => sum + (fc.features?.length || 0), 0
        );
        addStatusLog('success', `Overture: ${totalFeatures} features loaded`);
      } catch (e) {
        addStatusLog('warning', 'Overture fetch failed', e.message);
      } finally {
        setOvertureLoading(false);
      }
    }, 800); // 800ms debounce

    return () => {
      if (overtureDebounceRef.current) {
        clearTimeout(overtureDebounceRef.current);
      }
    };
  }, [overtureEnabled, overtureThemes, viewCenter, viewZoom, imageData, addStatusLog]);

  // Build Overture overlay layers for deck.gl
  const overtureLayers = useMemo(() => {
    if (!overtureEnabled || !overtureData) return [];
    const crs = imageData?.crs || 'EPSG:4326';
    return createOvertureLayers(overtureData, { opacity: overtureOpacity, crs });
  }, [overtureEnabled, overtureData, overtureOpacity, imageData]);

  // NOTE: Duplicate block removed — all handlers defined above
  return (
    <div id="app">
      {/* Header */}
      <div className="header">
        <h1><span className="sar">SAR</span>dine</h1>
        <span className="subtitle">SAR Data INspection and Exploration</span>
      </div>

      {/* Main Layout */}
      <div className="main-layout">
        {/* Controls Panel */}
        <div className="controls-panel">
          {/* Data Source Selection */}
          <CollapsibleSection title="Data Source">
            <div className="control-group">
              <label>Format</label>
              <select value={dataFormat} onChange={(e) => setDataFormat(e.target.value)}>
                <option value="geotiff">GeoTIFF</option>
                <option value="nisar">NISAR GCOV (HDF5)</option>
              </select>
            </div>
            <div className="control-group">
              <label>Source</label>
              <select value={dataSource} onChange={(e) => setDataSource(e.target.value)}>
                <option value="local">Local File</option>
                <option value="url">URL</option>
                <option value="s3">S3 / Remote Bucket</option>
                <option value="catalog">Scene Catalog (GeoJSON)</option>
                <option value="stac">STAC Catalog Search</option>
              </select>
            </div>
          </CollapsibleSection>

          {/* Local GeoTIFF Input */}
          {fileType === 'local-tif' && (
            <CollapsibleSection title="Load Local GeoTIFF">
              <div className="control-group">
                <label>Select one or more .tif files</label>
                <input
                  type="file"
                  accept=".tif,.tiff"
                  multiple
                  id="local-tif-input"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    if (files.length === 0) return;
                    if (files.length > 1) {
                      handleLocalTIFMultiSelect(files);
                    } else {
                      handleLocalTIFMultiSelect(files);
                    }
                  }}
                />
                <button
                  className="btn-secondary"
                  onClick={() => document.getElementById('local-tif-input').click()}
                  style={{ width: '100%' }}
                >
                  {imageData?.sliceCount > 1
                    ? `${imageData.sliceCount} files loaded - Change...`
                    : imageData?.data ? 'Change File...' : 'Choose File(s)...'}
                </button>
                {loading && loadProgress > 0 && loadProgress < 100 && (
                  <div className="progress-track" style={{ marginTop: 'var(--space-xs)' }}>
                    <div className="progress-fill" style={{ width: `${loadProgress}%`, transition: 'width 0.3s ease' }} />
                  </div>
                )}
              </div>
              {imageData?.sliceCount > 1 && (
                <div className="control-group" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Mosaic: {imageData.sliceCount} slices, {imageData.width}x{imageData.height} px
                </div>
              )}
              {imageData?.sliceNames && (
                <div className="control-group" style={{ fontSize: '0.7rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                  {imageData.sliceNames.join(', ')}
                </div>
              )}
            </CollapsibleSection>
          )}

          {/* COG URL Input */}
          {fileType === 'cog' && (
            <CollapsibleSection title="Load COG">
              <div className="control-group">
                <label>COG URL</label>
                <input
                  type="text"
                  value={cogUrl}
                  onChange={(e) => setCogUrl(e.target.value)}
                  placeholder="https://bucket.s3.amazonaws.com/image.tif"
                />
              </div>
              <button onClick={handleLoadCOG} disabled={loading}>
                {loading ? 'Loading...' : 'Load COG'}
              </button>
            </CollapsibleSection>
          )}

          {/* NISAR HDF5 Input */}
          {fileType === 'nisar' && (
            <CollapsibleSection title="Load NISAR GCOV">
              <div className="control-group">
                <label>HDF5 File</label>
                <input
                  type="file"
                  accept=".h5,.hdf5,.he5"
                  id="nisar-file-input"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      handleNISARFileSelect(file);
                    }
                  }}
                />
                <button
                  className="btn-secondary"
                  onClick={() => document.getElementById('nisar-file-input').click()}
                  style={{ width: '100%' }}
                >
                  {nisarFile ? 'Change File...' : 'Choose File...'}
                </button>
              </div>

              {nisarFile && (
                <div className="control-group" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {nisarFile.name} ({(nisarFile.size / 1e9).toFixed(2)} GB)
                </div>
              )}

              {nisarDatasets.length > 0 && (
                <>
                  <div className="control-group">
                    <label>Frequency</label>
                    <select
                      value={selectedFrequency}
                      onChange={(e) => {
                        setSelectedFrequency(e.target.value);
                        // Update polarization to first available for this frequency
                        const freqDatasets = nisarDatasets.filter(d => d.frequency === e.target.value);
                        if (freqDatasets.length > 0) {
                          setSelectedPolarization(freqDatasets[0].polarization);
                        }
                      }}
                    >
                      {[...new Set(nisarDatasets.map(d => d.frequency))].map(f => (
                        <option key={f} value={f}>Frequency {f}</option>
                      ))}
                    </select>
                  </div>

                  <div className="control-group">
                    <label>Polarization</label>
                    <select
                      value={selectedPolarization}
                      onChange={(e) => setSelectedPolarization(e.target.value)}
                    >
                      {nisarDatasets
                        .filter(d => d.frequency === selectedFrequency)
                        .map(d => (
                          <option key={d.polarization} value={d.polarization}>
                            {d.polarization}
                          </option>
                        ))}
                    </select>
                  </div>

                  {/* Display Mode */}
                  <div className="control-group">
                    <label>Display Mode</label>
                    <select
                      value={displayMode}
                      onChange={(e) => setDisplayMode(e.target.value)}
                    >
                      <option value="single">Single Band</option>
                      <option value="rgb" disabled={availableComposites.length === 0}>
                        RGB Composite
                      </option>
                    </select>
                  </div>

                  {/* Composite preset selector (only in RGB mode) */}
                  {displayMode === 'rgb' && availableComposites.length > 0 && (
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
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {availableComposites.find(c => c.id === compositeId)?.description || ''}
                      </div>
                    </div>
                  )}

                  <button onClick={handleLoadNISAR} disabled={loading}>
                    {loading ? 'Loading...' : displayMode === 'rgb' ? 'Load RGB Composite' : 'Load Dataset'}
                  </button>
                </>
              )}
            </CollapsibleSection>
          )}

          {/* Remote Bucket Browser */}
          {fileType === 'remote' && (
            <CollapsibleSection title="Browse Remote Data">
              {/* Direct URL input (pre-signed S3, HTTPS) */}
              <div className="control-group">
                <label>Direct URL</label>
                <input
                  type="text"
                  value={directUrl}
                  onChange={(e) => setDirectUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleDirectUrlSubmit(); }}
                  placeholder="https://…/NISAR_*.h5?X-Amz-Signature=…"
                  style={{ fontFamily: 'monospace', fontSize: '0.7rem' }}
                />
              </div>
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

              {/* Show dataset selectors when remote NISAR metadata is loaded */}
              {remoteUrl && nisarDatasets.length > 0 && (
                <>
                  <div className="control-group" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '8px' }}>
                    🛰️ {remoteName}
                  </div>

                  <div className="control-group">
                    <label>Frequency</label>
                    <select
                      value={selectedFrequency}
                      onChange={(e) => {
                        setSelectedFrequency(e.target.value);
                        const freqDs = nisarDatasets.filter(d => d.frequency === e.target.value);
                        if (freqDs.length > 0) setSelectedPolarization(freqDs[0].polarization);
                      }}
                    >
                      {[...new Set(nisarDatasets.map(d => d.frequency))].map(f => (
                        <option key={f} value={f}>Frequency {f}</option>
                      ))}
                    </select>
                  </div>

                  <div className="control-group">
                    <label>Polarization</label>
                    <select
                      value={selectedPolarization}
                      onChange={(e) => setSelectedPolarization(e.target.value)}
                    >
                      {nisarDatasets
                        .filter(d => d.frequency === selectedFrequency)
                        .map(d => (
                          <option key={d.polarization} value={d.polarization}>
                            {d.polarization}
                          </option>
                        ))}
                    </select>
                  </div>

                  {/* Display Mode (Single / RGB) */}
                  <div className="control-group">
                    <label>Display Mode</label>
                    <select
                      value={displayMode}
                      onChange={(e) => setDisplayMode(e.target.value)}
                    >
                      <option value="single">Single Band</option>
                      <option value="rgb" disabled={availableComposites.length === 0}>
                        RGB Composite
                      </option>
                    </select>
                  </div>

                  {/* Composite preset selector (only in RGB mode) */}
                  {displayMode === 'rgb' && availableComposites.length > 0 && (
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
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {availableComposites.find(c => c.id === compositeId)?.description || ''}
                      </div>
                    </div>
                  )}

                  <button onClick={handleLoadRemoteNISAR} disabled={loading}>
                    {loading ? 'Loading...' : displayMode === 'rgb' ? 'Load RGB Composite' : 'Load Remote Dataset'}
                  </button>
                </>
              )}
            </CollapsibleSection>
          )}

          {/* Scene Catalog (GeoJSON) */}
          {fileType === 'catalog' && (
            <CollapsibleSection title="Scene Catalog">
              <SceneCatalog
                onSelectScene={(sceneInfo) => {
                  // Route scene selection through the existing remote loader
                  handleRemoteFileSelect({
                    url: sceneInfo.url,
                    name: sceneInfo.name,
                    size: sceneInfo.size || 0,
                    type: sceneInfo.type || 'nisar',
                  });
                }}
                onStatus={addStatusLog}
                onLayersChange={setCatalogLayers}
              />

              {/* Show dataset selectors when remote NISAR metadata is loaded (reuse remote pattern) */}
              {remoteUrl && nisarDatasets.length > 0 && (
                <>
                  <div className="control-group" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '8px' }}>
                    {remoteName}
                  </div>

                  <div className="control-group">
                    <label>Frequency</label>
                    <select
                      value={selectedFrequency}
                      onChange={(e) => {
                        setSelectedFrequency(e.target.value);
                        const freqDs = nisarDatasets.filter(d => d.frequency === e.target.value);
                        if (freqDs.length > 0) setSelectedPolarization(freqDs[0].polarization);
                      }}
                    >
                      {[...new Set(nisarDatasets.map(d => d.frequency))].map(f => (
                        <option key={f} value={f}>Frequency {f}</option>
                      ))}
                    </select>
                  </div>

                  <div className="control-group">
                    <label>Polarization</label>
                    <select
                      value={selectedPolarization}
                      onChange={(e) => setSelectedPolarization(e.target.value)}
                    >
                      {nisarDatasets
                        .filter(d => d.frequency === selectedFrequency)
                        .map(d => (
                          <option key={d.polarization} value={d.polarization}>
                            {d.polarization}
                          </option>
                        ))}
                    </select>
                  </div>

                  {/* Display Mode (Single / RGB) */}
                  <div className="control-group">
                    <label>Display Mode</label>
                    <select
                      value={displayMode}
                      onChange={(e) => setDisplayMode(e.target.value)}
                    >
                      <option value="single">Single Band</option>
                      <option value="rgb" disabled={availableComposites.length === 0}>
                        RGB Composite
                      </option>
                    </select>
                  </div>

                  {displayMode === 'rgb' && availableComposites.length > 0 && (
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
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {availableComposites.find(c => c.id === compositeId)?.description || ''}
                      </div>
                    </div>
                  )}

                  <button onClick={handleLoadRemoteNISAR} disabled={loading}>
                    {loading ? 'Loading...' : displayMode === 'rgb' ? 'Load RGB Composite' : 'Load Dataset'}
                  </button>
                </>
              )}
            </CollapsibleSection>
          )}

          {/* STAC Catalog Search */}
          {fileType === 'stac' && (
            <CollapsibleSection title="STAC Catalog Search">
              <STACSearch
                onSelectScene={(sceneInfo) => {
                  handleRemoteFileSelect({
                    url: sceneInfo.url,
                    name: sceneInfo.name,
                    size: sceneInfo.size || 0,
                    type: sceneInfo.type || 'nisar',
                  });
                }}
                onSelectMultiple={async ({ scenes, mode }) => {
                  // Route multi-select to existing multi-file COG loaders
                  const cogScenes = scenes.filter(s => s.type === 'cog');
                  const nisarScenes = scenes.filter(s => s.type === 'nisar');

                  if (cogScenes.length >= 2) {
                    // Load COGs via existing multi-file pipeline
                    const urls = cogScenes.map(s => s.url);
                    const names = cogScenes.map(s => s.name);
                    addStatusLog('info', `Loading ${cogScenes.length} COGs as ${mode}`);

                    setLoading(true);
                    setError(null);
                    try {
                      let data;
                      if (mode === 'multi-band') {
                        data = await loadMultiBandCOG({ urls, bands: names });
                        addStatusLog('success', `Multi-band loaded: ${data.bandNames?.join(', ')}`);
                      } else {
                        const acquisitions = cogScenes.map(s => ({
                          url: s.url,
                          date: s.datetime || s.name,
                          label: s.name,
                        }));
                        data = await loadTemporalCOGs(acquisitions);
                        addStatusLog('success', `Temporal stack loaded: ${data.acquisitionCount} dates`);
                      }
                      setImageData(data);
                      if (data.bounds) {
                        const [minX, minY, maxX, maxY] = data.bounds;
                        setViewCenter([(minX + maxX) / 2, (minY + maxY) / 2]);
                        const span = Math.max(maxX - minX, maxY - minY);
                        setViewZoom(Math.log2(360 / span) - 1);
                      }
                    } catch (e) {
                      setError(`Multi-file load failed: ${e.message}`);
                      addStatusLog('error', 'Multi-file load failed', e.message);
                    } finally {
                      setLoading(false);
                    }
                  } else if (nisarScenes.length >= 1) {
                    // For NISAR HDF5 — load first selected, note that multi-HDF5 isn't supported yet
                    addStatusLog('info', `Loading first NISAR scene: ${nisarScenes[0].name}`);
                    if (nisarScenes.length > 1) {
                      addStatusLog('warning', `Multi-HDF5 loading not yet supported — loading first of ${nisarScenes.length}`);
                    }
                    handleRemoteFileSelect({
                      url: nisarScenes[0].url,
                      name: nisarScenes[0].name,
                      size: 0,
                      type: 'nisar',
                    });
                  } else {
                    addStatusLog('warning', 'No loadable scenes in selection');
                  }
                }}
                onStatus={addStatusLog}
                onLayersChange={setStacLayers}
                viewBounds={computedViewBounds}
                onZoomToBounds={(bbox) => {
                  const [minX, minY, maxX, maxY] = bbox;
                  setViewCenter([(minX + maxX) / 2, (minY + maxY) / 2]);
                  const span = Math.max(maxX - minX, maxY - minY);
                  setViewZoom(Math.log2(360 / span) - 1);
                }}
              />

              {/* Show dataset selectors when remote NISAR metadata is loaded */}
              {remoteUrl && nisarDatasets.length > 0 && (
                <>
                  <div className="control-group" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '8px' }}>
                    {remoteName}
                  </div>

                  <div className="control-group">
                    <label>Frequency</label>
                    <select
                      value={selectedFrequency}
                      onChange={(e) => {
                        setSelectedFrequency(e.target.value);
                        const freqDs = nisarDatasets.filter(d => d.frequency === e.target.value);
                        if (freqDs.length > 0) setSelectedPolarization(freqDs[0].polarization);
                      }}
                    >
                      {[...new Set(nisarDatasets.map(d => d.frequency))].map(f => (
                        <option key={f} value={f}>Frequency {f}</option>
                      ))}
                    </select>
                  </div>

                  <div className="control-group">
                    <label>Polarization</label>
                    <select
                      value={selectedPolarization}
                      onChange={(e) => setSelectedPolarization(e.target.value)}
                    >
                      {nisarDatasets
                        .filter(d => d.frequency === selectedFrequency)
                        .map(d => (
                          <option key={d.polarization} value={d.polarization}>
                            {d.polarization}
                          </option>
                        ))}
                    </select>
                  </div>

                  {/* Display Mode (Single / RGB) */}
                  <div className="control-group">
                    <label>Display Mode</label>
                    <select
                      value={displayMode}
                      onChange={(e) => setDisplayMode(e.target.value)}
                    >
                      <option value="single">Single Band</option>
                      <option value="rgb" disabled={availableComposites.length === 0}>
                        RGB Composite
                      </option>
                    </select>
                  </div>

                  {displayMode === 'rgb' && availableComposites.length > 0 && (
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
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {availableComposites.find(c => c.id === compositeId)?.description || ''}
                      </div>
                    </div>
                  )}

                  <button onClick={handleLoadRemoteNISAR} disabled={loading}>
                    {loading ? 'Loading...' : displayMode === 'rgb' ? 'Load RGB Composite' : 'Load Dataset'}
                  </button>
                </>
              )}
            </CollapsibleSection>
          )}

          {/* Current Session Status */}
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
                fontSize: '0.75rem',
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
                  fontSize: '0.7rem',
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
            </div>
          )}

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
                  {overtureLoading && <span style={{ marginLeft: '6px', color: 'var(--sardine-cyan)' }}>⟳</span>}
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
                          backgroundColor: `rgba(${theme.color.join(',')})`,
                          marginRight: '6px',
                          verticalAlign: 'middle',
                        }} />
                        {theme.label}
                      </label>
                    </div>
                  ))}
                </div>

                <div className="control-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
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
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    {Object.entries(overtureData).map(([key, fc]) => (
                      <div key={key}>{OVERTURE_THEMES[key]?.label}: {fc.features?.length || 0} features</div>
                    ))}
                  </div>
                )}
              </>
            )}
          </CollapsibleSection>

          {/* Display Settings */}
          <CollapsibleSection title="Display">
            
            {/* Colormap selector — hidden in RGB composite mode */}
            {sidebarDisplayMode !== 'rgb' && (
              <div className="control-group">
                <label>Colormap</label>
                <select value={colormap} onChange={(e) => setColormap(e.target.value)}>
                  <option value="grayscale">Grayscale</option>
                  <option value="sardine">SARdine</option>
                  <option value="viridis">Viridis</option>
                  <option value="inferno">Inferno</option>
                  <option value="plasma">Plasma</option>
                  <option value="phase">Phase</option>
                  <option value="flood">Flood Alert</option>
                  <option value="diverging">Diverging</option>
                  <option value="polarimetric">Polarimetric</option>
                </select>
              </div>
            )}

            <div className="control-group">
              <div className="control-row">
                <input
                  type="checkbox"
                  id="useDb"
                  checked={useDecibels}
                  onChange={(e) => setUseDecibels(e.target.checked)}
                />
                <label htmlFor="useDb">dB Scaling</label>
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
                    style={{ marginLeft: '8px', fontSize: '0.7rem', width: '55px' }}
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

            {/* Export settings */}
            {imageData && imageData.getExportStripe && (
              <div className="control-group" style={{ marginTop: '8px' }}>
                <label style={{ fontSize: '0.75rem', marginBottom: '4px', display: 'block' }}>
                  Multilook Window (Export)
                </label>
                <div style={{ display: 'flex', gap: '4px', marginBottom: '4px' }}>
                  {[1, 2, 4, 8, 16].map(size => (
                    <button
                      key={size}
                      className={exportMultilookWindow === size ? '' : 'btn-secondary'}
                      style={{ flex: 1, fontSize: '0.7rem', padding: '3px 6px' }}
                      onClick={() => setExportMultilookWindow(size)}
                      title={size === 1 ? 'No multilook (full resolution)' : `${size}×${size} averaging window`}
                    >
                      {size === 1 ? 'None' : `${size}×${size}`}
                    </button>
                  ))}
                </div>
                {imageData.pixelSpacing && (
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                    Source: {imageData.pixelSpacing.x?.toFixed(1)}m × {imageData.pixelSpacing.y?.toFixed(1)}m posting
                    {exportMultilookWindow > 1 && ` → ${(imageData.pixelSpacing.x * exportMultilookWindow).toFixed(1)}m export`}
                  </div>
                )}
              </div>
            )}

            {/* Export mode toggle */}
            {imageData && imageData.getExportStripe && (
              <div className="control-group" style={{ marginTop: '8px' }}>
                <label style={{ fontSize: '0.75rem', marginBottom: '4px', display: 'block' }}>
                  Export Data
                </label>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {[
                    { id: 'raw', label: 'Raw', desc: 'Float32 linear power — for analysis (QGIS, Python)' },
                    { id: 'rendered', label: 'Displayed', desc: 'RGBA with current dB/contrast/colormap — as seen on screen' },
                  ].map(mode => (
                    <button
                      key={mode.id}
                      className={exportMode === mode.id ? '' : 'btn-secondary'}
                      style={{ flex: 1, fontSize: '0.7rem', padding: '3px 6px' }}
                      onClick={() => setExportMode(mode.id)}
                      title={mode.desc}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {exportMode === 'raw'
                    ? 'Float32 linear power values — suitable for analysis'
                    : `RGBA with ${useDecibels ? 'dB' : 'linear'} stretch, ${colormap} colormap`}
                </div>
              </div>
            )}

            {/* ROI (Region of Interest) info */}
            {imageData && (
              <div style={{ marginTop: '8px', fontSize: '0.75rem' }}>
                {roi ? (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: 'rgba(255, 200, 50, 0.08)',
                    border: '1px solid rgba(255, 200, 50, 0.3)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '4px 8px',
                  }}>
                    <span style={{ color: '#ffc832' }}>
                      ROI: {roi.width} × {roi.height} px
                    </span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        onClick={() => setClassifierOpen(prev => !prev)}
                        title="Feature space classifier (C)"
                        style={{
                          background: classifierOpen ? 'rgba(78,201,212,0.15)' : 'none',
                          border: classifierOpen ? '1px solid rgba(78,201,212,0.4)' : '1px solid transparent',
                          color: classifierOpen ? '#4ec9d4' : 'var(--text-muted)',
                          cursor: 'pointer', padding: '0 4px', fontSize: '0.65rem', borderRadius: 3,
                        }}
                      >
                        Classify
                      </button>
                      <button
                        onClick={() => setROI(null)}
                        style={{
                          background: 'none', border: 'none', color: 'var(--text-muted)',
                          cursor: 'pointer', padding: '0 2px', fontSize: '0.7rem',
                        }}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>
                    Shift+drag on image to select ROI for export
                  </div>
                )}

                {/* Load RGB Composite into ROI */}
                {roi && nisarFile && availableComposites.length > 0 && displayMode === 'single' && (
                  <div style={{
                    marginTop: '4px', padding: '4px 8px',
                    background: 'rgba(78, 201, 212, 0.06)',
                    border: '1px solid rgba(78, 201, 212, 0.2)',
                    borderRadius: 'var(--radius-sm)',
                  }}>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <select
                        value={roiCompositeId || ''}
                        onChange={(e) => setRoiCompositeId(e.target.value || null)}
                        style={{
                          flex: 1, fontSize: '0.65rem',
                          background: 'var(--surface-2)', color: 'var(--text)',
                          border: '1px solid var(--border)',
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
                          fontSize: '0.65rem', padding: '3px 8px',
                          background: roiCompositeId ? 'rgba(78, 201, 212, 0.15)' : 'transparent',
                          border: '1px solid rgba(78, 201, 212, 0.3)',
                          color: '#4ec9d4', borderRadius: 'var(--radius-sm)',
                          cursor: roiCompositeId ? 'pointer' : 'default',
                          opacity: roiCompositeId ? 1 : 0.4,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {roiRGBLoading ? 'Loading...' : 'RGB in ROI'}
                      </button>
                    </div>
                    {roiRGBData && (
                      <div style={{ fontSize: '0.6rem', color: '#4ec9d4', marginTop: '2px' }}>
                        RGB overlay active ({roiCompositeId})
                      </div>
                    )}
                  </div>
                )}

                {/* Time-Series file input for ROI */}
                {roi && nisarFile && displayMode === 'single' && (
                  <div style={{
                    marginTop: '4px', padding: '4px 8px',
                    background: 'rgba(46, 204, 113, 0.06)',
                    border: '1px solid rgba(46, 204, 113, 0.2)',
                    borderRadius: 'var(--radius-sm)',
                  }}>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <label style={{
                        flex: 1, fontSize: '0.65rem', cursor: 'pointer',
                        color: 'var(--text-muted)',
                      }}>
                        <input
                          type="file"
                          multiple
                          accept=".h5,.hdf5"
                          style={{ display: 'none' }}
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
                          fontSize: '0.65rem', padding: '3px 8px',
                          background: roiTSFiles.length ? 'rgba(46, 204, 113, 0.15)' : 'transparent',
                          border: '1px solid rgba(46, 204, 113, 0.3)',
                          color: '#2ecc71', borderRadius: 'var(--radius-sm)',
                          cursor: roiTSFiles.length ? 'pointer' : 'default',
                          opacity: roiTSFiles.length ? 1 : 0.4,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {roiTSLoading ? 'Loading...' : 'Time Series'}
                      </button>
                    </div>
                    {roiTSFrames && (
                      <div style={{ fontSize: '0.6rem', color: '#2ecc71', marginTop: '2px' }}>
                        {roiTSFrames.length} frames loaded
                      </div>
                    )}
                  </div>
                )}

                {/* WKT ROI Input */}
                <div style={{ marginTop: '4px' }}>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <input
                      type="text"
                      value={wktInput}
                      onChange={(e) => { setWktInput(e.target.value); setWktError(null); }}
                      onKeyDown={(e) => e.key === 'Enter' && handleWktApply()}
                      placeholder="BBOX(west, south, east, north) or POLYGON(...)"
                      style={{
                        flex: 1, fontSize: '0.65rem',
                        background: 'var(--surface-2)', color: 'var(--text)',
                        border: wktError ? '1px solid #e74c3c' : '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)', padding: '3px 6px',
                        fontFamily: "'JetBrains Mono', monospace",
                      }}
                    />
                    <button
                      onClick={handleWktApply}
                      disabled={!wktInput.trim()}
                      style={{
                        fontSize: '0.65rem', padding: '3px 8px',
                        background: wktInput.trim() ? 'rgba(255, 200, 50, 0.15)' : 'transparent',
                        border: '1px solid rgba(255, 200, 50, 0.3)',
                        color: '#ffc832', borderRadius: 'var(--radius-sm)',
                        cursor: wktInput.trim() ? 'pointer' : 'default',
                        opacity: wktInput.trim() ? 1 : 0.4,
                      }}
                    >
                      Apply
                    </button>
                  </div>
                  {wktError && (
                    <div style={{ color: '#e74c3c', fontSize: '0.6rem', marginTop: '2px' }}>
                      {wktError}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Export buttons */}
            {imageData && (
              <div style={{ marginTop: '8px' }}>
                <div style={{ display: 'flex', gap: '6px' }}>
                {imageData?.getExportStripe && (
                  <button
                    onClick={handleExportGeoTIFF}
                    disabled={exporting}
                    style={{ flex: 1 }}
                  >
                    {exporting
                      ? `Exporting... ${exportProgress}%`
                      : `Export ${roi ? 'ROI ' : ''}GeoTIFF (${exportMode === 'raw' ? 'Float32' : 'Rendered'})`}
                  </button>
                )}
                <button
                  onClick={roi ? handleSaveFigureWithOverlays : handleSaveFigure}
                  style={{ flex: 1 }}
                >
                  Save Figure (PNG)
                </button>
                </div>
                {exporting && (
                  <div className="progress-track" style={{ marginTop: 'var(--space-xs)' }}>
                    <div className="progress-fill" style={{ width: `${exportProgress}%`, transition: 'width 0.3s ease' }} />
                  </div>
                )}
              </div>
            )}
            {displayMode === 'rgb' && compositeId && (
              <div style={{ marginTop: '6px' }}>
                <button
                  onClick={handleExportColorbar}
                  className="btn-secondary"
                  style={{ width: '100%', fontSize: '0.7rem', padding: '4px 8px' }}
                >
                  Export Colorbar (PNG)
                </button>
              </div>
            )}
          </CollapsibleSection>

          {/* Histogram & Contrast */}
          <CollapsibleSection title="Contrast">
            {/* Histogram scope toggle */}
            {histogramData && (
              <div className="control-group" style={{ marginBottom: '6px' }}>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {['global', 'viewport', 'roi'].map(scope => {
                    const label = scope === 'global' ? 'Global' : scope === 'viewport' ? 'Viewport' : 'ROI';
                    const disabled = scope === 'roi' && !roi;
                    return (
                      <button
                        key={scope}
                        className={histogramScope === scope ? '' : 'btn-secondary'}
                        style={{ flex: 1, fontSize: '0.7rem', padding: '3px 6px', opacity: disabled ? 0.4 : 1 }}
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
                  display: 'flex', gap: '4px', fontSize: '0.65rem',
                }}>
                  <button
                    onClick={() => setActiveViewer('main')}
                    style={{
                      flex: 1, padding: '3px 6px', borderRadius: 'var(--radius-sm)',
                      background: activeViewer === 'main' ? 'rgba(255, 200, 50, 0.15)' : 'transparent',
                      border: activeViewer === 'main' ? '1px solid rgba(255, 200, 50, 0.4)' : '1px solid var(--border)',
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
                        border: activeViewer === 'roi-rgb' ? '1px solid rgba(78, 201, 212, 0.4)' : '1px solid var(--border)',
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
                        border: activeViewer === 'roi-ts' ? '1px solid rgba(46, 204, 113, 0.4)' : '1px solid var(--border)',
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

            {/* RGB per-channel histograms (main RGB mode or ROI RGB viewer) */}
            {sidebarDisplayMode === 'rgb' && sidebarHistogramData && (
              <HistogramPanel
                histograms={sidebarHistogramData}
                mode="rgb"
                contrastLimits={sidebarIsRoiRGB
                  ? (roiRGBContrastLimits || { R: [0, 1], G: [0, 1], B: [0, 1] })
                  : (rgbContrastLimits || { R: [0, 1], G: [0, 1], B: [0, 1] })}
                useDecibels={sidebarIsRoiRGB ? false : useDecibels}
                onContrastChange={sidebarIsRoiRGB ? setRoiRGBContrastLimits : setRgbContrastLimits}
                onAutoStretch={handleAutoStretch}
                showHeader={false}
              />
            )}

            {/* Single-band histogram */}
            {sidebarDisplayMode !== 'rgb' && sidebarHistogramData?.single && (
              <HistogramPanel
                histograms={sidebarHistogramData}
                mode="single"
                contrastLimits={sidebarIsRoiTS ? roiTSContrastLimits : contrastLimits}
                useDecibels={useDecibels}
                onContrastChange={sidebarIsRoiTS
                  ? (([min, max]) => setRoiTSContrastLimits([Math.round(min), Math.round(max)]))
                  : (([min, max]) => { setContrastMin(Math.round(min)); setContrastMax(Math.round(max)); })
                }
                onAutoStretch={handleAutoStretch}
                showHeader={false}
              />
            )}

            {/* Brightness (Window/Level) slider — shifts window center (single-band only) */}
            {sidebarDisplayMode !== 'rgb' && (
              <div className="control-group">
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <label>Brightness</label>
                  <span className="value-display">
                    {Math.round((contrastMin + contrastMax) / 2)}{useDecibels ? ' dB' : ''}
                  </span>
                </div>
                <input
                  type="range"
                  min={useDecibels ? -50 : 0}
                  max={useDecibels ? 10 : 200}
                  step={1}
                  value={Math.round((contrastMin + contrastMax) / 2)}
                  onChange={(e) => {
                    const newCenter = Number(e.target.value);
                    const halfWidth = (contrastMax - contrastMin) / 2;
                    setContrastMin(Math.round(newCenter - halfWidth));
                    setContrastMax(Math.round(newCenter + halfWidth));
                  }}
                />
              </div>
            )}

            {/* Stretch mode + Gamma */}
            <div className="control-group">
              <label>Stretch</label>
              <select value={stretchMode} onChange={(e) => setStretchMode(e.target.value)}>
                {Object.entries(STRETCH_MODES).map(([id, mode]) => (
                  <option key={id} value={id}>{mode.name}</option>
                ))}
              </select>
            </div>

            {(stretchMode === 'gamma' || stretchMode === 'sigmoid') && (
              <div className="control-group">
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <label>Gamma</label>
                  <span className="value-display">{gamma.toFixed(2)}</span>
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

            {/* Multi-look toggle */}
            <div className="control-group">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  id="multiLook"
                  checked={multiLook}
                  onChange={(e) => {
                    setMultiLook(e.target.checked);
                    addStatusLog('info', e.target.checked
                      ? 'Multi-look enabled — area-averaged resampling (slower, less speckle)'
                      : 'Multi-look disabled — nearest-neighbour preview (fast)');
                  }}
                />
                <label htmlFor="multiLook" style={{ margin: 0 }}>
                  Multi-look
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '4px' }}>
                    {multiLook ? '(area avg)' : '(fast preview)'}
                  </span>
                </label>
              </div>
            </div>

            {/* Speckle filter */}
            <div className="control-group">
              <label>Speckle Filter</label>
              <select
                value={speckleFilterType}
                onChange={(e) => {
                  setSpeckleFilterType(e.target.value);
                  addStatusLog('info', e.target.value === 'none'
                    ? 'Speckle filter disabled'
                    : `Speckle filter: ${e.target.value} ${speckleKernelSize}×${speckleKernelSize}`);
                }}
              >
                <option value="none">None</option>
                {getFilterTypes().map(f => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
              {speckleFilterType !== 'none' && (
                <div style={{ marginTop: '4px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Kernel</label>
                    <span className="value-display">{speckleKernelSize}×{speckleKernelSize}</span>
                  </div>
                  <input
                    type="range"
                    min={3}
                    max={11}
                    step={2}
                    value={speckleKernelSize}
                    onChange={(e) => {
                      const ks = Number(e.target.value);
                      setSpeckleKernelSize(ks);
                      addStatusLog('info', `Speckle filter kernel: ${ks}×${ks}`);
                    }}
                  />
                </div>
              )}
            </div>

            {/* Mask toggle — only shown when mask dataset is available */}
            {imageData?.hasMask && (
              <div className="control-group">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="checkbox"
                    id="useMask"
                    checked={useMask}
                    onChange={(e) => {
                      setUseMask(e.target.checked);
                      addStatusLog('info', e.target.checked
                        ? 'Mask enabled — invalid/fill pixels hidden'
                        : 'Mask disabled — all pixels shown');
                    }}
                  />
                  <label htmlFor="useMask" style={{ margin: 0 }}>
                    Apply mask
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '4px' }}>
                      {useMask ? '(0=invalid, 255=fill)' : '(off)'}
                    </span>
                  </label>
                </div>
              </div>
            )}
          </CollapsibleSection>

          {/* NOTE: Tone Mapping UI hidden — feature only wired for SARTiledCOGLayer,
             not for HDF5/BitmapLayer/GPULayer paths. The implementation lives in
             src/utils/tone-mapping.js (adaptive log, percentile gamma, local contrast,
             scene analysis). Re-enable here once wired end-to-end for all render paths.
             See also: toneMapping state vars + useMemo below, SARTiledCOGLayer.renderTile(),
             and src/index.js tone-mapping exports. */}
        </div>

        {/* Viewer Container */}
        <div className="viewer-container" style={{ '--bottom-dock': statusCollapsed ? '32px' : '310px' }}>
          {loading && <div className="loading">Loading COG...</div>}

          {error && <div className="error">{error}</div>}

          {!loading && !error && !imageData && fileType !== 'stac' && (
            <div className="loading">
              {fileType === 'local-tif'
                ? 'Select one or more local GeoTIFF files to begin'
                : fileType === 'cog'
                ? 'Enter a Cloud Optimized GeoTIFF URL and click Load to begin'
                : fileType === 'catalog'
                  ? 'Load a GeoJSON scene catalog and select a scene to begin'
                  : 'Select a NISAR GCOV HDF5 file to begin'}
            </div>
          )}

          {(imageData || fileType === 'stac') && (
            <div style={{ display: 'flex', width: '100%', height: '100%' }}>
              {/* Main viewer (single-channel full extent) */}
              <div
                onClick={() => roiRGBData && setActiveViewer('main')}
                style={{
                  flex: 1, position: 'relative', height: '100%',
                  outline: roiRGBData && activeViewer === 'main' ? '2px solid #ffc832' : 'none',
                  outlineOffset: '-2px',
                }}>
                <SARViewer
                  ref={viewerRef}
                  cogUrl={imageData?.cogUrl}
                  getTile={imageData?.getTile}
                  tileVersion={tileVersion}
                  imageData={imageData?.data ? imageData : null}
                  bounds={imageData?.bounds || [-180, -90, 180, 90]}
                  contrastLimits={effectiveContrastLimits}
                  useDecibels={useDecibels}
                  colormap={colormap}
                  gamma={gamma}
                  stretchMode={stretchMode}
                  compositeId={displayMode === 'rgb' ? compositeId : null}
                  multiLook={multiLook}
                  useMask={useMask}
                  speckleFilterType={speckleFilterType}
                  speckleKernelSize={speckleKernelSize}
                  showGrid={showGrid}
                  opacity={1}
                  width="100%"
                  height="100%"
                  onViewStateChange={handleViewStateChange}
                  initialViewState={initialViewState}
                  extraLayers={[...overtureLayers, ...catalogLayers, ...stacLayers]}
                  roi={roi}
                  onROIChange={setROI}
                  imageWidth={imageData?.sourceWidth || imageData?.width}
                  imageHeight={imageData?.sourceHeight || imageData?.height}
                  getPixelValue={imageData?.getPixelValue}
                  pixelExplorer={pixelExplorer}
                  pixelWindowSize={pixelWindowSize}
                  xCoords={imageData?.xCoords}
                  yCoords={imageData?.yCoords}
                  roiProfile={null}
                  profileShow={{ v: false, h: false, i: false }}
                  classificationMap={classifierOpen ? classificationMap : null}
                  classRegions={classRegions}
                  classifierRoiDims={classifierRoiDims}
                />
              </div>

              {/* ROI RGB viewer (side-by-side, only when ROI RGB loaded) */}
              {roiRGBData && roiRGBBounds && roiRGBContrastLimits && (
                <>
                  <div style={{
                    width: '3px', background: 'var(--border)',
                    flexShrink: 0,
                  }} />
                  <div
                    onClick={() => setActiveViewer('roi-rgb')}
                    style={{
                      flex: 1, position: 'relative', height: '100%',
                      outline: activeViewer === 'roi-rgb' ? '2px solid #4ec9d4' : 'none',
                      outlineOffset: '-2px',
                    }}>
                    <div style={{
                      position: 'absolute', top: '8px', left: '8px', zIndex: 10,
                      background: 'rgba(0,0,0,0.7)', color: '#4ec9d4',
                      padding: '4px 10px', borderRadius: 'var(--radius-sm)',
                      fontSize: '0.7rem', pointerEvents: 'none',
                    }}>
                      ROI RGB: {roiCompositeId}
                    </div>
                    <button
                      onClick={() => { setRoiRGBData(null); setRoiRGBBounds(null); setRoiRGBContrastLimits(null); setRoiRGBHistogramData(null); setActiveViewer('main'); }}
                      style={{
                        position: 'absolute', top: '8px', right: '8px', zIndex: 10,
                        background: 'rgba(0,0,0,0.7)', color: 'var(--text-muted)',
                        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                        padding: '2px 8px', fontSize: '0.65rem', cursor: 'pointer',
                      }}
                    >
                      Close
                    </button>
                    <SARViewer
                      getTile={roiRGBData.getTile}
                      bounds={roiRGBBounds}
                      contrastLimits={roiRGBContrastLimits}
                      useDecibels={false}
                      colormap={colormap}
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
                  <div style={{
                    width: '3px', background: 'var(--border)',
                    flexShrink: 0,
                  }} />
                  <div
                    onClick={() => setActiveViewer('roi-ts')}
                    style={{
                      flex: 1, position: 'relative', height: '100%',
                      outline: activeViewer === 'roi-ts' ? '2px solid #2ecc71' : 'none',
                      outlineOffset: '-2px',
                    }}>
                    <div style={{
                      position: 'absolute', top: '8px', left: '8px', zIndex: 10,
                      background: 'rgba(0,0,0,0.7)', color: '#2ecc71',
                      padding: '4px 10px', borderRadius: 'var(--radius-sm)',
                      fontSize: '0.7rem', pointerEvents: 'none',
                    }}>
                      {roiTSFrames[roiTSIndex]?.label || 'Frame ' + roiTSIndex}
                      {' '}({roiTSIndex + 1}/{roiTSFrames.length})
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); setRoiTSFrames(null); setRoiTSBounds(null); setRoiTSContrastLimits(null); setRoiTSHistogramData(null); setRoiTSPlaying(false); setActiveViewer('main'); }}
                      style={{
                        position: 'absolute', top: '8px', right: '8px', zIndex: 10,
                        background: 'rgba(0,0,0,0.7)', color: 'var(--text-muted)',
                        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                        padding: '2px 8px', fontSize: '0.65rem', cursor: 'pointer',
                      }}
                    >
                      Close
                    </button>
                    {/* Playback controls */}
                    <div style={{
                      position: 'absolute', bottom: '12px', left: '50%', transform: 'translateX(-50%)',
                      zIndex: 10, display: 'flex', alignItems: 'center', gap: '8px',
                      background: 'rgba(0,0,0,0.8)', padding: '6px 12px',
                      borderRadius: 'var(--radius-sm)', fontSize: '0.7rem',
                    }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setRoiTSIndex(prev => (prev - 1 + roiTSFrames.length) % roiTSFrames.length); }}
                        style={{ background: 'none', border: 'none', color: '#2ecc71', cursor: 'pointer', fontSize: '1rem', padding: '0 4px' }}
                      >◀</button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setRoiTSPlaying(prev => !prev); }}
                        style={{ background: 'none', border: 'none', color: '#2ecc71', cursor: 'pointer', fontSize: '1rem', padding: '0 4px' }}
                      >{roiTSPlaying ? '⏸' : '▶'}</button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setRoiTSIndex(prev => (prev + 1) % roiTSFrames.length); }}
                        style={{ background: 'none', border: 'none', color: '#2ecc71', cursor: 'pointer', fontSize: '1rem', padding: '0 4px' }}
                      >▶</button>
                      <input
                        type="range"
                        min={0}
                        max={roiTSFrames.length - 1}
                        value={roiTSIndex}
                        onChange={(e) => { e.stopPropagation(); setRoiTSIndex(Number(e.target.value)); }}
                        onClick={(e) => e.stopPropagation()}
                        style={{ width: '100px', accentColor: '#2ecc71' }}
                      />
                      <span style={{ color: '#2ecc71', minWidth: '70px', textAlign: 'center' }}>
                        {roiTSFrames[roiTSIndex]?.label}
                      </span>
                    </div>
                    <SARViewer
                      getTile={roiTSFrames[roiTSIndex]?.getTile}
                      bounds={roiTSBounds}
                      contrastLimits={roiTSContrastLimits}
                      useDecibels={useDecibels}
                      colormap={colormap}
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

          {/* Overview Map — toggleable overlay, bottom-left */}
          <OverviewMap
            wgs84Bounds={wgs84Bounds}
            visible={overviewMapVisible}
            onToggle={() => setOverviewMapVisible(v => !v)}
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
              mode={displayMode}
              contrastLimits={displayMode === 'rgb' ? rgbContrastLimits : [contrastMin, contrastMax]}
              useDecibels={useDecibels}
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
      />

      {/* Footer */}
      <footer style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: '24px',
        background: 'var(--sardine-bg, #0a1628)',
        borderTop: '1px dashed rgba(78, 201, 212, 0.15)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px',
        fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)',
        fontSize: '0.6rem',
        color: 'var(--text-muted, #5a7099)',
        zIndex: 1000,
        letterSpacing: '0.03em',
      }}>
        <span><a href="https://github.com/nicksteiner/sardine" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>SARdine</a> v1.0 · MIT</span>
        <span>steinerlab - ccny</span>
        <span style={{ color: 'var(--sardine-cyan, #4ec9d4)', opacity: 0.6 }}>
          deck.gl {multiLook ? '· multi-look' : '· nearest-neighbour'}
        </span>
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
        <div style={{ padding: '2rem', color: '#e0e0e0', background: '#1a1a2e', height: '100vh', fontFamily: 'monospace' }}>
          <h2>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#ff6b6b' }}>{this.state.error?.message}</pre>
          <button onClick={() => this.setState({ hasError: false, error: null })}
            style={{ padding: '0.5rem 1rem', marginTop: '1rem', cursor: 'pointer' }}>
            Try Again
          </button>
        </div>
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
