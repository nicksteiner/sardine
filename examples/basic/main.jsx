import React, { useState, useCallback, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { SARViewer, MapViewer, loadCOG, autoContrastLimits } from '../../src/index.js';

/**
 * Basic SAR Viewer Example Application
 */
function App() {
  const [cogUrl, setCogUrl] = useState('');
  const [imageData, setImageData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Viewer settings
  const [colormap, setColormap] = useState('grayscale');
  const [useDecibels, setUseDecibels] = useState(true);
  const [contrastMin, setContrastMin] = useState(-25);
  const [contrastMax, setContrastMax] = useState(0);
  const [opacity, setOpacity] = useState(1);
  const [viewerType, setViewerType] = useState('basic');

  // Sample COG URLs (replace with actual URLs)
  const sampleUrls = [
    {
      name: 'Select a sample...',
      url: '',
    },
    {
      name: 'Sentinel-1 Sample',
      url: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s1-l1c/GRD/2023/1/1/IW/S1A_IW_GRDH_1SDV_20230101T000000_20230101T000029_046691_059853_rtc.tif',
    },
  ];

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
          // Use default limits if auto-calculation fails
          console.warn('Could not auto-calculate contrast limits:', e);
        }
      }
    } catch (e) {
      setError(`Failed to load COG: ${e.message}`);
      setImageData(null);
    } finally {
      setLoading(false);
    }
  }, [cogUrl, useDecibels]);

  const handleSampleSelect = useCallback((e) => {
    const url = e.target.value;
    setCogUrl(url);
  }, []);

  return (
    <div id="app">
      {/* Controls */}
      <div className="controls">
        <div className="control-group">
          <label>COG URL:</label>
          <input
            type="text"
            value={cogUrl}
            onChange={(e) => setCogUrl(e.target.value)}
            placeholder="https://example.com/image.tif"
            style={{ width: '300px' }}
          />
          <button onClick={handleLoadCOG} disabled={loading}>
            {loading ? 'Loading...' : 'Load'}
          </button>
        </div>

        <div className="control-group">
          <label>Samples:</label>
          <select onChange={handleSampleSelect}>
            {sampleUrls.map((sample, i) => (
              <option key={i} value={sample.url}>
                {sample.name}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label>Viewer:</label>
          <select value={viewerType} onChange={(e) => setViewerType(e.target.value)}>
            <option value="basic">Basic</option>
            <option value="map">Map Overlay</option>
          </select>
        </div>

        <div className="control-group">
          <label>Colormap:</label>
          <select value={colormap} onChange={(e) => setColormap(e.target.value)}>
            <option value="grayscale">Grayscale</option>
            <option value="viridis">Viridis</option>
            <option value="inferno">Inferno</option>
            <option value="plasma">Plasma</option>
            <option value="phase">Phase</option>
          </select>
        </div>

        <div className="control-group">
          <label>
            <input
              type="checkbox"
              checked={useDecibels}
              onChange={(e) => setUseDecibels(e.target.checked)}
            />
            {' Use dB'}
          </label>
        </div>

        <div className="control-group">
          <label>
            Min: {contrastMin}
            {useDecibels ? 'dB' : ''}
          </label>
          <input
            type="range"
            min={useDecibels ? -50 : 0}
            max={useDecibels ? 0 : 100}
            value={contrastMin}
            onChange={(e) => setContrastMin(Number(e.target.value))}
          />
        </div>

        <div className="control-group">
          <label>
            Max: {contrastMax}
            {useDecibels ? 'dB' : ''}
          </label>
          <input
            type="range"
            min={useDecibels ? -50 : 0}
            max={useDecibels ? 10 : 200}
            value={contrastMax}
            onChange={(e) => setContrastMax(Number(e.target.value))}
          />
        </div>

        <div className="control-group">
          <label>Opacity: {opacity.toFixed(1)}</label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
          />
        </div>
      </div>

      {/* Viewer */}
      <div className="viewer-container">
        {loading && <div className="loading">Loading COG...</div>}

        {error && <div className="error">{error}</div>}

        {!loading && !error && !imageData && (
          <div className="loading">
            Enter a Cloud Optimized GeoTIFF URL and click Load to begin
          </div>
        )}

        {imageData && viewerType === 'basic' && (
          <SARViewer
            getTile={imageData.getTile}
            bounds={imageData.bounds}
            contrastLimits={[contrastMin, contrastMax]}
            useDecibels={useDecibels}
            colormap={colormap}
            opacity={opacity}
            width="100%"
            height="100%"
          />
        )}

        {imageData && viewerType === 'map' && (
          <MapViewer
            getTile={imageData.getTile}
            bounds={imageData.bounds}
            contrastLimits={[contrastMin, contrastMax]}
            useDecibels={useDecibels}
            colormap={colormap}
            opacity={opacity}
            width="100%"
            height="100%"
          />
        )}
      </div>
    </div>
  );
}

// Mount the app
const container = document.getElementById('app');
const root = createRoot(container);
root.render(<App />);
