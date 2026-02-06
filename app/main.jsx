import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { SARViewer, loadCOG, loadCOGFullImage, autoContrastLimits, loadMultiBandCOG, loadTemporalCOGs } from '../src/index.js';
import { StatusWindow } from '../src/components/StatusWindow.jsx';

/**
 * Parse markdown state into object
 * @param {string} markdown - Markdown state string
 * @returns {Object} Parsed state object
 */
function parseMarkdownState(markdown) {
  const state = {
    file: '',
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
    
    // Parse file
    const fileMatch = trimmed.match(/\*\*File:\*\*\s*(.+)/);
    if (fileMatch) {
      state.file = fileMatch[1].trim();
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
    `- **File:** ${state.file || '(none)'}`,
    `- **Contrast:** ${state.contrastMin} to ${state.contrastMax}${state.useDecibels ? ' dB' : ''}`,
    `- **Colormap:** ${state.colormap}`,
    `- **dB Mode:** ${state.useDecibels ? 'on' : 'off'}`,
    `- **Tone Mapping:** ${state.toneMapEnabled ? 'on' : 'off'}`,
  ];

  if (state.toneMapEnabled) {
    lines.push(`- **Tone Map Method:** ${state.toneMapMethod}`);
    lines.push(`- **Tone Map Gamma:** ${state.toneMapGamma.toFixed(2)}`);
    lines.push(`- **Tone Map Strength:** ${state.toneMapStrength.toFixed(2)}`);
  }

  lines.push(`- **View:** [${state.view.center[0].toFixed(4)}, ${state.view.center[1].toFixed(4)}], zoom ${state.view.zoom.toFixed(2)}`);

  return lines.join('\n');
}

/**
 * SARdine - SAR Imagery Viewer Application
 * Phase 1: Basic Viewer + Phase 2: State as Markdown
 */
function App() {
  // Core state
  const [cogUrl, setCogUrl] = useState('');
  const [imageData, setImageData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Multi-file state
  const [multiFileMode, setMultiFileMode] = useState(false);
  const [multiFileModeType, setMultiFileModeType] = useState('multi-band'); // 'multi-band' or 'temporal'
  const [fileList, setFileList] = useState(['']); // Array of URLs
  const [bandNames, setBandNames] = useState([]); // Auto-detected or manual

  // Viewer settings
  const [colormap, setColormap] = useState('grayscale');
  const [useDecibels, setUseDecibels] = useState(true);
  const [contrastMin, setContrastMin] = useState(-25);
  const [contrastMax, setContrastMax] = useState(0);
  const [viewCenter, setViewCenter] = useState([0, 0]);
  const [viewZoom, setViewZoom] = useState(0);

  // Tone mapping settings
  const [toneMapEnabled, setToneMapEnabled] = useState(false);
  const [toneMapMethod, setToneMapMethod] = useState('auto');
  const [toneMapGamma, setToneMapGamma] = useState(0.5);
  const [toneMapStrength, setToneMapStrength] = useState(0.3);

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

  // Memoize tone mapping config
  const toneMapping = useMemo(() => ({
    enabled: toneMapEnabled,
    method: toneMapMethod === 'auto' ? undefined : toneMapMethod,
    params: {
      gamma: toneMapGamma,
      strength: toneMapStrength,
    },
  }), [toneMapEnabled, toneMapMethod, toneMapGamma, toneMapStrength]);

  // Generate markdown from current state
  const currentState = useMemo(() => ({
    file: cogUrl,
    contrastMin,
    contrastMax,
    colormap,
    useDecibels,
    toneMapEnabled,
    toneMapMethod,
    toneMapGamma,
    toneMapStrength,
    view: { center: viewCenter, zoom: viewZoom },
  }), [cogUrl, contrastMin, contrastMax, colormap, useDecibels, toneMapEnabled, toneMapMethod, toneMapGamma, toneMapStrength, viewCenter, viewZoom]);

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
    setToneMapEnabled(parsed.toneMapEnabled);
    setToneMapMethod(parsed.toneMapMethod);
    setToneMapGamma(parsed.toneMapGamma);
    setToneMapStrength(parsed.toneMapStrength);
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
          {/* Load Section */}
          <div className="control-section">
            <h3>Load Image</h3>

            <div className="control-group">
              <div className="control-row">
                <input
                  type="checkbox"
                  id="multiFileMode"
                  checked={multiFileMode}
                  onChange={(e) => {
                    setMultiFileMode(e.target.checked);
                    if (e.target.checked && fileList.length === 1 && fileList[0] === '') {
                      setFileList(['', '']);
                    }
                  }}
                />
                <label htmlFor="multiFileMode">Multi-file mode</label>
              </div>
            </div>

            {multiFileMode ? (
              <>
                <div className="control-group">
                  <label>Mode Type</label>
                  <select
                    value={multiFileModeType}
                    onChange={(e) => setMultiFileModeType(e.target.value)}
                  >
                    <option value="multi-band">Multi-band (VV+VH, R+G+B)</option>
                    <option value="temporal">Temporal (pre/post event)</option>
                  </select>
                </div>

                <div style={{ fontSize: '11px', padding: '6px 8px', background: 'rgba(100, 150, 255, 0.1)', borderRadius: '4px', marginBottom: '8px', border: '1px solid rgba(100, 150, 255, 0.3)' }}>
                  <strong>Note:</strong> All files must be valid Cloud Optimized GeoTIFFs with the same dimensions and coordinate system. Band names will be auto-detected from filenames (e.g., "_VV_", "_VH_").
                </div>

                <div className="control-group">
                  <label>Files ({fileList.length})</label>
                  {fileList.map((file, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: '4px', marginBottom: '4px' }}>
                      <input
                        type="text"
                        value={file}
                        onChange={(e) => {
                          const newList = [...fileList];
                          newList[idx] = e.target.value;
                          setFileList(newList);
                        }}
                        placeholder={`File ${idx + 1} URL`}
                        style={{ flex: 1 }}
                      />
                      {fileList.length > 1 && (
                        <button
                          onClick={() => {
                            const newList = fileList.filter((_, i) => i !== idx);
                            setFileList(newList.length === 0 ? [''] : newList);
                            if (bandNames.length > idx) {
                              const newBands = bandNames.filter((_, i) => i !== idx);
                              setBandNames(newBands);
                            }
                          }}
                          style={{ padding: '4px 8px', fontSize: '12px' }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => setFileList([...fileList, ''])}
                    style={{ width: '100%', marginTop: '4px' }}
                  >
                    + Add File
                  </button>
                </div>

                {bandNames.length > 0 && (
                  <div className="control-group">
                    <label>Detected Bands</label>
                    <div style={{ fontSize: '11px', padding: '4px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px' }}>
                      {bandNames.join(', ')}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="control-group">
                <label>COG URL</label>
                <input
                  type="text"
                  value={cogUrl}
                  onChange={(e) => setCogUrl(e.target.value)}
                  placeholder="https://bucket.s3.amazonaws.com/image.tif"
                />
              </div>
            )}

            <button onClick={handleLoadCOG} disabled={loading}>
              {loading ? 'Loading...' : multiFileMode ? 'Load Multi-file Dataset' : 'Load COG'}
            </button>
          </div>

          {/* Display Settings */}
          <div className="control-section">
            <h3>Display</h3>
            
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
                disabled={toneMapEnabled}
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
                disabled={toneMapEnabled}
              />
            </div>
          </div>

          {/* Tone Mapping Settings */}
          <div className="control-section">
            <h3>Tone Mapping</h3>

            <div className="control-group">
              <div className="control-row">
                <input
                  type="checkbox"
                  id="toneMapEnabled"
                  checked={toneMapEnabled}
                  onChange={(e) => setToneMapEnabled(e.target.checked)}
                />
                <label htmlFor="toneMapEnabled">Enable Adaptive Tone Mapping</label>
              </div>
            </div>

            {toneMapEnabled && (
              <>
                <div className="control-group">
                  <label>Method</label>
                  <select value={toneMapMethod} onChange={(e) => setToneMapMethod(e.target.value)}>
                    <option value="auto">Auto (Scene Analysis)</option>
                    <option value="adaptiveLog">Adaptive Log</option>
                    <option value="percentileGamma">Percentile + Gamma</option>
                    <option value="localContrast">Local Contrast</option>
                    <option value="hybrid">Hybrid</option>
                  </select>
                </div>

                <div className="control-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <label>Gamma</label>
                    <span className="value-display">{toneMapGamma.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={2}
                    step={0.05}
                    value={toneMapGamma}
                    onChange={(e) => setToneMapGamma(Number(e.target.value))}
                  />
                </div>

                <div className="control-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <label>Strength</label>
                    <span className="value-display">{toneMapStrength.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={toneMapStrength}
                    onChange={(e) => setToneMapStrength(Number(e.target.value))}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {/* Viewer Container */}
        <div className="viewer-container">
          {loading && <div className="loading">Loading COG...</div>}

          {error && <div className="error">{error}</div>}

          {!loading && !error && !imageData && (
            <div className="loading">
              Enter a Cloud Optimized GeoTIFF URL and click Load to begin
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
              opacity={1}
              toneMapping={toneMapping}
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
