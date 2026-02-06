import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Map } from 'maplibre-gl';
import DeckGL from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import { SARTileLayer } from '../layers/SARTileLayer.js';
import { getColormap } from '../utils/colormap.js';

// Import MapLibre CSS - users need to include this in their build
// import 'maplibre-gl/dist/maplibre-gl.css';

/**
 * MapViewer - SAR overlay on MapLibre basemap
 * Provides geographic context for SAR imagery
 */
export function MapViewer({
  getTile,
  bounds,
  contrastLimits = [-25, 0],
  useDecibels = true,
  colormap = 'grayscale',
  opacity = 0.8,
  width = '100%',
  height = '100%',
  mapStyle = 'https://demotiles.maplibre.org/style.json',
  showControls = true,
  onViewStateChange,
  style = {},
}) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const [mapLoaded, setMapLoaded] = useState(false);

  // Calculate initial view state from bounds
  const defaultViewState = useMemo(() => {
    if (!bounds) {
      return {
        longitude: 0,
        latitude: 0,
        zoom: 2,
        pitch: 0,
        bearing: 0,
      };
    }

    const [minX, minY, maxX, maxY] = bounds;
    const centerLon = (minX + maxX) / 2;
    const centerLat = (minY + maxY) / 2;
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const zoom = Math.log2(360 / Math.max(spanX, spanY)) - 1;

    return {
      longitude: centerLon,
      latitude: centerLat,
      zoom: Math.max(0, Math.min(zoom, 18)),
      pitch: 0,
      bearing: 0,
    };
  }, [bounds]);

  const [viewState, setViewState] = useState(defaultViewState);

  // Initialize MapLibre map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new Map({
      container: mapContainerRef.current,
      style: mapStyle,
      center: [viewState.longitude, viewState.latitude],
      zoom: viewState.zoom,
      pitch: viewState.pitch,
      bearing: viewState.bearing,
      attributionControl: true,
    });

    map.on('load', () => {
      mapRef.current = map;
      setMapLoaded(true);
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [mapStyle]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync map view with deck.gl view
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;

    mapRef.current.jumpTo({
      center: [viewState.longitude, viewState.latitude],
      zoom: viewState.zoom,
      pitch: viewState.pitch,
      bearing: viewState.bearing,
    });
  }, [viewState, mapLoaded]);

  const handleViewStateChange = useCallback(
    ({ viewState: newViewState }) => {
      setViewState(newViewState);
      if (onViewStateChange) {
        onViewStateChange({ viewState: newViewState });
      }
    },
    [onViewStateChange]
  );

  // Create SAR tile layer
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

  const containerStyle = useMemo(
    () => ({
      position: 'relative',
      width,
      height,
      ...style,
    }),
    [width, height, style]
  );

  const mapContainerStyle = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
  };

  return (
    <div style={containerStyle}>
      {/* MapLibre basemap */}
      <div ref={mapContainerRef} style={mapContainerStyle} />

      {/* Deck.gl overlay */}
      <DeckGL
        views={new MapView({ repeat: true })}
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        layers={layers}
        controller={true}
        style={{ position: 'absolute', top: 0, left: 0 }}
      />

      {/* Controls overlay */}
      {showControls && (
        <ControlsOverlay
          contrastLimits={contrastLimits}
          useDecibels={useDecibels}
          colormap={colormap}
        />
      )}
    </div>
  );
}

/**
 * ControlsOverlay - Map controls and legend
 */
function ControlsOverlay({ contrastLimits, useDecibels, colormap }) {
  const [min, max] = contrastLimits;
  const unit = useDecibels ? 'dB' : '';

  const overlayStyle = {
    position: 'absolute',
    right: '10px',
    top: '10px',
    background: 'var(--sardine-bg-raised, #0f1f38)',
    border: '1px solid var(--sardine-border, #1e3a5f)',
    padding: '10px',
    borderRadius: 'var(--radius-md, 8px)',
    boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
    fontSize: '0.75rem',
    fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
    color: 'var(--text-primary, #e8edf5)',
    minWidth: '80px',
  };

  const gradientStyle = {
    width: '20px',
    height: '100px',
    background: getGradientCSS(colormap),
    marginBottom: '5px',
    display: 'inline-block',
    verticalAlign: 'top',
  };

  const labelStyle = {
    display: 'inline-block',
    verticalAlign: 'top',
    marginLeft: '10px',
  };

  return (
    <div style={overlayStyle}>
      <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>SAR Intensity</div>
      <div style={{ display: 'flex' }}>
        <div style={gradientStyle} />
        <div style={labelStyle}>
          <div style={{ marginBottom: '75px' }}>
            {max.toFixed(1)}
            {unit}
          </div>
          <div>
            {min.toFixed(1)}
            {unit}
          </div>
        </div>
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

export default MapViewer;
