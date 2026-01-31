import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Map } from 'maplibre-gl';
import DeckGL from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import { SARTileLayer } from '../layers/SARTileLayer.js';

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
    background: 'rgba(255, 255, 255, 0.9)',
    padding: '10px',
    borderRadius: '4px',
    boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
    fontSize: '12px',
    fontFamily: 'sans-serif',
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

export default MapViewer;
