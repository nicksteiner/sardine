import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { SARViewer, loadCOG, loadCOGFullImage, autoContrastLimits, loadNISARGCOV, listNISARDatasets } from '../src/index.js';
import { loadNISARRGBComposite } from '../src/loaders/nisar-loader.js';
import { autoSelectComposite, getAvailableComposites, getRequiredDatasets } from '../src/utils/sar-composites.js';
import { writeRGBGeoTIFF, downloadBuffer } from '../src/utils/geotiff-writer.js';
import { createRGBTexture, computeRGBBands } from '../src/utils/sar-composites.js';
import { StatusWindow } from '../src/components/StatusWindow.jsx';

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
    `- **View:** [${state.view.center[0].toFixed(4)}, ${state.view.center[1].toFixed(4)}], zoom ${state.view.zoom.toFixed(2)}`,
  );

  return lines.join('\n');
}

/**
 * SARdine - SAR Imagery Viewer Application
 * Phase 1: Basic Viewer + Phase 2: State as Markdown
 */
function App() {
  // Core state
  const [fileType, setFileType] = useState('cog'); // 'cog' | 'nisar'
  const [cogUrl, setCogUrl] = useState('');
  const [imageData, setImageData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // NISAR-specific state
  const [nisarFile, setNisarFile] = useState(null);
  const [nisarDatasets, setNisarDatasets] = useState([]);
  const [selectedFrequency, setSelectedFrequency] = useState('A');
  const [selectedPolarization, setSelectedPolarization] = useState('HHHH');

  // RGB composite state
  const [displayMode, setDisplayMode] = useState('single'); // 'single' | 'rgb'
  const [compositeId, setCompositeId] = useState(null);
  const [availableComposites, setAvailableComposites] = useState([]);

  // Viewer settings
  const [colormap, setColormap] = useState('grayscale');
  const [useDecibels, setUseDecibels] = useState(true);
  const [quality, setQuality] = useState('fast');
  const [contrastMin, setContrastMin] = useState(-25);
  const [contrastMax, setContrastMax] = useState(0);
  const [viewCenter, setViewCenter] = useState([0, 0]);
  const [viewZoom, setViewZoom] = useState(0);

  // Markdown state
  const [markdownState, setMarkdownState] = useState('');
  const [isMarkdownEdited, setIsMarkdownEdited] = useState(false);

  // Memoize initialViewState to prevent infinite re-renders
  const initialViewState = useMemo(
    () => ({
      target: viewCenter,
      zoom: viewZoom,
    }),
    [viewCenter, viewZoom]
  );
  const markdownUpdateRef = useRef(false);

  // Status window state
  const [statusLogs, setStatusLogs] = useState([]);
  const [statusCollapsed, setStatusCollapsed] = useState(false);

  // Helper to add status log
  const addStatusLog = useCallback((type, message, details = null) => {
    const timestamp = new Date().toLocaleTimeString();
    setStatusLogs(prev => [...prev, { type, message, details, timestamp }]);
  }, []);

  // Memoize arrays to prevent unnecessary re-renders
  const contrastLimits = useMemo(() => [contrastMin, contrastMax], [contrastMin, contrastMax]);

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
    setViewCenter(parsed.view.center);
    setViewZoom(parsed.view.zoom);

    addStatusLog('success', 'Markdown state applied successfully');
    setIsMarkdownEdited(false);
    markdownUpdateRef.current = false;
  }, [markdownState, cogUrl, addStatusLog]);

  // Load COG
  const handleLoadCOG = useCallback(async () => {
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
  }, [cogUrl, useDecibels, addStatusLog]);

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

      const autoComposite = autoSelectComposite(datasets);
      if (autoComposite) {
        setCompositeId(autoComposite);
        setDisplayMode('rgb');
        addStatusLog('info', `Auto-selected RGB composite: ${composites.find(c => c.id === autoComposite)?.name || autoComposite}`);
      } else {
        setDisplayMode('single');
        setCompositeId(null);
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
        addStatusLog('info', `Loading RGB composite: ${compositeId} (${requiredPols.join(', ')})`);

        data = await loadNISARRGBComposite(nisarFile, {
          frequency: selectedFrequency,
          compositeId,
          requiredPols,
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

    setExporting(true);
    addStatusLog('info', 'Starting GeoTIFF export...');

    try {
      const exportWidth = Math.min(imageData.width, 4096);
      const exportHeight = Math.min(imageData.height, 4096);
      const tileSize = 256;

      // For RGB composite mode, read tiles and assemble
      if (displayMode === 'rgb' && imageData.getRGBTile && compositeId) {
        addStatusLog('info', `Exporting RGB composite at ${exportWidth}x${exportHeight}...`);

        // Create a grid of tiles to cover the image
        const tilesX = Math.ceil(exportWidth / tileSize);
        const tilesY = Math.ceil(exportHeight / tileSize);
        const rgba = new Uint8ClampedArray(exportWidth * exportHeight * 4);

        const stepX = imageData.width / exportWidth;
        const stepY = imageData.height / exportHeight;

        for (let ty = 0; ty < tilesY; ty++) {
          for (let tx = 0; tx < tilesX; tx++) {
            const tileLeft = tx * tileSize * stepX;
            const tileTop = ty * tileSize * stepY;
            const tileRight = Math.min((tx + 1) * tileSize * stepX, imageData.width);
            const tileBottom = Math.min((ty + 1) * tileSize * stepY, imageData.height);

            // Y-flip for OrthographicView coordinates
            const worldTop = imageData.height - tileBottom;
            const worldBottom = imageData.height - tileTop;

            const tileData = await imageData.getRGBTile({
              x: tx, y: ty, z: 0,
              bbox: { left: tileLeft, top: worldTop, right: tileRight, bottom: worldBottom },
              quality: 'high',
            });

            if (tileData && tileData.bands) {
              const rgbBands = computeRGBBands(tileData.bands, compositeId, tileSize);
              const tileImage = createRGBTexture(rgbBands, tileSize, tileSize, contrastLimits, useDecibels);

              // Copy tile into output
              const outStartX = tx * tileSize;
              const outStartY = ty * tileSize;
              for (let py = 0; py < tileSize && outStartY + py < exportHeight; py++) {
                for (let px = 0; px < tileSize && outStartX + px < exportWidth; px++) {
                  const srcIdx = (py * tileSize + px) * 4;
                  const dstIdx = ((outStartY + py) * exportWidth + (outStartX + px)) * 4;
                  rgba[dstIdx] = tileImage.data[srcIdx];
                  rgba[dstIdx + 1] = tileImage.data[srcIdx + 1];
                  rgba[dstIdx + 2] = tileImage.data[srcIdx + 2];
                  rgba[dstIdx + 3] = tileImage.data[srcIdx + 3];
                }
              }
            }
          }
          addStatusLog('info', `Export progress: ${Math.round((ty + 1) / tilesY * 100)}%`);
        }

        // Extract EPSG from CRS string
        const epsgMatch = imageData.crs?.match(/EPSG:(\d+)/);
        const epsgCode = epsgMatch ? parseInt(epsgMatch[1]) : 32610;

        const geotiff = writeRGBGeoTIFF(rgba, exportWidth, exportHeight, imageData.bounds, epsgCode);
        const filename = `sardine_rgb_${compositeId}_${exportWidth}x${exportHeight}.tif`;
        downloadBuffer(geotiff, filename);

        addStatusLog('success', `Exported: ${filename} (${(geotiff.byteLength / 1e6).toFixed(1)} MB)`);
      } else {
        addStatusLog('warning', 'Single-band GeoTIFF export not yet implemented. Use RGB composite mode.');
      }
    } catch (e) {
      addStatusLog('error', 'Export failed', e.message);
      console.error('GeoTIFF export error:', e);
    } finally {
      setExporting(false);
    }
  }, [imageData, displayMode, compositeId, contrastLimits, useDecibels, addStatusLog]);

  return (
    <div id="app">
      {/* Header */}
      <div className="header">
        <h1>🐟 SARdine</h1>
        <span className="subtitle">Prompt-driven SAR imagery analysis</span>
      </div>

      {/* Main Layout */}
      <div className="main-layout">
        {/* Controls Panel */}
        <div className="controls-panel">
          {/* Data Source Selection */}
          <div className="control-section">
            <h3>Data Source</h3>
            <div className="control-group">
              <label>File Type</label>
              <select value={fileType} onChange={(e) => setFileType(e.target.value)}>
                <option value="cog">Cloud Optimized GeoTIFF (URL)</option>
                <option value="nisar">NISAR GCOV HDF5 (Local File)</option>
              </select>
            </div>
          </div>

          {/* COG URL Input */}
          {fileType === 'cog' && (
            <div className="control-section">
              <h3>Load COG</h3>
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
            </div>
          )}

          {/* NISAR HDF5 Input */}
          {fileType === 'nisar' && (
            <div className="control-section">
              <h3>Load NISAR GCOV</h3>
              <div className="control-group">
                <label>HDF5 File</label>
                <input
                  type="file"
                  accept=".h5,.hdf5,.he5"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      handleNISARFileSelect(file);
                    }
                  }}
                  style={{ fontSize: '12px' }}
                />
              </div>

              {nisarFile && (
                <div className="control-group" style={{ fontSize: '12px', color: '#888' }}>
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
                      <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>
                        {availableComposites.find(c => c.id === compositeId)?.description || ''}
                      </div>
                    </div>
                  )}

                  <button onClick={handleLoadNISAR} disabled={loading}>
                    {loading ? 'Loading...' : displayMode === 'rgb' ? 'Load RGB Composite' : 'Load Dataset'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* Display Settings */}
          <div className="control-section">
            <h3>Display</h3>
            
            {/* Colormap selector — hidden in RGB composite mode */}
            {displayMode !== 'rgb' && (
              <div className="control-group">
                <label>Colormap</label>
                <select value={colormap} onChange={(e) => setColormap(e.target.value)}>
                  <option value="grayscale">Grayscale</option>
                  <option value="viridis">Viridis</option>
                  <option value="inferno">Inferno</option>
                  <option value="plasma">Plasma</option>
                  <option value="phase">Phase</option>
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
                  id="highQuality"
                  checked={quality === 'high'}
                  onChange={(e) => setQuality(e.target.checked ? 'high' : 'fast')}
                />
                <label htmlFor="highQuality">High Quality (slower)</label>
              </div>
            </div>

            {/* Export GeoTIFF */}
            {imageData && displayMode === 'rgb' && (
              <button
                onClick={handleExportGeoTIFF}
                disabled={exporting}
                style={{ marginTop: '8px', width: '100%' }}
              >
                {exporting ? 'Exporting...' : 'Export GeoTIFF'}
              </button>
            )}
          </div>

          {/* Contrast Settings */}
          <div className="control-section">
            <h3>Contrast</h3>
            
            <div className="control-group">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <label>Min</label>
                <span className="value-display">
                  {contrastMin}{useDecibels ? ' dB' : ''}
                </span>
              </div>
              <input
                type="range"
                min={useDecibels ? -50 : 0}
                max={useDecibels ? 0 : 100}
                value={contrastMin}
                onChange={(e) => setContrastMin(Number(e.target.value))}
              />
            </div>

            <div className="control-group">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <label>Max</label>
                <span className="value-display">
                  {contrastMax}{useDecibels ? ' dB' : ''}
                </span>
              </div>
              <input
                type="range"
                min={useDecibels ? -50 : 0}
                max={useDecibels ? 10 : 200}
                value={contrastMax}
                onChange={(e) => setContrastMax(Number(e.target.value))}
              />
            </div>
          </div>
        </div>

        {/* Viewer Container */}
        <div className="viewer-container">
          {loading && <div className="loading">Loading COG...</div>}

          {error && <div className="error">{error}</div>}

          {!loading && !error && !imageData && (
            <div className="loading">
              {fileType === 'cog'
                ? 'Enter a Cloud Optimized GeoTIFF URL and click Load to begin'
                : 'Select a NISAR GCOV HDF5 file to begin'}
            </div>
          )}

          {imageData && (
            <SARViewer
              cogUrl={imageData.cogUrl}
              getTile={imageData.getTile}
              imageData={imageData.data ? imageData : null}
              bounds={imageData.bounds}
              contrastLimits={contrastLimits}
              useDecibels={useDecibels}
              colormap={colormap}
              compositeId={displayMode === 'rgb' ? compositeId : null}
              quality={quality}
              opacity={1}
              width="100%"
              height="100%"
              onViewStateChange={handleViewStateChange}
              initialViewState={initialViewState}
            />
          )}
        </div>

        {/* State Panel (Phase 2) */}
        <div className="state-panel">
          <div className="state-panel-header">
            <h3>State (Markdown)</h3>
            <span className="badge">{isMarkdownEdited ? 'Edited' : 'Live'}</span>
          </div>
          <div className="state-content">
            <textarea
              className="state-textarea"
              value={markdownState}
              onChange={handleMarkdownChange}
              placeholder="State will appear here..."
              spellCheck={false}
            />
            {isMarkdownEdited && (
              <button className="apply-button" onClick={handleApplyMarkdown}>
                Apply Changes
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Status Window */}
      <StatusWindow
        logs={statusLogs}
        isCollapsed={statusCollapsed}
        onToggle={() => setStatusCollapsed(!statusCollapsed)}
      />
    </div>
  );
}

// Mount the app
const container = document.getElementById('app');
const root = createRoot(container);
root.render(<App />);
