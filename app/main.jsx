import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/sardine-theme.css';
import { SARViewer, loadCOG, loadCOGFullImage, autoContrastLimits, loadNISARGCOV, listNISARDatasets, loadMultiBandCOG, loadTemporalCOGs } from '../src/index.js';
import { loadNISARRGBComposite, listNISARDatasetsFromUrl, loadNISARGCOVFromUrl } from '../src/loaders/nisar-loader.js';
import { autoSelectComposite, getAvailableComposites, getRequiredDatasets, getRequiredComplexDatasets } from '../src/utils/sar-composites.js';
import { DataDiscovery } from '../src/components/DataDiscovery.jsx';
import { writeRGBAGeoTIFF, writeFloat32GeoTIFF, downloadBuffer } from '../src/utils/geotiff-writer.js';
import { createRGBTexture, computeRGBBands } from '../src/utils/sar-composites.js';
import { computeChannelStats, sampleViewportStats } from '../src/utils/stats.js';
import { StatusWindow } from '../src/components/StatusWindow.jsx';
import { MetadataPanel } from '../src/components/MetadataPanel.jsx';
import { OverviewMap } from '../src/components/OverviewMap.jsx';
import { HistogramPanel } from '../src/components/Histogram.jsx';
import { exportFigure, exportRGBColorbar, downloadBlob } from '../src/utils/figure-export.js';
import { STRETCH_MODES, applyStretch } from '../src/utils/stretch.js';
import { getColormap } from '../src/utils/colormap.js';
import { OVERTURE_THEMES, fetchAllOvertureThemes, projectedToWGS84 } from '../src/loaders/overture-loader.js';
import { createOvertureLayers } from '../src/layers/OvertureLayer.js';
import { SceneCatalog } from '../src/components/SceneCatalog.jsx';
import { STACSearch } from '../src/components/STACSearch.jsx';

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
  // Core state
  const [fileType, setFileType] = useState('remote'); // 'cog' | 'nisar' | 'remote'
  const [cogUrl, setCogUrl] = useState('');
  const [imageData, setImageData] = useState(null);
  const [tileVersion, setTileVersion] = useState(0); // bumped on progressive tile refinement
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Remote source state
  const [remoteUrl, setRemoteUrl] = useState(null);
  const [remoteName, setRemoteName] = useState(null);

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
  const [contrastMin, setContrastMin] = useState(-25);
  const [contrastMax, setContrastMax] = useState(0);
  const [gamma, setGamma] = useState(1.0);
  const [stretchMode, setStretchMode] = useState('linear');
  const [multiLook, setMultiLook] = useState(false);
  const [useMask, setUseMask] = useState(false);
  const [exportMultilookWindow, setExportMultilookWindow] = useState(4); // Multilook window for export (1, 2, 4, 8, 16)
  const [exportMode, setExportMode] = useState('raw'); // 'raw' (Float32) | 'rendered' (RGBA with dB/colormap)
  const [histogramScope, setHistogramScope] = useState('global'); // 'global' | 'viewport'
  const [viewCenter, setViewCenter] = useState([0, 0]);
  const [viewZoom, setViewZoom] = useState(0);

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
  const [statusCollapsed, setStatusCollapsed] = useState(false);

  // Overview map state
  const [overviewMapVisible, setOverviewMapVisible] = useState(false);

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

  // Helper to add status log
  const addStatusLog = useCallback((type, message, details = null) => {
    const timestamp = new Date().toLocaleTimeString();
    setStatusLogs(prev => [...prev, { type, message, details, timestamp }]);
  }, []);

  // Memoize arrays to prevent unnecessary re-renders
  const contrastLimits = useMemo(() => [contrastMin, contrastMax], [contrastMin, contrastMax]);

  // For RGB mode, use per-channel limits; for single-band, use uniform limits
  const effectiveContrastLimits = useMemo(() => {
    if (displayMode === 'rgb' && rgbContrastLimits) {
      return rgbContrastLimits;
    }
    return contrastLimits;
  }, [displayMode, rgbContrastLimits, contrastLimits]);

  // Auto-stretch: reset to 2-98% percentiles from cached histogram
  const handleAutoStretch = useCallback(() => {
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
  }, [histogramData, displayMode, addStatusLog]);

  // Recompute histogram (viewport-aware)
  const handleRecomputeHistogram = useCallback(async () => {
    if (!imageData || !imageData.getTile) {
      addStatusLog('warning', 'No tile data available for histogram');
      return;
    }

    addStatusLog('info', `Recomputing histogram (${histogramScope})...`);

    try {
      // Compute viewport region bounds (used for viewport scope)
      const vpHalfW = (imageData.width / Math.pow(2, viewZoom)) * 500;
      const vpHalfH = (imageData.height / Math.pow(2, viewZoom)) * 500;
      const cx = viewCenter[0];
      const cy = viewCenter[1];
      const vpLeft = Math.max(0, cx - vpHalfW);
      const vpRight = Math.min(imageData.width, cx + vpHalfW);
      const vpTop = Math.max(0, cy - vpHalfH);
      const vpBottom = Math.min(imageData.height, cy + vpHalfH);

      const isViewport = histogramScope === 'viewport';
      const regionX = isViewport ? vpLeft : 0;
      const regionY = isViewport ? vpTop : 0;
      const regionW = isViewport ? (vpRight - vpLeft) : imageData.width;
      const regionH = isViewport ? (vpBottom - vpTop) : imageData.height;
      const scopeLabel = isViewport ? 'Viewport' : 'Global';

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
            const wBottom = imageData.height - (regionY + (ty + 1) * stepY);
            const wTop = imageData.height - (regionY + ty * stepY);

            const tileData = await imageData.getRGBTile({
              x: tx, y: ty, z: 0,
              bbox: { left, top: wBottom, right, bottom: wTop },
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

        addStatusLog('info', 'Histogram: computing statistics...');
        const hists = {};
        for (const ch of ['R', 'G', 'B']) {
          hists[ch] = computeChannelStats(rawValues[ch], useDecibels);
        }
        setHistogramData(hists);
        addStatusLog('success', `${scopeLabel} histogram updated (RGB)`);
      } else {
        // Single-band histogram — pass origin offset for correct viewport sampling
        const stats = await sampleViewportStats(
          imageData.getTile, regionW, regionH, useDecibels, 128,
          regionX, regionY, imageData.height,
          (done, total) => addStatusLog('info', `Histogram: sampling tile ${done}/${total}`),
        );
        if (stats) {
          setHistogramData({ single: stats });
          addStatusLog('success', `${scopeLabel} histogram: ${stats.p2.toFixed(1)} to ${stats.p98.toFixed(1)}`);
        }
      }
    } catch (e) {
      addStatusLog('warning', 'Histogram recompute failed', e.message);
    }
  }, [imageData, histogramScope, viewCenter, viewZoom, displayMode, compositeId, useDecibels, addStatusLog]);

  // Auto-recompute histogram when scope changes
  const histogramScopeRef = useRef(histogramScope);
  useEffect(() => {
    if (histogramScope !== histogramScopeRef.current) {
      histogramScopeRef.current = histogramScope;
      if (imageData) handleRecomputeHistogram();
    }
  }, [histogramScope, imageData, handleRecomputeHistogram]);

  // Recompute histogram when switching between dB and linear mode
  const useDecibelsRef = useRef(useDecibels);
  useEffect(() => {
    if (useDecibels !== useDecibelsRef.current) {
      useDecibelsRef.current = useDecibels;
      // Recompute histogram in the new scale
      if (imageData && displayMode === 'single') {
        handleRecomputeHistogram();
      }
    }
  }, [useDecibels, imageData, displayMode, handleRecomputeHistogram]);

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

  // Load remote NISAR dataset by URL
  const handleLoadRemoteNISAR = useCallback(async () => {
    if (!remoteUrl) return;

    setLoading(true);
    setError(null);
    addStatusLog('info', `Loading remote NISAR: ${selectedFrequency}/${selectedPolarization}`);

    try {
      const data = await loadNISARGCOVFromUrl(remoteUrl, {
        frequency: selectedFrequency,
        polarization: selectedPolarization,
        _streamReader: handleRemoteFileSelect._cachedReader || null,
      });

      // Progressive refinement: when background Phase 2 completes, bump version
      // so SARViewer re-creates its TileLayer and fetches the refined tiles.
      if (data.mode === 'streaming') {
        data.onRefine = () => setTileVersion(v => v + 1);
        // Eagerly warm chunk cache with coarse overview grid
        if (data.prefetchOverviewChunks) {
          data.prefetchOverviewChunks().catch(e =>
            console.warn('[SARdine] Overview prefetch failed:', e.message)
          );
        }
      }

      setImageData(data);

      // Auto-fit view
      const bounds = data.worldBounds || data.bounds;
      if (bounds) {
        const cx = (bounds[0] + bounds[2]) / 2;
        const cy = (bounds[1] + bounds[3]) / 2;
        setViewCenter([cx, cy]);
        const span = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]);
        setViewZoom(Math.log2(360 / span) - 1);
      }

      addStatusLog('success', `Remote NISAR loaded: ${data.width}×${data.height}`,
        `URL: ${remoteUrl}`);
    } catch (e) {
      setError(`Failed to load remote NISAR: ${e.message}`);
      addStatusLog('error', 'Remote load failed', e.message);
    } finally {
      setLoading(false);
    }
  }, [remoteUrl, selectedFrequency, selectedPolarization, addStatusLog]);

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

      // Update view to fit bounds
      if (data.bounds) {
        const [minX, minY, maxX, maxY] = data.bounds;
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        setViewCenter([centerX, centerY]);

        const spanX = maxX - minX;
        const spanY = maxY - minY;
        const maxSpan = Math.max(spanX, spanY);
        const viewportSize = 1000;
        const zoom = Math.log2(viewportSize / maxSpan);

        setViewZoom(zoom);
        addStatusLog('info', 'View state updated',
          `Center: [${centerX.toFixed(0)}, ${centerY.toFixed(0)}], Zoom: ${zoom.toFixed(2)}`);
      }

      // Compute histograms for per-channel contrast
      try {
        if (displayMode === 'rgb' && data.getRGBTile) {
          addStatusLog('info', 'Computing per-channel histograms (linear)...');
          const tileSize = 256;
          const gridSize = 3;
          const stepX = data.width / gridSize;
          const stepY = data.height / gridSize;
          const rawValues = { R: [], G: [], B: [] };

          for (let ty = 0; ty < gridSize; ty++) {
            for (let tx = 0; tx < gridSize; tx++) {
              const left = tx * stepX;
              const right = (tx + 1) * stepX;
              const worldBottom = data.height - (ty + 1) * stepY;
              const worldTop = data.height - ty * stepY;

              const tileData = await data.getRGBTile({
                x: tx, y: ty, z: 0,
                bbox: { left, top: worldBottom, right, bottom: worldTop },
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
            const st = computeChannelStats(rawValues[ch], false);
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
          const stats = await sampleViewportStats(data.getTile, data.width, data.height, useDecibels);
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
  }, [nisarFile, selectedFrequency, selectedPolarization, displayMode, compositeId, addStatusLog]);

  // Export current view as GeoTIFF
  const [exporting, setExporting] = useState(false);

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

    try {
      const sourceWidth = imageData.width;
      const sourceHeight = imageData.height;

      // Use the user's selected multilook factor directly
      let effectiveMl = exportMultilookWindow || 1;
      const exportWidth = Math.floor(sourceWidth / effectiveMl);
      const exportHeight = Math.floor(sourceHeight / effectiveMl);

      // Check per-band size — each Float32Array must fit in one JS ArrayBuffer (~2GB).
      // Bands are separate allocations so total across bands is fine; the constraint
      // is per-array, not aggregate.
      const perBandBytes = exportWidth * exportHeight * 4;
      const MAX_SINGLE_ARRAY = 1.8e9; // ~1.8GB per Float32Array (leave headroom below 2GB JS limit)
      if (perBandBytes > MAX_SINGLE_ARRAY) {
        const suggestedMl = effectiveMl * 2;
        addStatusLog('error', `Single band too large (${(perBandBytes / 1e9).toFixed(1)}GB). Increase multilook to ${suggestedMl}x or higher.`);
        setExporting(false);
        return;
      }

      // Extract EPSG from CRS string
      const epsgMatch = imageData.crs?.match(/EPSG:(\d+)/);
      const epsgCode = epsgMatch ? parseInt(epsgMatch[1]) : 32610;

      // Band names from the loaded data's required polarizations
      // Single-band: ['HHHH'], RGB composite: ['HHHH', 'HVHV', 'VVVV'], etc.
      const bandNames = imageData.requiredPols || [imageData.polarization || 'HHHH'];

      addStatusLog('info', `Source: ${sourceWidth} x ${sourceHeight}`);
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

      // Allocate output arrays for each band
      const bands = {};
      for (const name of bandNames) {
        bands[name] = new Float32Array(exportWidth * exportHeight);
      }

      // Stripe-based reading: 256 output rows per stripe
      const stripeRows = 256;
      const numStripes = Math.ceil(exportHeight / stripeRows);

      for (let s = 0; s < numStripes; s++) {
        const startRow = s * stripeRows;
        const numRows = Math.min(stripeRows, exportHeight - startRow);

        addStatusLog('info', `Reading stripe ${s + 1}/${numStripes} (rows ${startRow}-${startRow + numRows - 1})...`);

        const stripe = await imageData.getExportStripe({
          startRow,
          numRows,
          ml: effectiveMl,
          exportWidth,
        });

        // Copy stripe data into output arrays
        for (const name of bandNames) {
          if (stripe.bands[name]) {
            bands[name].set(stripe.bands[name], startRow * exportWidth);
          }
        }
      }

      // --- Append metadata cube fields as extra bands ---
      if (imageData.metadataCube && imageData.xCoords && imageData.yCoords) {
        addStatusLog('info', 'Evaluating metadata cube fields on export grid...');
        try {
          const cubeFields = imageData.metadataCube.evaluateAllFields(
            imageData.xCoords,
            imageData.yCoords,
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
      const exportBounds = [
        geoBounds[0] - nativeSpacingX / 2,                                             // minX edge
        geoBounds[1] - nativeSpacingY / 2,                                             // minY edge
        geoBounds[0] - nativeSpacingX / 2 + exportWidth * effectiveMl * nativeSpacingX,  // maxX edge
        geoBounds[1] - nativeSpacingY / 2 + exportHeight * effectiveMl * nativeSpacingY, // maxY edge
      ];

      const exportPixelX = (exportBounds[2] - exportBounds[0]) / exportWidth;
      const exportPixelY = (exportBounds[3] - exportBounds[1]) / exportHeight;

      addStatusLog('info', `Pixel scale: ${exportPixelX.toFixed(1)}m x ${exportPixelY.toFixed(1)}m`);
      addStatusLog('info', `Bounds (pixel-edge): [${exportBounds.map(b => b.toFixed(1)).join(', ')}]`);

      let geotiff;
      let filename;

      if (isRendered) {
        // --- Rendered export: apply same pipeline as GPU shader ---
        // Spatial smoothing: the export at ml=N averages N×N source pixels per
        // output pixel, but the on-screen display at overview zoom implicitly
        // averages far more (hundreds at low zoom).  A 3×3 post-multilook
        // box-filter bridges the gap, raising the effective look count by ~9×
        // (e.g. ml=4 → 16 looks → ~144 effective looks after smoothing).
        // This is especially important for ratio channels (HH/HV) where
        // residual speckle is amplified by the division.
        const smoothKernel = 3;
        addStatusLog('info', `Smoothing bands: ${smoothKernel}×${smoothKernel} box filter (speckle reduction)...`);
        for (const name of bandNames) {
          bands[name] = smoothBand(bands[name], exportWidth, exportHeight, smoothKernel);
        }

        const numPixels = exportWidth * exportHeight;
        let rgbaData;

        if (displayMode === 'rgb' && compositeId) {
          // RGB composite: apply computeRGBBands (same transform as GPU tile path)
          // then per-channel dB/contrast/stretch via createRGBTexture
          addStatusLog('info', `Applying RGB composite "${compositeId}" + per-channel contrast...`);
          const rgbBands = computeRGBBands(bands, compositeId, exportWidth, exportWidth * exportHeight);
          const rgbImageData = createRGBTexture(
            rgbBands, exportWidth, exportHeight,
            effectiveContrastLimits,  // per-channel {R:[min,max], G:[min,max], B:[min,max]}
            useDecibels, gamma, stretchMode
          );
          rgbaData = new Uint8ClampedArray(rgbImageData.data);
        } else {
          // Single-band: apply colormap
          addStatusLog('info', `Applying ${useDecibels ? 'dB' : 'linear'} + ${colormap} colormap...`);
          const colormapFunc = getColormap(colormap);
          const cMin = contrastMin;
          const cMax = contrastMax;
          const needsStretch = stretchMode !== 'linear' || gamma !== 1.0;
          rgbaData = new Uint8ClampedArray(numPixels * 4);
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
        }

        addStatusLog('info', 'Writing RGBA GeoTIFF...');
        geotiff = writeRGBAGeoTIFF(rgbaData, exportWidth, exportHeight, exportBounds, epsgCode, {
          generateOverviews: false,
          onProgress: (pct) => {
            if (pct % 20 === 0 && pct > 0 && pct < 100) {
              addStatusLog('info', `Encoding: ${pct}%`);
            }
          }
        });

        filename = `sardine_${bandNames.join('-')}_${colormap}_ml${effectiveMl}_${exportWidth}x${exportHeight}.tif`;
      } else {
        // --- Raw export: Float32 linear power ---
        addStatusLog('info', 'Writing Float32 GeoTIFF...');
        geotiff = writeFloat32GeoTIFF(bands, bandNames, exportWidth, exportHeight, exportBounds, epsgCode, {
          onProgress: (pct) => {
            if (pct % 20 === 0 && pct > 0 && pct < 100) {
              addStatusLog('info', `Encoding: ${pct}%`);
            }
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
    }
  }, [imageData, exportMultilookWindow, exportMode, contrastMin, contrastMax, useDecibels, colormap, stretchMode, gamma, displayMode, compositeId, effectiveContrastLimits, addStatusLog]);

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
  }, [colormap, effectiveContrastLimits, useDecibels, displayMode, compositeId, imageData, fileType, nisarFile, cogUrl, addStatusLog]);

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
    return createOvertureLayers(overtureData, { opacity: overtureOpacity });
  }, [overtureEnabled, overtureData, overtureOpacity]);

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
              <label>File Type</label>
              <select value={fileType} onChange={(e) => setFileType(e.target.value)}>
                <option value="cog">Cloud Optimized GeoTIFF (URL)</option>
                <option value="nisar">NISAR GCOV HDF5 (Local File)</option>
                <option value="remote">Remote Bucket / S3</option>
                <option value="catalog">Scene Catalog (GeoJSON)</option>
                <option value="stac">STAC Catalog Search</option>
              </select>
            </div>
          </CollapsibleSection>

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
              <DataDiscovery
                onSelectFile={handleRemoteFileSelect}
                onStatus={addStatusLog}
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

                  <button onClick={handleLoadRemoteNISAR} disabled={loading}>
                    {loading ? 'Loading...' : 'Load Remote Dataset'}
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

                  <button onClick={handleLoadRemoteNISAR} disabled={loading}>
                    {loading ? 'Loading...' : 'Load Dataset'}
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

                  <button onClick={handleLoadRemoteNISAR} disabled={loading}>
                    {loading ? 'Loading...' : 'Load Dataset'}
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
            {displayMode !== 'rgb' && (
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

            {/* Export buttons */}
            {imageData && (
              <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                {imageData?.getExportStripe && (
                  <button
                    onClick={handleExportGeoTIFF}
                    disabled={exporting}
                    style={{ flex: 1 }}
                  >
                    {exporting ? 'Exporting...' : exportMode === 'raw' ? 'Export GeoTIFF (Float32)' : 'Export GeoTIFF (Rendered)'}
                  </button>
                )}
                <button
                  onClick={handleSaveFigure}
                  style={{ flex: 1 }}
                >
                  Save Figure (PNG)
                </button>
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
                  {['global', 'viewport'].map(scope => (
                    <button
                      key={scope}
                      className={histogramScope === scope ? '' : 'btn-secondary'}
                      style={{ flex: 1, fontSize: '0.7rem', padding: '3px 6px' }}
                      onClick={() => setHistogramScope(scope)}
                    >
                      {scope === 'global' ? 'Global' : 'Viewport'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* RGB per-channel histograms */}
            {displayMode === 'rgb' && histogramData && (
              <HistogramPanel
                histograms={histogramData}
                mode="rgb"
                contrastLimits={rgbContrastLimits || { R: [0, 1], G: [0, 1], B: [0, 1] }}
                useDecibels={useDecibels}
                onContrastChange={setRgbContrastLimits}
                onAutoStretch={handleAutoStretch}
                showHeader={false}
              />
            )}

            {/* Single-band histogram */}
            {displayMode !== 'rgb' && histogramData?.single && (
              <HistogramPanel
                histograms={histogramData}
                mode="single"
                contrastLimits={contrastLimits}
                useDecibels={useDecibels}
                onContrastChange={([min, max]) => {
                  setContrastMin(Math.round(min));
                  setContrastMax(Math.round(max));
                }}
                onAutoStretch={handleAutoStretch}
                showHeader={false}
              />
            )}

            {/* Brightness (Window/Level) slider — shifts window center */}
            {displayMode !== 'rgb' && (
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
              {fileType === 'cog'
                ? 'Enter a Cloud Optimized GeoTIFF URL and click Load to begin'
                : fileType === 'catalog'
                  ? 'Load a GeoJSON scene catalog and select a scene to begin'
                  : 'Select a NISAR GCOV HDF5 file to begin'}
            </div>
          )}

          {(imageData || fileType === 'stac') && (
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
              showGrid={showGrid}
              opacity={1}
              // toneMapping={toneMapping}  // hidden — see tone mapping NOTE above
              width="100%"
              height="100%"
              onViewStateChange={handleViewStateChange}
              initialViewState={initialViewState}
              extraLayers={[...overtureLayers, ...catalogLayers, ...stacLayers]}
            />
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
    </div>
  );
}

// Mount the app (guard against Vite HMR re-execution)
const container = document.getElementById('app');
if (!container._reactRoot) {
  container._reactRoot = createRoot(container);
}
container._reactRoot.render(<App />);
