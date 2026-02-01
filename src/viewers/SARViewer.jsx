import React, { useState, useCallback, useMemo, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { SARTileLayer } from '../layers/SARTileLayer.js';
import { getColormap } from '../utils/colormap.js';

/**
 * SARViewer - Basic SAR image viewer component
 * Built on deck.gl with React
 */
export function SARViewer({
  getTile,
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
        minZoom: -2,
        maxZoom: 10,
      };
    }

    const [minX, minY, maxX, maxY] = bounds;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const spanX = maxX - minX;
    const spanY = maxY - minY;

    // Calculate zoom to fit bounds
    const zoom = Math.log2(360 / Math.max(spanX, spanY)) - 1;

    return {
      target: [centerX, centerY],
      zoom: Math.max(-2, Math.min(zoom, 10)),
      minZoom: -2,
      maxZoom: 20,
    };
  }, [bounds]);

  const [viewState, setViewState] = useState(initialViewState || defaultViewState);

  // Update view state when initialViewState changes
  useEffect(() => {
    if (initialViewState) {
      setViewState(initialViewState);
    }
  }, [initialViewState]);

  const handleViewStateChange = useCallback(
    ({ viewState: newViewState }) => {
      setViewState(newViewState);
      if (onViewStateChange) {
        onViewStateChange({ viewState: newViewState });
      }
    },
    [onViewStateChange]
  );

  // Create the SAR tile layer
  const layers = useMemo(() => {
    if (!getTile) return [];

    return [
      new SARTileLayer({
        id: 'sar-layer',
        getTile,
        bounds,
        contrastLimits,
        useDecibels,
        colormap,
        opacity,
      }),
    ];
  }, [getTile, bounds, contrastLimits, useDecibels, colormap, opacity]);

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
