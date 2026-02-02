import React, { useState, useCallback, useMemo, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { SARTileLayer } from '../layers/SARTileLayer.js';
import { SARBitmapLayer } from '../layers/SARBitmapLayer.js';
import { SARTiledCOGLayer } from '../layers/SARTiledCOGLayer.js';
import { getColormap } from '../utils/colormap.js';
import { LoadingIndicator } from '../components/LoadingIndicator.jsx';
import { ScaleBar } from '../components/ScaleBar.jsx';

/**
 * SARViewer - Basic SAR image viewer component
 * Built on deck.gl with React
 */
export function SARViewer({
  getTile,
  imageData, // Full image data for BitmapLayer approach
  cogUrl, // COG URL for SARTiledCOGLayer approach
  bounds,
  contrastLimits = [-25, 0],
  useDecibels = true,
  colormap = 'grayscale',
  opacity = 1,
  width = '100%',
  height = '100%',
  onViewStateChange,
  initialViewState,
  style = {},
}) {
  // Calculate initial view state from bounds
  const defaultViewState = useMemo(() => {
    if (!bounds) {
      return {
        target: [0, 0],
        zoom: 0,
        minZoom: -10,
        maxZoom: 20,
      };
    }

    const [minX, minY, maxX, maxY] = bounds;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const maxSpan = Math.max(spanX, spanY);

    // Check if projected coordinates (large values indicate meters, not degrees)
    const isProjected = Math.abs(minX) > 180 || Math.abs(maxX) > 180;

    let zoom;
    if (isProjected) {
      // For projected data, fit to ~1000 pixel viewport
      zoom = Math.log2(1000 / maxSpan);
    } else {
      // For geographic data (degrees)
      zoom = Math.log2(360 / maxSpan) - 1;
    }

    console.log('[SARViewer] Calculated view state:', {
      isProjected,
      bounds,
      center: [centerX, centerY],
      zoom,
      maxSpan,
    });

    return {
      target: [centerX, centerY],
      zoom,
      minZoom: -15,
      maxZoom: 25,
    };
  }, [bounds]);

  const [viewState, setViewState] = useState(initialViewState || defaultViewState);
  const [loadingStatus, setLoadingStatus] = useState({
    tilesLoading: 0,
    tilesLoaded: 0,
    totalTiles: 0,
    currentOverview: undefined,
    totalOverviews: 0,
  });

  // Update view state when initialViewState or defaultViewState changes
  useEffect(() => {
    if (initialViewState) {
      setViewState(initialViewState);
    } else if (defaultViewState) {
      setViewState(defaultViewState);
    }
  }, [initialViewState, defaultViewState]);

  // Handle loading status updates from layer
  const handleLoadingChange = useCallback((status) => {
    setLoadingStatus(status);
  }, []);

  const handleViewStateChange = useCallback(
    ({ viewState: newViewState }) => {
      setViewState(newViewState);
      if (onViewStateChange) {
        onViewStateChange({ viewState: newViewState });
      }
    },
    [onViewStateChange]
  );

  // Create the SAR layer (either tile-based or bitmap-based)
  const layers = useMemo(() => {
    // Use SARTiledCOGLayer if cogUrl is provided (best for projected COGs)
    if (cogUrl) {
      console.log('[SARViewer] Using SARTiledCOGLayer with COG URL');
      return [
        new SARTiledCOGLayer({
          id: 'sar-tiled-cog-layer',
          url: cogUrl,
          bounds,
          contrastLimits,
          useDecibels,
          colormap,
          opacity,
          onLoadingChange: handleLoadingChange,
        }),
      ];
    }

    // Use BitmapLayer if full image data is provided
    if (imageData && imageData.data) {
      console.log('[SARViewer] Using BitmapLayer with full image data');
      return [
        new SARBitmapLayer({
          id: 'sar-bitmap-layer',
          data: imageData.data,
          width: imageData.width,
          height: imageData.height,
          bounds,
          contrastLimits,
          useDecibels,
          colormap,
          opacity,
        }),
      ];
    }

    // Otherwise use TileLayer
    if (getTile) {
      console.log('[SARViewer] Using TileLayer with getTile function');
      return [
        new SARTileLayer({
          id: 'sar-tile-layer',
          getTile,
          bounds,
          contrastLimits,
          useDecibels,
          colormap,
          opacity,
        }),
      ];
    }

    return [];
  }, [cogUrl, getTile, imageData, bounds, contrastLimits, useDecibels, colormap, opacity, handleLoadingChange]);

  const views = useMemo(
    () =>
      new OrthographicView({
        id: 'ortho-view',
        flipY: false,
      }),
    []
  );

  const containerStyle = useMemo(
    () => ({
      position: 'relative',
      width,
      height,
      backgroundColor: '#1a1a1a',
      ...style,
    }),
    [width, height, style]
  );


  return (
    <div style={containerStyle}>
      <DeckGL
        views={views}
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        layers={layers}
        controller={true}
      />
      <LoadingIndicator
        tilesLoading={loadingStatus.tilesLoading}
        tilesLoaded={loadingStatus.tilesLoaded}
        totalTiles={loadingStatus.totalTiles}
        currentOverview={loadingStatus.currentOverview}
        totalOverviews={loadingStatus.totalOverviews}
      />
      <ScaleBar viewState={viewState} bounds={bounds} />
      <ColorbarOverlay
        colormap={colormap}
        contrastLimits={contrastLimits}
        useDecibels={useDecibels}
      />
    </div>
  );
}

/**
 * ColorbarOverlay - Displays a colorbar legend
 */
function ColorbarOverlay({ colormap, contrastLimits, useDecibels }) {
  const [min, max] = contrastLimits;
  const unit = useDecibels ? 'dB' : '';

  const colorbarStyle = {
    position: 'absolute',
    right: '20px',
    top: '20px',
    background: 'rgba(0, 0, 0, 0.7)',
    padding: '10px',
    borderRadius: '4px',
    color: 'white',
    fontSize: '12px',
    fontFamily: 'monospace',
  };

  const gradientStyle = {
    width: '20px',
    height: '150px',
    background: getGradientCSS(colormap),
    marginBottom: '5px',
  };

  return (
    <div style={colorbarStyle}>
      <div style={{ marginBottom: '5px' }}>
        {max.toFixed(1)}
        {unit}
      </div>
      <div style={gradientStyle} />
      <div>
        {min.toFixed(1)}
        {unit}
      </div>
    </div>
  );
}

/**
 * Generate CSS gradient for colorbar
 */
function getGradientCSS(colormapName) {
  const stops = [];
  const numStops = 10;
  const colormapFunc = getColormap(colormapName);

  for (let i = 0; i < numStops; i++) {
    const t = i / (numStops - 1);
    const color = colormapFunc(1 - t);
    stops.push(`rgb(${color.join(',')}) ${t * 100}%`);
  }

  return `linear-gradient(to bottom, ${stops.join(', ')})`;
}

export default SARViewer;
