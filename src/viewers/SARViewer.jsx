import React, { useState, useCallback, useMemo, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { SARTileLayer } from '../layers/SARTileLayer.js';
import { SARBitmapLayer } from '../layers/SARBitmapLayer.js';
import { SARTiledCOGLayer } from '../layers/SARTiledCOGLayer.js';
import { getColormap } from '../utils/colormap.js';
import { SAR_COMPOSITES } from '../utils/sar-composites.js';
import { LoadingIndicator } from '../components/LoadingIndicator.jsx';
import { ScaleBar } from '../components/ScaleBar.jsx';

/**
 * SARViewer - Basic SAR image viewer component
 * Built on deck.gl with React
 *
 * Accepts a ref that exposes `getCanvas()` for figure export.
 */
export const SARViewer = forwardRef(function SARViewer({
  getTile,
  imageData, // Full image data for BitmapLayer approach
  cogUrl, // COG URL for SARTiledCOGLayer approach
  bounds,
  contrastLimits = [-25, 0],
  useDecibels = true,
  colormap = 'grayscale',
  compositeId = null, // SAR RGB composite ID (null = single band)
  opacity = 1,
  quality = 'fast',
  width = '100%',
  height = '100%',
  onViewStateChange,
  initialViewState,
  style = {},
}, ref) {
  const containerRef = useRef(null);

  // Expose getCanvas() so the parent can capture the WebGL canvas for figure export
  useImperativeHandle(ref, () => ({
    getCanvas: () => {
      if (!containerRef.current) return null;
      return containerRef.current.querySelector('canvas');
    },
    getViewState: () => viewState,
  }));

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
          quality,
        }),
      ];
    }

    return [];
  }, [cogUrl, getTile, imageData, bounds, contrastLimits, useDecibels, colormap, opacity, quality, handleLoadingChange]);

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
      backgroundColor: 'var(--sardine-bg, #0a1628)',
      ...style,
    }),
    [width, height, style]
  );


  return (
    <div ref={containerRef} style={containerStyle}>
      <DeckGL
        views={views}
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        layers={layers}
        controller={true}
        glOptions={{ preserveDrawingBuffer: true }}
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
        compositeId={compositeId}
      />
    </div>
  );
});

/**
 * ColorbarOverlay - Displays a colorbar legend
 * Shows RGB channel legend when compositeId is set, otherwise shows colormap gradient.
 */
function ColorbarOverlay({ colormap, contrastLimits, useDecibels, compositeId }) {
  const unit = useDecibels ? 'dB' : '';

  const colorbarStyle = {
    position: 'absolute',
    right: 'var(--space-lg, 24px)',
    top: 'var(--space-lg, 24px)',
    background: 'var(--sardine-bg-raised)',
    border: '1px solid var(--sardine-border)',
    padding: 'var(--space-md, 16px)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-primary)',
    fontSize: '0.75rem',
    fontFamily: 'var(--font-mono)',
  };

  // RGB composite mode — show channel legend with per-channel info
  if (compositeId) {
    const preset = SAR_COMPOSITES[compositeId];
    const channelDefs = [
      { key: 'R', color: '#ff4444' },
      { key: 'G', color: '#44ff44' },
      { key: 'B', color: '#4444ff' },
    ];

    // Get per-channel labels from the preset
    const getLabel = (ch) => {
      if (!preset) return ch;
      const chDef = preset.channels[ch];
      if (!chDef) return ch;
      return chDef.label || chDef.dataset || ch;
    };

    // Format per-channel limits
    const fmtLim = (ch) => {
      if (!contrastLimits || Array.isArray(contrastLimits)) {
        const [min, max] = Array.isArray(contrastLimits) ? contrastLimits : [0, 1];
        return `${min.toFixed(1)}–${max.toFixed(1)} ${unit}`;
      }
      const lim = contrastLimits[ch];
      if (!lim) return '';
      if (useDecibels) return `${lim[0].toFixed(1)}–${lim[1].toFixed(1)} dB`;
      return `${lim[0].toExponential(1)}–${lim[1].toExponential(1)}`;
    };

    return (
      <div style={colorbarStyle}>
        <div style={{ marginBottom: '6px', fontWeight: 'bold' }}>
          {preset?.name || 'RGB'}
        </div>
        {channelDefs.map(({ key, color }) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', marginBottom: '3px' }}>
            <div style={{ width: 12, height: 12, backgroundColor: color, marginRight: 6, borderRadius: 2 }} />
            <span style={{ marginRight: 6 }}>{getLabel(key)}</span>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{fmtLim(key)}</span>
          </div>
        ))}
      </div>
    );
  }

  // Single-band mode — show colormap gradient
  const [min, max] = Array.isArray(contrastLimits) ? contrastLimits : [0, 1];
  const gradientStyle = {
    width: '20px',
    height: '150px',
    background: getGradientCSS(colormap),
    borderRadius: 'var(--radius-sm)',
    marginBottom: 'var(--space-xs)',
  };

  return (
    <div style={colorbarStyle}>
      <div style={{ marginBottom: 'var(--space-xs)', color: 'var(--text-secondary)' }}>
        {max.toFixed(1)}
        {unit}
      </div>
      <div style={gradientStyle} />
      <div style={{ color: 'var(--text-secondary)' }}>
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
