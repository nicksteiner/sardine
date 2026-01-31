import React, { useState, useCallback, useMemo, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { SARTileLayer } from '../layers/SARTileLayer.js';

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

  for (let i = 0; i < numStops; i++) {
    const t = i / (numStops - 1);
    const color = getColorAtValue(colormapName, 1 - t);
    stops.push(`rgb(${color.join(',')}) ${t * 100}%`);
  }

  return `linear-gradient(to bottom, ${stops.join(', ')})`;
}

/**
 * Get color at a specific value for the colormap
 */
function getColorAtValue(colormapName, t) {
  t = Math.max(0, Math.min(1, t));

  switch (colormapName) {
    case 'viridis':
      return viridisColor(t);
    case 'inferno':
      return infernoColor(t);
    case 'plasma':
      return plasmaColor(t);
    case 'phase':
      return phaseColor(t);
    default:
      const v = Math.round(t * 255);
      return [v, v, v];
  }
}

function viridisColor(t) {
  const c0 = [0.2777, 0.0054, 0.334];
  const c1 = [0.105, 0.6389, 0.7916];
  const c2 = [-0.3308, 0.2149, 0.0948];
  const c3 = [-4.6342, -5.7991, -19.3324];
  const c4 = [6.2282, 14.1799, 56.6905];
  const c5 = [4.7763, -13.7451, -65.353];
  const c6 = [-5.4354, 4.6456, 26.3124];

  const rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    rgb[i] =
      c0[i] +
      t * (c1[i] + t * (c2[i] + t * (c3[i] + t * (c4[i] + t * (c5[i] + t * c6[i])))));
    rgb[i] = Math.round(Math.max(0, Math.min(1, rgb[i])) * 255);
  }
  return rgb;
}

function infernoColor(t) {
  const c0 = [0.0002, 0.0016, 0.0139];
  const c1 = [0.1065, 0.0639, 0.2671];
  const c2 = [0.9804, 0.5388, -0.1957];
  const c3 = [-3.4496, -0.2218, -3.1556];
  const c4 = [3.8558, -2.0792, 8.7339];
  const c5 = [-1.4928, 1.8878, -8.0579];
  const c6 = [-0.0003, 0.0009, 2.4578];

  const rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    rgb[i] =
      c0[i] +
      t * (c1[i] + t * (c2[i] + t * (c3[i] + t * (c4[i] + t * (c5[i] + t * c6[i])))));
    rgb[i] = Math.round(Math.max(0, Math.min(1, rgb[i])) * 255);
  }
  return rgb;
}

function plasmaColor(t) {
  const c0 = [0.0505, 0.0298, 0.528];
  const c1 = [2.0206, 0.0, 0.7067];
  const c2 = [-1.0313, 1.2882, 0.3985];
  const c3 = [-6.0884, -0.7839, -4.6899];
  const c4 = [7.1103, -2.6782, 6.5379];
  const c5 = [-2.7666, 3.0649, -3.538];
  const c6 = [0.8027, -0.8948, 0.9565];

  const rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    rgb[i] =
      c0[i] +
      t * (c1[i] + t * (c2[i] + t * (c3[i] + t * (c4[i] + t * (c5[i] + t * c6[i])))));
    rgb[i] = Math.round(Math.max(0, Math.min(1, rgb[i])) * 255);
  }
  return rgb;
}

function phaseColor(t) {
  const angle = t * 2 * Math.PI;
  return [
    Math.round((0.5 + 0.5 * Math.cos(angle)) * 255),
    Math.round((0.5 + 0.5 * Math.cos(angle + (2 * Math.PI) / 3)) * 255),
    Math.round((0.5 + 0.5 * Math.cos(angle + (4 * Math.PI) / 3)) * 255),
  ];
}

export default SARViewer;
