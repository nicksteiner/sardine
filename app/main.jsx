import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { SARViewer, loadCOG, autoContrastLimits } from '../src/index.js';

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
    `- **View:** [${state.view.center[0].toFixed(4)}, ${state.view.center[1].toFixed(4)}], zoom ${state.view.zoom.toFixed(2)}`,
  ];
  
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

  // Viewer settings
  const [colormap, setColormap] = useState('grayscale');
  const [useDecibels, setUseDecibels] = useState(true);
  const [contrastMin, setContrastMin] = useState(-25);
  const [contrastMax, setContrastMax] = useState(0);
  const [viewCenter, setViewCenter] = useState([0, 0]);
  const [viewZoom, setViewZoom] = useState(0);

  // Markdown state
  const [markdownState, setMarkdownState] = useState('');
  const [isMarkdownEdited, setIsMarkdownEdited] = useState(false);
  const markdownUpdateRef = useRef(false);

  // Generate markdown from current state
  const currentState = useMemo(() => ({
    file: cogUrl,
    contrastMin,
    contrastMax,
    colormap,
    useDecibels,
    view: { center: viewCenter, zoom: viewZoom },
  }), [cogUrl, contrastMin, contrastMax, colormap, useDecibels, viewCenter, viewZoom]);

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
    
    // Update state from parsed markdown
    if (parsed.file !== cogUrl && parsed.file && parsed.file !== '(none)') {
      setCogUrl(parsed.file);
      // Load the COG if file changed
      setLoading(true);
      setError(null);
      try {
        const data = await loadCOG(parsed.file);
        setImageData(data);
      } catch (e) {
        setError(`Failed to load COG: ${e.message}`);
        setImageData(null);
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
    
    setIsMarkdownEdited(false);
    markdownUpdateRef.current = false;
  }, [markdownState, cogUrl]);

  // Load COG
  const handleLoadCOG = useCallback(async () => {
    if (!cogUrl) {
      setError('Please enter a COG URL');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await loadCOG(cogUrl);
      setImageData(data);

      // Auto-calculate contrast limits
      if (data.getTile) {
        try {
          const sampleTile = await data.getTile({ x: 0, y: 0, z: 0 });
          if (sampleTile && sampleTile.data) {
            const limits = autoContrastLimits(sampleTile.data, useDecibels);
            setContrastMin(Math.round(limits[0]));
            setContrastMax(Math.round(limits[1]));
          }
        } catch (e) {
          console.warn('Could not auto-calculate contrast limits:', e);
        }
      }

      // Update view to fit bounds
      if (data.bounds) {
        const [minX, minY, maxX, maxY] = data.bounds;
        setViewCenter([(minX + maxX) / 2, (minY + maxY) / 2]);
        const spanX = maxX - minX;
        const spanY = maxY - minY;
        const zoom = Math.log2(360 / Math.max(spanX, spanY)) - 1;
        setViewZoom(Math.max(-2, Math.min(zoom, 10)));
      }
    } catch (e) {
      setError(`Failed to load COG: ${e.message}`);
      setImageData(null);
    } finally {
      setLoading(false);
    }
  }, [cogUrl, useDecibels]);

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
              Enter a Cloud Optimized GeoTIFF URL and click Load to begin
            </div>
          )}

          {imageData && (
            <SARViewer
              getTile={imageData.getTile}
              bounds={imageData.bounds}
              contrastLimits={[contrastMin, contrastMax]}
              useDecibels={useDecibels}
              colormap={colormap}
              opacity={1}
              width="100%"
              height="100%"
              onViewStateChange={handleViewStateChange}
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
    </div>
  );
}

// Mount the app
const container = document.getElementById('app');
const root = createRoot(container);
root.render(<App />);
