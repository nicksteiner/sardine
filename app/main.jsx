import React, { useState, useCallback, useEffect, useMemo, useRef, Component } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/sardine-theme.css';
import { SARViewer, loadCOG, loadLocalTIFs, loadCOGFullImage, autoContrastLimits, loadNISARGCOV, listNISARDatasets, loadMultiBandCOG, loadTemporalCOGs, ComparisonViewer } from '../src/index.js';
import { loadNISARRGBComposite, listNISARDatasetsFromUrl, loadNISARGCOVFromUrl, wktToROI } from '../src/loaders/nisar-loader.js';
import { listNISARGUNWDatasets, loadNISARGUNW, GUNW_LAYER_LABELS, GUNW_DATASET_LABELS } from '../src/loaders/nisar-gunw-loader.js';
import { detectNISARProduct, openNISARReader } from '../src/loaders/nisar-product.js';
import { setWorkerCount as setPoolWorkerCount, getWorkerPoolInfo } from '../src/loaders/h5chunk.js';
import { validateWKT } from '../src/utils/wkt.js';
import { computeSubsetBounds } from '../src/utils/roi-subset.js';
import { autoSelectComposite, getAvailableComposites, getRequiredDatasets, getRequiredComplexDatasets, SAR_COMPOSITES } from '../src/utils/sar-composites.js';
import { DataDiscovery } from '../src/components/DataDiscovery.jsx';
import { isNISARFile, isCOGFile } from '../src/utils/bucket-browser.js';
import { writeRGBAGeoTIFF, writeFloat32GeoTIFF, downloadBuffer } from '../src/utils/geotiff-writer.js';
import { createRGBTexture, computeRGBBands } from '../src/utils/sar-composites.js';
import { computeChannelStats, sampleViewportStats } from '../src/utils/stats.js';
import { computeChannelStatsAuto } from '../src/gpu/gpu-stats.js';
import { probeGPU } from '../src/utils/gpu-detect.js';
import { applySpeckleFilter, getFilterTypes } from '../src/gpu/spatial-filter.js';
import { StatusWindow } from '../src/components/StatusWindow.jsx';
import { MetadataPanel } from '../src/components/MetadataPanel.jsx';
import { OverviewMap } from '../src/components/OverviewMap.jsx';
import { HistogramPanel } from '../src/components/Histogram.jsx';
import { HistogramOverlay } from '../src/components/HistogramOverlay.jsx';
import { exportFigure, exportFigureWithOverlays, exportFigureSideBySide, exportRGBColorbar, downloadBlob } from '../src/utils/figure-export.js';
import { STRETCH_MODES, applyStretch } from '../src/utils/stretch.js';
import { getColormap } from '../src/utils/colormap.js';
import { OVERTURE_THEMES, fetchAllOvertureThemes, projectedToWGS84, wgs84ToProjectedPoint } from '../src/loaders/overture-loader.js';
import { createOvertureLayers } from '../src/layers/OvertureLayer.js';
import { GeoJsonLayer } from '@deck.gl/layers';
import { SceneCatalog } from '../src/components/SceneCatalog.jsx';
import { NISARSearch } from '../src/components/NISARSearch.jsx';
import { ROIProfilePlot } from '../src/components/ROIProfilePlot.jsx';
import ScatterClassifier from '../src/components/ScatterClassifier.jsx';
import ClassificationOverlay from '../src/components/ClassificationOverlay.jsx';
import { IncidenceScatter, sampleScatterData } from '../src/components/IncidenceScatter.jsx';
import { loadMetadataCube } from '../src/utils/metadata-cube.js';
import { loadAllCorrections, CORRECTION_TYPES } from '../src/utils/phase-corrections.js';
import { embedStateInPNG, extractStateFromPNG } from '../src/utils/png-state.js';

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
  // GPU capability detection (cached, runs once)
  const gpuInfo = useMemo(() => probeGPU(), []);

  // Worker pool state
  const workerInfo = useMemo(() => getWorkerPoolInfo(), []);
  const [workerCount, setWorkerCount] = useState(workerInfo.size);

  // Unified load mode — single selector replaces old format × source matrix
  const [fileType, setFileType] = useState('nisar'); // 'nisar' | 'local-tif' | 'remote' | 'cog' | 'catalog' | 'cmr'
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

  // GUNW phase corrections — individual layers uploaded to GPU as separate textures
  const [correctionLayers, setCorrectionLayers] = useState(null); // {ionosphere, troposphereWet, ...}
  const [enabledCorrections, setEnabledCorrections] = useState(new Set()); // Set of enabled correction keys
  // rampCoefficients state removed — planar ramp correction removed

  // Drag-and-drop state
  const [dragOver, setDragOver] = useState(false);

  // RGB composite state
  const [displayMode, setDisplayMode] = useState('single'); // 'single' | 'rgb' | 'multi-temporal'
  const [compositeId, setCompositeId] = useState(null);
  const [availableComposites, setAvailableComposites] = useState([]);

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

  // Viewer settings
  const [colormap, setColormap] = useState('grayscale');
  const [useDecibels, setUseDecibels] = useState(true);
  // GUNW data is in radians/meters — dB conversion is never valid
  const effectiveUseDecibels = nisarProductType === 'GUNW' ? false : useDecibels;
  const [showGrid, setShowGrid] = useState(true);
  const [pixelExplorer, setPixelExplorer] = useState(false);
  const [pixelWindowSize, setPixelWindowSize] = useState(1);
  const [contrastMin, setContrastMin] = useState(-25);
  const [contrastMax, setContrastMax] = useState(0);
  const [gamma, setGamma] = useState(1.0);
  const [rgbSaturation, setRgbSaturation] = useState(1.0);
  const [colorblindMode, setColorblindMode] = useState('off');
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
  const [overtureThemes, setOvertureThemes] = useState(['base_water', 'divisions_boundary']); // enabled themes
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
  const roiRGBViewerRef = useRef(null);
  const roiTSViewerRef = useRef(null);

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
            const v = effectiveUseDecibels ? 10 * Math.log10(r) : r;
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
  }, [nisarFile, remoteUrl, roi, roiCompositeId, selectedFrequency, imageData, addStatusLog]);

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
            bounds: data.bounds,
            label,
            date,
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
                chStats[ch] = computeChannelStats(valid, false) || null;
              }
              frames[fi].stats = chStats;
            } else {
              frames[fi].stats = null;
            }
          } else {
            const stats = await sampleViewportStats(
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
  }, [roiTSFiles, roi, imageData, selectedFrequency, selectedPolarization, nisarProductType, selectedLayer, selectedGunwDataset, useDecibels, displayMode, compositeId, addStatusLog]);

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

    if (isRGBDisplayMode) {
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

      if (isRGBDisplayMode && imageData.getRGBTile && compositeId) {
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

        addStatusLog('info', 'Histogram: computing statistics (GPU)...');
        const hists = {};
        let hasAnyStats = false;
        for (const ch of ['R', 'G', 'B']) {
          const arr = rawValues[ch] instanceof Float32Array ? rawValues[ch] : new Float32Array(rawValues[ch]);
          hists[ch] = await computeChannelStatsAuto(arr, effectiveUseDecibels);
          if (hists[ch]) hasAnyStats = true;
        }
        if (hasAnyStats) {
          setHistogramData(hists);
          // Set per-channel contrast limits from p2/p98 percentiles
          const lims = {};
          for (const ch of ['R', 'G', 'B']) {
            lims[ch] = hists[ch] ? [hists[ch].p2, hists[ch].p98] : [0, 1];
          }
          setRgbContrastLimits(lims);
          addStatusLog('success', `${scopeLabel} histogram updated (RGB, ${effectiveUseDecibels ? 'dB' : 'linear'})`,
            ['R', 'G', 'B'].map(ch => hists[ch] ? `${ch}: ${lims[ch][0].toExponential(2)}–${lims[ch][1].toExponential(2)}` : '').join(', '));
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
          const meanDb = 10 * Math.log10(mean_value);
          const stdDb = Math.abs(10 * Math.log10(sample_stddev / mean_value));
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
          console.log('[histogram] single-band path: region', { regionX, regionY, regionW, regionH }, 'useDecibels:', effectiveUseDecibels);
          const stats = await sampleViewportStats(
            imageData.getTile, regionW, regionH, effectiveUseDecibels, 128,
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
      }
    } catch (e) {
      console.error('[histogram] recompute error:', e);
      addStatusLog('warning', 'Histogram recompute failed', e.message);
    }
  }, [imageData, histogramScope, viewCenter, viewZoom, displayMode, compositeId, effectiveUseDecibels, nisarProductType, selectedGunwDataset, roi, addStatusLog]);

  // Recompute histogram when scope changes — but skip on initial load if
  // metadata-based contrast was already applied (avoids redundant tile reads).
  const skipInitialHistogramRef = useRef(false);
  // Separate flag for the viewport auto-refresh timer — persists across the 800ms delay.
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

  // Auto-recompute histogram when viewport changes (viewport scope, debounced)
  // Disabled without WebGPU — CPU histogram is too slow for live viewport updates.
  const recomputeRef = useRef(handleRecomputeHistogram);
  recomputeRef.current = handleRecomputeHistogram;
  const vcx = viewCenter[0];
  const vcy = viewCenter[1];
  useEffect(() => {
    if (!gpuInfo.webgpu) return; // Skip auto-refresh without WebGPU compute
    if (!imageData || !showHistogramOverlay || histogramScope !== 'viewport') return;
    const timer = setTimeout(() => {
      if (skipViewportRefreshRef.current) {
        skipViewportRefreshRef.current = false;
        return;
      }
      recomputeRef.current();
    }, 800);
    return () => clearTimeout(timer);
  }, [vcx, vcy, viewZoom, imageData, showHistogramOverlay, histogramScope, gpuInfo.webgpu]);

  // Auto-recompute histogram when ROI changes (ROI scope only)
  // Disabled without WebGPU — CPU histogram is too slow for live ROI updates.
  useEffect(() => {
    if (!gpuInfo.webgpu) return; // Skip auto-refresh without WebGPU compute
    if (!imageData || !roi || histogramScope !== 'roi') return;
    const timer = setTimeout(() => {
      recomputeRef.current();
    }, 300);
    return () => clearTimeout(timer);
  }, [roi, imageData, histogramScope, gpuInfo.webgpu]);

  // Recompute histogram when switching between dB and linear mode, then auto-stretch
  const useDecibelsRef = useRef(useDecibels);
  const pendingAutoStretchRef = useRef(false);
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
    console.log('[SARdine] autoFitIfNewScene:', newBounds, 'prev:', prevBoundsRef.current);
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
          // Prefer frequency B when available
          const preferB = datasets.find(d => d.frequency === 'B') || datasets[0];
          setSelectedFrequency(preferB.frequency);
          setSelectedPolarization(preferB.polarization);

          // Apply auto-contrast immediately from metadata stats
          const firstStats = preferB.stats;
          if (firstStats?.mean_value > 0 && firstStats?.sample_stddev > 0) {
            const meanDb = 10 * Math.log10(firstStats.mean_value);
            const stdDb = Math.abs(10 * Math.log10(firstStats.sample_stddev / firstStats.mean_value));
            setContrastMin(Math.round(meanDb - 2 * stdDb));
            setContrastMax(Math.round(meanDb + 2 * stdDb));
            addStatusLog('info', 'Auto-contrast from metadata',
              `${(meanDb - 2 * stdDb).toFixed(1)} to ${(meanDb + 2 * stdDb).toFixed(1)} dB`);
          }
        }

        const composites = getAvailableComposites(datasets);
        setAvailableComposites(composites);

        const autoComposite = autoSelectComposite(datasets);
        setCompositeId(autoComposite);
        setDisplayMode('single');

        if (autoComposite) {
          addStatusLog('info', `RGB composite available: ${composites.find(c => c.id === autoComposite)?.name || autoComposite}`);
        }

        addStatusLog('success', `Found ${datasets.length} datasets`,
          datasets.map(d => `${d.frequency}/${d.polarization}`).join(', '));
      }
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

  // Drag-and-drop handler — auto-detect file type from name/extension
  const handleFileDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;

    const file = files[0];
    const name = file.name.toLowerCase();

    if (name.endsWith('.h5') || name.endsWith('.hdf5') || name.endsWith('.he5')) {
      // Auto-detect GCOV vs GUNW from filename
      if (name.includes('gunw') || name.includes('_unw_')) {
        setFileType('nisar-gunw');
      } else {
        setFileType('nisar');
      }
      handleNISARFileSelect(file);
    } else if (name.endsWith('.tif') || name.endsWith('.tiff')) {
      setFileType('local-tif');
      handleLocalTIFMultiSelect(files);
    } else if (name.endsWith('.geojson') || name.endsWith('.json')) {
      // Read GeoJSON and add as overlay
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const geojson = JSON.parse(evt.target.result);
          if (!geojson.type || (geojson.type !== 'FeatureCollection' && geojson.type !== 'Feature' && geojson.type !== 'GeometryCollection')) {
            addStatusLog('warning', `Not a valid GeoJSON: ${file.name}`);
            return;
          }
          // Wrap bare Feature in a FeatureCollection
          const data = geojson.type === 'Feature'
            ? { type: 'FeatureCollection', features: [geojson] }
            : geojson;
          const id = `geojson-${Date.now()}`;
          setDroppedGeoJSON(prev => [...prev, { id, name: file.name, data }]);
          addStatusLog('info', `GeoJSON loaded: ${file.name}`,
            `${(data.features?.length || 0)} features`);
        } catch (parseErr) {
          addStatusLog('error', `Failed to parse GeoJSON: ${file.name}`, parseErr.message);
        }
      };
      reader.readAsText(file);
    } else if (name.endsWith('.png')) {
      // Check for embedded SARdine state
      extractStateFromPNG(file).then((state) => {
        if (!state) {
          addStatusLog('warning', `No SARdine state found in: ${file.name}`, 'Only SARdine-exported PNGs carry embedded state');
          return;
        }
        if (state.colormap) setColormap(state.colormap);
        if (state.useDecibels !== undefined) setUseDecibels(state.useDecibels);
        if (state.contrastMin !== undefined) setContrastMin(state.contrastMin);
        if (state.contrastMax !== undefined) setContrastMax(state.contrastMax);
        if (state.gamma !== undefined) setGamma(state.gamma);
        if (state.stretchMode) setStretchMode(state.stretchMode);
        if (state.displayMode) setDisplayMode(state.displayMode);
        if (state.compositeId !== undefined) setCompositeId(state.compositeId);
        if (state.rgbContrastLimits) setRgbContrastLimits(state.rgbContrastLimits);
        if (state.selectedFrequency) setSelectedFrequency(state.selectedFrequency);
        if (state.selectedPolarization) setSelectedPolarization(state.selectedPolarization);
        if (state.multiLook !== undefined) setMultiLook(state.multiLook);
        if (state.speckleFilterType) setSpeckleFilterType(state.speckleFilterType);
        if (state.maskInvalid !== undefined) setMaskInvalid(state.maskInvalid);
        if (state.viewCenter) setViewCenter(state.viewCenter);
        if (state.viewZoom !== undefined) setViewZoom(state.viewZoom);
        const restoredFile = state.filename || '(unknown)';
        addStatusLog('success', `State restored from: ${file.name}`, `Original file: ${restoredFile}`);
      }).catch((err) => {
        addStatusLog('error', `Failed to read PNG state: ${file.name}`, err.message);
      });
    } else {
      addStatusLog('warning', `Unsupported file type: ${file.name}`, 'Drop .h5, .tif, .geojson, or a SARdine-exported .png');
    }
  }, [handleNISARFileSelect, handleLocalTIFMultiSelect, addStatusLog]);

  // Handle remote file selection from DataDiscovery browser
  const handleRemoteFileSelect = useCallback(async (fileInfo) => {
    const { url, name, size, type, token } = fileInfo;
    addStatusLog('info', `Remote file selected: ${name}`);

    // Store auth token for subsequent data fetches (e.g. Earthdata bearer token from STAC search)
    // Strip "Bearer " prefix if user already included it
    const cleanToken = token?.replace(/^Bearer\s+/i, '').trim();
    const fetchHeaders = cleanToken ? { 'Authorization': `Bearer ${cleanToken}` } : undefined;
    handleRemoteFileSelect._fetchHeaders = fetchHeaders;
    console.log(`[SARdine] Token: ${cleanToken ? `set (${cleanToken.slice(0, 8)}...)` : 'none'}, URL: ${url.slice(0, 80)}`);
    if (!cleanToken) {
      addStatusLog('warning', 'No Earthdata token — DAAC data URLs require authentication');
    }

    // Route external URLs through the Vite CORS proxy (dev only).
    // h5chunk makes Range requests directly to this.url, so we rewrite once here.
    let resolvedUrl = url;
    try {
      const u = new URL(url);
      if (u.origin !== window.location.origin) {
        resolvedUrl = `${window.location.origin}/stac-proxy/${encodeURIComponent(url)}`;
      }
    } catch { /* keep original if URL parsing fails */ }

    if (type === 'cog') {
      // Load as COG directly
      setCogUrl(resolvedUrl);
      setFileType('cog');
      addStatusLog('info', `Loading COG from: ${url}`);
      return;
    }

    // NISAR HDF5 — stream from URL
    setRemoteUrl(resolvedUrl);
    setRemoteName(name);
    setNisarDatasets([]);
    setLoading(true);
    setError(null);

    try {
      addStatusLog('info', `Streaming NISAR metadata from: ${name}`);
      const result = await listNISARDatasetsFromUrl(resolvedUrl, { fetchHeaders });
      const datasets = result.datasets || result;
      // Store the stream reader to reuse when loading (avoids re-downloading metadata)
      if (result._streamReader) {
        handleRemoteFileSelect._cachedReader = result._streamReader;
      }
      setNisarDatasets(datasets);

      if (datasets.length > 0) {
        // Prefer frequency B when available
        const preferB = datasets.find(d => d.frequency === 'B') || datasets[0];
        setSelectedFrequency(preferB.frequency);
        setSelectedPolarization(preferB.polarization);

        // Apply auto-contrast immediately from metadata stats (before data loads)
        const firstStats = preferB.stats;
        if (firstStats?.mean_value > 0 && firstStats?.sample_stddev > 0) {
          const meanDb = 10 * Math.log10(firstStats.mean_value);
          const stdDb = Math.abs(10 * Math.log10(firstStats.sample_stddev / firstStats.mean_value));
          setContrastMin(Math.round(meanDb - 2 * stdDb));
          setContrastMax(Math.round(meanDb + 2 * stdDb));
          addStatusLog('info', 'Auto-contrast from metadata',
            `${(meanDb - 2 * stdDb).toFixed(1)} to ${(meanDb + 2 * stdDb).toFixed(1)} dB`);
        }
      }

      const composites = getAvailableComposites(datasets);
      setAvailableComposites(composites);
      const autoComp = autoSelectComposite(datasets);
      setCompositeId(autoComp);
      setDisplayMode('single');

      addStatusLog('success', `Found ${datasets.length} remote datasets`,
        datasets.map(d => `${d.frequency}/${d.polarization}`).join(', '));

      // Show dataset controls — user clicks "Load" manually (NISAR files are large)
    } catch (e) {
      const isAuthErr = e.message?.includes('401') || e.message?.includes('403') || e.message?.includes('Unauthorized');
      const hint = isAuthErr
        ? (token
            ? ' — Token may be expired. Run: curl -n https://urs.earthdata.nasa.gov/api/users/tokens and paste the access_token value'
            : ' — Set your Earthdata token in the NISAR Search panel')
        : '';
      setError(`Failed to read remote NISAR file: ${e.message}${hint}`);
      addStatusLog('error', `Remote metadata read failed${hint}`, e.message);
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
          fetchHeaders: handleRemoteFileSelect._fetchHeaders,
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
      } else {
        // Single band mode
        addStatusLog('info', `Loading remote NISAR: ${selectedFrequency}/${selectedPolarization}`);

        data = await loadNISARGCOVFromUrl(remoteUrl, {
          frequency: selectedFrequency,
          polarization: selectedPolarization,
          _streamReader: handleRemoteFileSelect._cachedReader || null,
          fetchHeaders: handleRemoteFileSelect._fetchHeaders,
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

        // Use embedded HDF5 statistics for auto-contrast (same as local file path)
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

      if (gen !== loadGenRef.current) {
        console.log('[SARdine] Stale load gen, skipping setImageData');
        return;
      }
      console.log('[SARdine] Setting imageData:', data.width, 'x', data.height, 'bounds:', data.bounds);
      setImageData(data);

      // Auto-fit view only if this is a new scene (different track-frame)
      autoFitIfNewScene(data.bounds);

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
              data.getTile, gMaxX - gMinX, gMaxY - gMinY, effectiveUseDecibels, 128,
              gMinX, gMinY,
            );
            if (stats) {
              setHistogramData({ single: stats });
              setContrastMin(Number(stats.p2.toFixed(effectiveUseDecibels ? 1 : 3)));
              setContrastMax(Number(stats.p98.toFixed(effectiveUseDecibels ? 1 : 3)));
              const unit = effectiveUseDecibels ? 'dB' : '';
              addStatusLog('success', `Auto-contrast: ${stats.p2.toFixed(effectiveUseDecibels ? 1 : 3)} to ${stats.p98.toFixed(effectiveUseDecibels ? 1 : 3)} ${unit}`);
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
  }, [remoteUrl, selectedFrequency, selectedPolarization, displayMode, compositeId, useDecibels, fileType, addStatusLog, autoFitIfNewScene]);

  // Note: Auto-load removed — NISAR files are large (multi-GB), user clicks "Load" manually
  // after selecting a granule and reviewing the dataset/frequency/polarization options.

  // Load selected NISAR dataset (single band or RGB composite)
  const handleLoadNISAR = useCallback(async () => {
    if (!nisarFile) {
      setError('Please select a NISAR HDF5 file');
      addStatusLog('error', 'No NISAR file selected');
      return;
    }

    setLoading(true);
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
        });

        addStatusLog('success', 'NISAR dataset loaded',
          `${data.width}x${data.height}, CRS: ${data.crs}`);

        // Progressive refinement: coarse grid → full-res in background
        data.onRefine = () => setTileVersion(v => v + 1);

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
                // Direct band → channel: use band stats
                const s = data.bandStats[chDef.dataset];
                const lo = Math.max(0, s.mean_value - 2 * s.sample_stddev);
                const hi = s.mean_value + 2 * s.sample_stddev;
                lims[ch] = [lo, hi];
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
            setHistogramScope('viewport');
            // Pre-sync the useDecibels ref so its change-detection effect doesn't fire
            useDecibelsRef.current = false;

            // Build synthetic per-channel histograms from band stats so the histogram
            // panel renders immediately without sampling any tiles.
            const syntheticHists = {};
            const numBins = 128;
            const syntheticCount = 100000;
            for (const ch of ['R', 'G', 'B']) {
              const chDef = preset.channels[ch];
              const s = chDef?.dataset && data.bandStats[chDef.dataset];
              if (s && s.mean_value > 0 && s.sample_stddev > 0) {
                const mean = s.mean_value;
                const std = s.sample_stddev;
                const lo = Math.max(0, mean - 4 * std);
                const hi = mean + 4 * std;
                const binWidth = (hi - lo) / numBins;
                const bins = new Array(numBins).fill(0);
                for (let b = 0; b < numBins; b++) {
                  const binCenter = lo + (b + 0.5) * binWidth;
                  const z = (binCenter - mean) / std;
                  bins[b] = Math.round(syntheticCount * Math.exp(-0.5 * z * z) / (std * Math.sqrt(2 * Math.PI)) * binWidth);
                }
                syntheticHists[ch] = { bins, min: lo, max: hi, mean, binWidth, count: syntheticCount,
                  p2: Math.max(0, mean - 2 * std), p98: mean + 2 * std };
              } else {
                // Ratio channel or missing stats — flat histogram over the contrast range
                const [clo, chi] = lims[ch];
                const binWidth = (chi - clo) / numBins;
                const bins = new Array(numBins).fill(syntheticCount / numBins);
                syntheticHists[ch] = { bins, min: clo, max: chi, mean: (clo + chi) / 2, binWidth,
                  count: syntheticCount, p2: clo, p98: chi };
              }
            }
            // Do not auto-set histogramData — overlay should be disabled on load.
            // Contrast limits are applied above; user triggers histogram via scope selector.
            // Skip tile-sampling histogram recompute — metadata contrast is already applied
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
      setError(`Failed to load NISAR dataset: ${e.message}`);
      setImageData(null);
      addStatusLog('error', 'Failed to load NISAR dataset', e.message);
      console.error('NISAR loading error:', e);
    } finally {
      setLoading(false);
    }
  }, [nisarFile, nisarFile2, nisarFile3, nisarProductType, selectedFrequency, selectedPolarization, selectedLayer, selectedGunwDataset, displayMode, compositeId, gunwDatasets, addStatusLog, autoFitIfNewScene]);

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
          addStatusLog('info', `Applying ${effectiveUseDecibels ? 'dB' : 'linear'} + ${colormap} colormap...`);
          const colormapFunc = getColormap(colormap);
          const cMin = contrastMin;
          const cMax = contrastMax;
          const needsStretch = stretchMode !== 'linear' || gamma !== 1.0;
          const rgbaData = new Uint8ClampedArray(numPixels * 4);
          const bandData = bands[bandNames[0]];

          for (let i = 0; i < numPixels; i++) {
            const amplitude = bandData[i];
            let value;
            if (effectiveUseDecibels) {
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

  // Serialize current visualization state for embedding in exported PNGs
  const serializeViewerState = useCallback(() => ({
    colormap,
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
  }), [colormap, useDecibels, contrastMin, contrastMax, gamma, stretchMode, displayMode, compositeId, rgbContrastLimits, selectedFrequency, selectedPolarization, multiLook, speckleFilterType, maskInvalid, fileType, viewCenter, viewZoom, nisarFile, cogUrl]);

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
      const mainOpts = {
        colormap,
        contrastLimits: effectiveContrastLimits,
        useDecibels: effectiveUseDecibels,
        compositeId: displayMode === 'rgb' ? compositeId : null,
        viewState: vs,
        bounds: imageData?.bounds,
        filename: (fileType === 'nisar' || fileType === 'nisar-gunw') ? nisarFile?.name : cogUrl,
        crs: imageData?.crs || '',
        histogramData: showHistogramOverlay ? histogramData : null,
        polarization: selectedPolarization,
        identification: imageData?.identification || null,
      };

      const secondaryRef = roiRGBViewerRef.current ? roiRGBViewerRef : roiTSViewerRef.current ? roiTSViewerRef : null;
      const secondaryCanvas = secondaryRef?.current?.getCanvas();

      let blob;
      if (secondaryCanvas) {
        const secondaryVS = secondaryRef.current.getViewState();
        const isTS = secondaryRef === roiTSViewerRef;
        const secondaryOpts = isTS ? {
          colormap,
          contrastLimits: roiTSContrastLimits,
          useDecibels: roiTSFrames[roiTSIndex]?.isRGB ? false : (nisarProductType === 'GUNW' ? false : useDecibels),
          compositeId: roiTSFrames[roiTSIndex]?.compositeId || null,
          viewState: secondaryVS,
          bounds: roiTSBounds,
          filename: roiTSFrames[roiTSIndex]?.label || '',
          crs: imageData?.crs || '',
          identification: imageData?.identification || null,
        } : {
          colormap,
          contrastLimits: roiRGBContrastLimits,
          useDecibels: false,
          compositeId: roiCompositeId,
          viewState: secondaryVS,
          bounds: roiRGBBounds,
          filename: (fileType === 'nisar' || fileType === 'nisar-gunw') ? nisarFile?.name : cogUrl,
          crs: imageData?.crs || '',
          histogramData: showHistogramOverlay && roiRGBHistogramData ? roiRGBHistogramData : null,
          identification: imageData?.identification || null,
        };
        blob = await exportFigureSideBySide(
          { canvas: glCanvas, options: mainOpts },
          { canvas: secondaryCanvas, options: secondaryOpts },
        );
      } else {
        blob = await exportFigure(glCanvas, mainOpts);
      }

      blob = await embedStateInPNG(blob, serializeViewerState());

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const figName = `sardine_figure_${ts}.png`;
      downloadBlob(blob, figName);
      addStatusLog('success', `Figure saved: ${figName}`);

      // Force deck.gl to re-render so the canvas doesn't stay blank
      viewerRef.current.redraw();
      secondaryRef?.current?.redraw();
    } catch (e) {
      addStatusLog('error', 'Figure export failed', e.message);
      console.error('Figure export error:', e);
    }
  }, [colormap, effectiveContrastLimits, useDecibels, effectiveUseDecibels, displayMode, compositeId, imageData, fileType, nisarFile, cogUrl, addStatusLog, showHistogramOverlay, histogramData, selectedPolarization, roiRGBContrastLimits, roiRGBBounds, roiCompositeId, roiRGBHistogramData, roiTSContrastLimits, roiTSBounds, roiTSFrames, roiTSIndex, nisarProductType, serializeViewerState]);

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
      const mainOpts = {
        colormap,
        contrastLimits: effectiveContrastLimits,
        useDecibels: effectiveUseDecibels,
        compositeId: displayMode === 'rgb' ? compositeId : null,
        viewState: vs,
        bounds: imageData?.bounds,
        filename: (fileType === 'nisar' || fileType === 'nisar-gunw') ? nisarFile?.name : cogUrl,
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
      };

      const secondaryRef = roiRGBViewerRef.current ? roiRGBViewerRef : roiTSViewerRef.current ? roiTSViewerRef : null;
      const secondaryCanvas = secondaryRef?.current?.getCanvas();

      let blob;
      if (secondaryCanvas) {
        const secondaryVS = secondaryRef.current.getViewState();
        const isTS = secondaryRef === roiTSViewerRef;
        const secondaryOpts = isTS ? {
          colormap,
          contrastLimits: roiTSContrastLimits,
          useDecibels: roiTSFrames[roiTSIndex]?.isRGB ? false : (nisarProductType === 'GUNW' ? false : useDecibels),
          compositeId: roiTSFrames[roiTSIndex]?.compositeId || null,
          viewState: secondaryVS,
          bounds: roiTSBounds,
          filename: roiTSFrames[roiTSIndex]?.label || '',
          crs: imageData?.crs || '',
          identification: imageData?.identification || null,
        } : {
          colormap,
          contrastLimits: roiRGBContrastLimits,
          useDecibels: false,
          compositeId: roiCompositeId,
          viewState: secondaryVS,
          bounds: roiRGBBounds,
          filename: (fileType === 'nisar' || fileType === 'nisar-gunw') ? nisarFile?.name : cogUrl,
          crs: imageData?.crs || '',
          histogramData: showHistogramOverlay && roiRGBHistogramData ? roiRGBHistogramData : null,
          identification: imageData?.identification || null,
        };
        // For the main panel, use exportFigureWithOverlays to capture ROI/profile overlays;
        // for the secondary panel use plain exportFigure (no ROI drawn there).
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
        blob = await exportFigureWithOverlays(glCanvas, mainOpts);
      }

      blob = await embedStateInPNG(blob, serializeViewerState());

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const figName = `sardine_figure_${ts}.png`;
      downloadBlob(blob, figName);
      addStatusLog('success', `Figure with overlays saved: ${figName}`);

      viewerRef.current.redraw();
      secondaryRef?.current?.redraw();
    } catch (e) {
      addStatusLog('error', 'Figure export failed', e.message);
      console.error('Figure export error:', e);
    }
  }, [colormap, effectiveContrastLimits, useDecibels, effectiveUseDecibels, displayMode, compositeId, imageData, fileType, nisarFile, cogUrl, roi, roiProfile, profileShow, addStatusLog, showHistogramOverlay, histogramData, selectedPolarization, classifierOpen, classificationMap, classRegions, classifierRoiDims, roiRGBContrastLimits, roiRGBBounds, roiCompositeId, roiRGBHistogramData, roiTSContrastLimits, roiTSBounds, roiTSFrames, roiTSIndex, nisarProductType, serializeViewerState]);

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
        useDecibels: effectiveUseDecibels,
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
    } else {
      addStatusLog('warning', 'Could not determine data source for reload');
    }
  }, [imageData, fileType, nisarFile, remoteUrl, cogUrl, addStatusLog, handleLoadNISAR, handleLoadRemoteNISAR, handleLoadCOG]);

  // Fetch Overture features for entire scene extent (once per enable/theme/data change)
  useEffect(() => {
    if (!overtureEnabled || overtureThemes.length === 0) return;

    if (overtureDebounceRef.current) clearTimeout(overtureDebounceRef.current);

    overtureDebounceRef.current = setTimeout(async () => {
      try {
        setOvertureLoading(true);
        let wgs84Bbox;

        if (imageData) {
          // Use full image extent — fetch once, no viewport tracking
          const globalBounds = imageData.worldBounds || imageData.bounds;
          const crs = imageData.crs || 'EPSG:4326';
          wgs84Bbox = projectedToWGS84(globalBounds, crs);
        } else {
          // No image loaded — use a default global bbox
          wgs84Bbox = [-180, -85, 180, 85];
        }

        addStatusLog('info', `Fetching Overture for scene extent...`);
        const data = await fetchAllOvertureThemes(overtureThemes, wgs84Bbox);
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
    }, 300);

    return () => { if (overtureDebounceRef.current) clearTimeout(overtureDebounceRef.current); };
  }, [overtureEnabled, overtureThemes, imageData, addStatusLog]);

  // Build Overture overlay layers for deck.gl
  const overtureLayers = useMemo(() => {
    if (!overtureEnabled || !overtureData) return [];
    const crs = imageData?.crs || 'EPSG:4326';
    return createOvertureLayers(overtureData, { opacity: overtureOpacity, crs });
  }, [overtureEnabled, overtureData, overtureOpacity, imageData]);

  // Build GeoJSON overlay layers from dropped files
  const geojsonOverlayLayers = useMemo(() => {
    if (droppedGeoJSON.length === 0) return [];
    const crs = imageData?.crs || 'EPSG:4326';

    // Reproject GeoJSON coordinates from WGS84 to image CRS
    function reprojectCoords(coords) {
      if (!coords) return coords;
      if (typeof coords[0] === 'number') {
        const [x, y] = wgs84ToProjectedPoint(coords[0], coords[1], crs);
        return coords.length > 2 ? [x, y, coords[2]] : [x, y];
      }
      return coords.map(c => reprojectCoords(c));
    }
    function reprojectFeature(feature) {
      if (!feature?.geometry?.coordinates) return feature;
      return {
        ...feature,
        geometry: { ...feature.geometry, coordinates: reprojectCoords(feature.geometry.coordinates) },
      };
    }
    function reprojectData(data) {
      if (data.type === 'FeatureCollection') {
        return { ...data, features: data.features.map(f => reprojectFeature(f)) };
      }
      return reprojectFeature(data);
    }

    const needsReproject = crs && crs !== 'EPSG:4326';
    const colors = [
      [255, 200, 0],   // yellow
      [0, 200, 255],   // cyan
      [255, 100, 200], // pink
      [100, 255, 100], // green
      [255, 140, 0],   // orange
    ];
    return droppedGeoJSON.map((entry, i) => {
      const color = colors[i % colors.length];
      const data = needsReproject ? reprojectData(entry.data) : entry.data;
      return new GeoJsonLayer({
        id: entry.id,
        data,
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

  // NOTE: Duplicate block removed — all handlers defined above
  return (
    <div id="app"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget.contains(e.relatedTarget)) return; setDragOver(false); }}
      onDrop={handleFileDrop}
    >
      {/* Drag-and-drop overlay */}
      {dragOver && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0, 180, 220, 0.15)',
          border: '3px dashed rgba(0, 180, 220, 0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <div style={{
            padding: '24px 48px', borderRadius: '12px',
            background: 'rgba(0, 0, 0, 0.7)', color: '#fff',
            fontSize: '1.2rem', fontWeight: 600,
          }}>
            Drop HDF5, GeoTIFF, or GeoJSON file
          </div>
        </div>
      )}
      {/* GeoJSON feature popup */}
      {geojsonPopup && (
        <div
          style={{
            position: 'fixed',
            left: geojsonPopup.x + 12,
            top: geojsonPopup.y - 12,
            zIndex: 10000,
            background: 'rgba(20, 20, 30, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '12px 16px',
            color: '#fff',
            fontSize: '0.82rem',
            maxWidth: '360px',
            maxHeight: '400px',
            overflow: 'auto',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            fontFamily: 'monospace',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontWeight: 600, color: '#ffcc00', fontSize: '0.85rem' }}>
              {geojsonPopup.geometry?.type || 'Feature'}
            </span>
            <button
              onClick={() => setGeojsonPopup(null)}
              style={{
                background: 'none', border: 'none', color: '#aaa', cursor: 'pointer',
                fontSize: '1rem', padding: '0 4px', lineHeight: 1,
              }}
            >x</button>
          </div>
          <div style={{ fontSize: '0.72rem', color: '#888', marginBottom: '6px' }}>{geojsonPopup.layer}</div>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              {Object.entries(geojsonPopup.properties).map(([key, val]) => (
                <tr key={key} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <td style={{ padding: '3px 8px 3px 0', color: '#aaa', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{key}</td>
                  <td style={{ padding: '3px 0', wordBreak: 'break-word' }}>{String(val ?? '')}</td>
                </tr>
              ))}
              {Object.keys(geojsonPopup.properties).length === 0 && (
                <tr><td style={{ color: '#666', fontStyle: 'italic' }}>No properties</td></tr>
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
        {/* Controls Panel */}
        <div className="controls-panel">
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

          {/* NISAR HDF5 Input */}
          {(fileType === 'nisar' || fileType === 'nisar-gunw') && (
            <CollapsibleSection title={`Load NISAR ${nisarProductType}`}>
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
                <div className="control-group" style={{ fontSize: '0.6rem', color: 'var(--text-muted)', wordBreak: 'break-all', lineHeight: '1.3' }}>
                  {nisarFile.name} ({(nisarFile.size / 1e9).toFixed(2)} GB)
                </div>
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
                  placeholder="https://…/*.h5 or *.tif (auto-detected)"
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
              <div className="control-group" style={{ fontSize: '0.6rem', color: 'var(--text-muted)', wordBreak: 'break-all', lineHeight: '1.3' }}>
                {nisarFile ? nisarFile.name : remoteName || 'Remote'}
                {nisarFile && ` (${(nisarFile.size / 1e9).toFixed(2)} GB)`}
                {nisarProductType !== 'GCOV' && (
                  <span style={{ marginLeft: '6px', color: 'var(--sardine-cyan)', fontWeight: 600 }}>
                    {nisarProductType}
                  </span>
                )}
              </div>

              <div className="control-group">
                <label>Frequency</label>
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
                        const meanDb = 10 * Math.log10(ds.stats.mean_value);
                        const stdDb = Math.abs(10 * Math.log10(ds.stats.sample_stddev / ds.stats.mean_value));
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
              </div>

              {/* GUNW-specific: Layer group selector */}
              {nisarProductType === 'GUNW' && (
                <div className="control-group">
                  <label>Layer</label>
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
                </div>
              )}

              {/* GUNW-specific: Dataset selector within layer */}
              {nisarProductType === 'GUNW' && (
                <div className="control-group">
                  <label>Dataset</label>
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
                </div>
              )}

              <div className="control-group">
                <label>Polarization</label>
                <select
                  value={selectedPolarization}
                  onChange={(e) => {
                    const pol = e.target.value;
                    setSelectedPolarization(pol);
                    // Update contrast from metadata stats for the new polarization
                    const ds = nisarDatasets.find(d => d.frequency === selectedFrequency && d.polarization === pol);
                    if (ds?.stats?.mean_value > 0 && ds?.stats?.sample_stddev > 0) {
                      const meanDb = 10 * Math.log10(ds.stats.mean_value);
                      const stdDb = Math.abs(10 * Math.log10(ds.stats.sample_stddev / ds.stats.mean_value));
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
              </div>

              {/* Display mode — single band, RGB composite (GCOV only), or multi-temporal */}
              <div className="control-group">
                <label>Display Mode</label>
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
                  <option value="multi-temporal">Multi-temporal RGB (3 dates)</option>
                </select>
              </div>

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
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {availableComposites.find(c => c.id === compositeId)?.description || ''}
                  </div>
                </div>
              )}

              {/* Multi-temporal RGB: file pickers for Green and Blue acquisitions */}
              {displayMode === 'multi-temporal' && (
                <div className="control-group">
                  <label style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                    File 1 (R) — already selected above
                  </label>
                  {/* File 2 → Green */}
                  <div style={{ marginTop: '6px' }}>
                    <label style={{ fontSize: '0.7rem' }}>File 2 (G)</label>
                    <input
                      type="file"
                      accept=".h5,.hdf5,.he5"
                      id="nisar-file2-input"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setNisarFile2(f);
                      }}
                    />
                    <button
                      className="btn-secondary"
                      onClick={() => document.getElementById('nisar-file2-input').click()}
                      style={{ width: '100%', marginTop: '2px' }}
                    >
                      {nisarFile2 ? nisarFile2.name.slice(0, 30) + (nisarFile2.name.length > 30 ? '…' : '') : 'Choose File 2...'}
                    </button>
                  </div>
                  {/* File 3 → Blue */}
                  <div style={{ marginTop: '6px' }}>
                    <label style={{ fontSize: '0.7rem' }}>File 3 (B)</label>
                    <input
                      type="file"
                      accept=".h5,.hdf5,.he5"
                      id="nisar-file3-input"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setNisarFile3(f);
                      }}
                    />
                    <button
                      className="btn-secondary"
                      onClick={() => document.getElementById('nisar-file3-input').click()}
                      style={{ width: '100%', marginTop: '2px' }}
                    >
                      {nisarFile3 ? nisarFile3.name.slice(0, 30) + (nisarFile3.name.length > 30 ? '…' : '') : 'Choose File 3...'}
                    </button>
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '4px' }}>
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
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Threshold</span>
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

              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  onClick={remoteUrl ? handleLoadRemoteNISAR : handleLoadNISAR}
                  disabled={loading}
                  style={{ flex: 1 }}
                >
                  {loading ? 'Loading...' : displayMode === 'rgb' ? 'Load RGB Composite' : displayMode === 'multi-temporal' ? 'Load Multi-temporal RGB' : 'Load Dataset'}
                </button>

                {/* GUNW paired view: phase + coherence side-by-side */}
                {nisarProductType === 'GUNW' && (
                  <button
                    className="btn-secondary"
                    disabled={loading}
                    style={{ fontSize: '0.65rem', padding: '4px 8px', whiteSpace: 'nowrap' }}
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
              <button
                onClick={fitToBounds}
                disabled={!imageData?.bounds}
                title="Reset view to image bounds"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.7rem',
                  color: 'var(--text-muted)',
                  background: 'var(--surface-alt)',
                  border: '1px solid var(--border)',
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
                  <option value="twilight">Twilight</option>
                  <option value="rdbu">RdBu (InSAR)</option>
                  <option value="romaO">romaO (Phase)</option>
                  <option value="polarimetric">Polarimetric</option>
                  <option value="label">Label</option>
                </select>
              </div>
            )}

            <div className="control-group">
              <div className="control-row">
                <input
                  type="checkbox"
                  id="useDb"
                  checked={effectiveUseDecibels}
                  disabled={nisarProductType === 'GUNW'}
                  onChange={(e) => setUseDecibels(e.target.checked)}
                />
                <label htmlFor="useDb">dB Scaling{nisarProductType === 'GUNW' ? ' (N/A)' : ''}</label>
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
                    : `RGBA with ${effectiveUseDecibels ? 'dB' : 'linear'} stretch, ${colormap} colormap`}
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
                {roi && (nisarFile || remoteUrl) && availableComposites.length > 0 && displayMode === 'single' && (
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
                {roi && nisarFile && (
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
            {/* Histogram scope toggle — shown when histogram exists, or always in RGB mode so
                user can trigger the first computation via the Viewport/ROI buttons */}
            {(histogramData || (imageData && isRGBDisplayMode)) && (
              <div className="control-group" style={{ marginBottom: '6px' }}>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {['global', 'viewport', 'roi'].map(scope => {
                    const hasH5Stats = imageData?.stats?.mean_value > 0 && imageData?.stats?.sample_stddev > 0;
                    const label = scope === 'global' ? (hasH5Stats ? 'Metadata' : 'Global') : scope === 'viewport' ? 'Viewport' : 'ROI';
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

            {/* RGB per-channel histograms (main RGB mode, multi-temporal, or ROI RGB viewer) */}
            {(sidebarDisplayMode === 'rgb' || sidebarDisplayMode === 'multi-temporal') && sidebarHistogramData && (
              <HistogramPanel
                histograms={sidebarHistogramData}
                mode="rgb"
                contrastLimits={sidebarIsRoiRGB
                  ? (roiRGBContrastLimits || { R: [0, 1], G: [0, 1], B: [0, 1] })
                  : (rgbContrastLimits || { R: [0, 1], G: [0, 1], B: [0, 1] })}
                useDecibels={sidebarIsRoiRGB ? false : effectiveUseDecibels}
                logScale={nisarProductType !== 'GCOV'}
                onContrastChange={sidebarIsRoiRGB ? setRoiRGBContrastLimits : setRgbContrastLimits}
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
                  <div className="control-row" style={{ marginBottom: '6px' }}>
                    <input
                      type="checkbox"
                      id="losToggle"
                      checked={losDisplacement}
                      onChange={(e) => {
                        const toLOS = e.target.checked;
                        setLosDisplacement(toLOS);
                        // λ = 0.2384m (NISAR L-band), d = phase * λ/(4π)
                        const scale = 0.2384 / (4 * Math.PI);
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
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '4px' }}>
                        {losDisplacement ? '(m)' : '(rad)'}
                      </span>
                    </label>
                  </div>
                )}

                {/* Vertical displacement toggle — requires incidence angle grid */}
                {losDisplacement && gunwIncidenceAngleGrid && (
                  <div className="control-row" style={{ marginBottom: '6px' }}>
                    <input
                      type="checkbox"
                      id="vertDispToggle"
                      checked={verticalDisplacement}
                      onChange={(e) => setVerticalDisplacement(e.target.checked)}
                    />
                    <label htmlFor="vertDispToggle">
                      Vertical Displacement
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '4px' }}>
                        d<sub>vert</sub> = d<sub>LOS</sub> / cos({'\u03B8'})
                      </span>
                    </label>
                  </div>
                )}

                {/* Symmetric range presets */}
                <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', width: '100%', marginBottom: '2px' }}>Range Presets</span>
                  {(() => {
                    const scale = losDisplacement ? 0.2384 / (4 * Math.PI) : 1;
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
                        style={{ flex: 1, fontSize: '0.65rem', padding: '2px 4px', minWidth: '40px' }}
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
                    fontSize: '0.6rem',
                    padding: '3px 6px',
                    border: `1px solid ${active ? 'var(--sardine-cyan)' : 'var(--border)'}`,
                    borderRadius: '3px',
                    background: active ? 'var(--sardine-cyan)' : 'transparent',
                    color: active ? '#000' : 'var(--text)',
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
                  const availableKeys = Object.keys(CORRECTION_TYPES).filter(k => !!correctionLayers[k]);
                  const allEnabled = availableKeys.length > 0 && availableKeys.every(k => enabledCorrections.has(k));
                  return (
                    <div style={{ marginTop: '8px', borderTop: '1px solid var(--border)', paddingTop: '6px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Phase Corrections</span>
                        <button
                          style={{ ...btnStyle(allEnabled), fontSize: '0.55rem', padding: '2px 5px' }}
                          onClick={() => { setEnabledCorrections(allEnabled ? new Set() : new Set(availableKeys)); resetContrast(); }}
                        >{allEnabled ? 'Clear All' : 'Apply All'}</button>
                      </div>
                      {/* Ionosphere — same-grid correction */}
                      {correctionLayers.ionosphere && (
                        <div style={{ marginBottom: '3px' }}>
                          <button style={btnStyle(enabledCorrections.has('ionosphere'))} onClick={() => toggle('ionosphere')}>
                            Ionosphere
                          </button>
                        </div>
                      )}
                      {/* Metadata cube corrections */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                        {correctionLayers.troposphereWet && (
                          <button style={btnStyle(enabledCorrections.has('troposphereWet'))} onClick={() => toggle('troposphereWet')}>
                            Tropo (Wet)
                          </button>
                        )}
                        {correctionLayers.troposphereHydrostatic && (
                          <button style={btnStyle(enabledCorrections.has('troposphereHydrostatic'))} onClick={() => toggle('troposphereHydrostatic')}>
                            Tropo (Hydro)
                          </button>
                        )}
                        {correctionLayers.solidEarthTides && (
                          <button style={btnStyle(enabledCorrections.has('solidEarthTides'))} onClick={() => toggle('solidEarthTides')}>
                            Solid Earth Tides
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
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <label>Brightness</label>
                  <span className="value-display">
                    {Math.round((contrastMin + contrastMax) / 2)}{effectiveUseDecibels ? ' dB' : ''}
                  </span>
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

            {/* Saturation — only shown in RGB display modes */}
            {isRGBDisplayMode && imageData?.getRGBTile && (
              <div className="control-group">
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <label>Saturation</label>
                  <span className="value-display">{rgbSaturation.toFixed(2)}</span>
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
              <div className="control-group">
                <label>Color deficiency</label>
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
              </div>
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
                  <label htmlFor="maskInvalid" style={{ margin: 0 }}>
                    Mask invalid
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '4px' }}>
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
                  <label htmlFor="maskLayoverShadow" style={{ margin: 0 }}>
                    Mask layover/shadow
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '4px' }}>
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
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '4px' }}>
                      {useIncidenceAngleMask ? `${incAngleMin}°–${incAngleMax}°` : '(off)'}
                    </span>
                  </label>
                </div>
                {useIncidenceAngleMask && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Near range (min)</span>
                      <span className="value-display">{incAngleMin}°</span>
                    </div>
                    <input
                      type="range" min={0} max={60} step={1}
                      value={incAngleMin}
                      onChange={(e) => setIncAngleMin(Number(e.target.value))}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Far range (max)</span>
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
                    }}
                    style={{ marginTop: '6px' }}
                  />
                )}
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
          {loading && <div className="loading">{fileType === 'cmr' ? 'Streaming NISAR metadata from DAAC...' : 'Loading...'}</div>}

          {error && <div className="error">{error}</div>}

          {!loading && !error && !imageData && (
            <div className="loading">
              {fileType === 'cmr'
                ? (nisarDatasets.length > 0
                  ? 'Metadata loaded — select dataset options, then click "Load Dataset"'
                  : 'Search CMR and select a granule to begin')
                : fileType === 'local-tif'
                ? 'Select one or more local GeoTIFF files to begin'
                : fileType === 'remote'
                ? 'Enter a URL or browse remote data to begin'
                : fileType === 'catalog'
                  ? 'Load a GeoJSON scene catalog and select a scene to begin'
                  : 'Select a NISAR HDF5 file to begin'}
            </div>
          )}

          {/* GUNW Paired View: Phase + Coherence side-by-side */}
          {gunwPairedView && (
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
              <button
                onClick={() => setGunwPairedView(null)}
                style={{
                  position: 'absolute', top: '8px', right: '8px', zIndex: 10,
                  background: 'rgba(0,0,0,0.7)', color: 'var(--text-muted)',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                  padding: '2px 8px', fontSize: '0.65rem', cursor: 'pointer',
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

          {imageData && !gunwPairedView && (
            <div style={{ display: 'flex', width: '100%', height: '100%', position: 'relative' }}>
              {/* Loading overlay — shown on top of existing data while new data streams */}
              {loading && (
                <div style={{
                  position: 'absolute', inset: 0, zIndex: 10,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(10, 22, 40, 0.75)',
                  pointerEvents: 'none',
                }}>
                  <div style={{
                    fontFamily: 'var(--font-mono)', fontSize: '0.9rem',
                    color: 'var(--sardine-cyan, #4ec9d4)', letterSpacing: '1px',
                  }}>
                    Loading dataset...
                  </div>
                </div>
              )}
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
                  useDecibels={effectiveUseDecibels}
                  colormap={colormap}
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
                  correctionLayers={correctionLayers}
                  enabledCorrections={enabledCorrections}
                  speckleFilterType={speckleFilterType}
                  speckleKernelSize={speckleKernelSize}
                  rgbSaturation={rgbSaturation}
                  colorblindMode={colorblindMode}
                  showGrid={showGrid}
                  opacity={1}
                  width="100%"
                  height="100%"
                  onViewStateChange={handleViewStateChange}
                  initialViewState={initialViewState}
                  extraLayers={[...overtureLayers, ...catalogLayers, ...stacLayers, ...geojsonOverlayLayers]}
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
                      ref={roiRGBViewerRef}
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
                      ref={roiTSViewerRef}
                      getTile={roiTSFrames[roiTSIndex]?.getTile}
                      tileVersion={roiTSIndex}
                      bounds={roiTSBounds}
                      contrastLimits={roiTSContrastLimits}
                      useDecibels={roiTSFrames[roiTSIndex]?.isRGB ? false : (nisarProductType === 'GUNW' ? false : useDecibels)}
                      compositeId={roiTSFrames[roiTSIndex]?.compositeId || null}
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
        <span style={{ color: 'var(--sardine-cyan, #4ec9d4)', opacity: 0.6, display: 'flex', alignItems: 'center', gap: '8px' }}>
          deck.gl{multiLook ? ' · multi-look' : ''}
          {gpuInfo.webgpu
            ? ' · WebGPU'
            : <span style={{ color: '#f5a623' }}> · no WebGPU (histogram CPU-only)</span>}
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            · workers:
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
              style={{ width: '60px', accentColor: 'var(--sardine-cyan, #4ec9d4)' }}
            />
            {workerCount}
          </span>
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
