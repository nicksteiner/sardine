import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Map } from 'maplibre-gl';
import DeckGL from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import { SARTileLayer } from '../layers/SARTileLayer.js';
import { getColormap } from '../utils/colormap.js';
import { createReprojectedTileFetcher } from '../utils/reproject-tiles.js';

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
  reverseColormap = false,
  opacity = 0.8,
  width = '100%',
  height = '100%',
  // OpenFreeMap "positron": quiet light OSM style, keyless (basemap default).
  mapStyle = 'https://tiles.openfreemap.org/styles/positron',
  showControls = true,
  onViewStateChange,
  style = {},
  // Projected scene drawn through warped tile meshes (W033):
  // { width, height, worldBounds, crs }. `bounds` is then derived (lon/lat).
  reproject = null,
  // Extra SARTileLayer props (gamma, stretchMode, rgbSaturation, …).
  layerProps = {},
  // Bumped when progressive tile refinement (NISAR overview ladder) has new
  // data: changes the layer id so deck.gl refetches tiles.
  tileVersion = 0,
  // deck.gl layers in lon/lat drawn above the raster (Overture overlays…).
  extraLayers = [],
  // onClick([lon, lat]) for map-frame interactions (exposure queries…).
  onClick = null,
  // Context rasters drawn between the basemap and the scene, each
  // { id, scene (from openCOGOverlay), contrastLimits, colormap, opacity,
  //   stretchMode, useDecibels=false }.
  rasterOverlays = [],
}) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const [mapLoaded, setMapLoaded] = useState(false);

  const fetcher = useMemo(() => {
    if (!reproject || !getTile) return null;
    return createReprojectedTileFetcher({ getTile, ...reproject });
  }, [getTile, reproject]);
  if (fetcher) bounds = fetcher.extent;

  // One fetcher per overlay scene, kept while the scene object is the same.
  const overlayFetchers = useMemo(() => rasterOverlays.map((o) => ({
    ...o,
    fetcher: createReprojectedTileFetcher({
      getTile: o.scene.getTile,
      width: o.scene.width,
      height: o.scene.height,
      worldBounds: o.scene.worldBounds,
      crs: o.scene.crs,
      bboxSpace: o.scene.bboxSpace || 'pixel',
    }),
  })), [rasterOverlays]);

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
      ...overlayFetchers.map((o) => new SARTileLayer({
        id: `raster-overlay-${o.id}`,
        getTile: o.scene.getTile,
        getTileData: o.fetcher.getTileData,
        bounds: o.fetcher.extent,
        minZoom: 0,
        contrastLimits: o.contrastLimits || [0, 1],
        useDecibels: o.useDecibels ?? false,
        colormap: o.colormap || 'viridis',
        stretchMode: o.stretchMode || 'linear',
        opacity: o.opacity ?? 0.6,
      })),
      new SARTileLayer({
        id: `sar-layer-v${tileVersion}`,
        getTile,
        ...(fetcher ? { getTileData: fetcher.getTileData, minZoom: 0 } : {}),
        bounds,
        contrastLimits,
        useDecibels,
        colormap,
        reverseColormap,
        opacity,
        ...layerProps,
      }),
      ...extraLayers,
    ];
  }, [getTile, fetcher, bounds, contrastLimits, useDecibels, colormap, reverseColormap, opacity, layerProps, tileVersion, extraLayers, overlayFetchers]);

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
        onClick={onClick ? (info) => { if (info?.coordinate) onClick(info.coordinate); } : undefined}
        style={{ position: 'absolute', top: 0, left: 0 }}
      />

      {/* Controls overlay */}
      {showControls && (
        <ControlsOverlay
          contrastLimits={contrastLimits}
          useDecibels={useDecibels}
          colormap={colormap}
          reverseColormap={reverseColormap}
        />
      )}
    </div>
  );
}

/**
 * ControlsOverlay - Map controls and legend
 */
function ControlsOverlay({ contrastLimits, useDecibels, colormap, reverseColormap = false }) {
  const [min, max] = contrastLimits;
  const unit = useDecibels ? 'dB' : '';

  const overlayStyle = {
    position: 'absolute',
    right: '10px',
    top: '10px',
    background: 'var(--sardine-bg-raised, #0f1f38)',
    border: '1px solid var(--sardine-border, #1e3a5f)',
    padding: '10px',
    borderRadius: 'var(--radius-md)',
    boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
    fontSize: 'var(--text-sm)',
    fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
    color: 'var(--text-primary, #e8edf5)',
    minWidth: '80px',
  };

  const gradientStyle = {
    width: '20px',
    height: '100px',
    background: getGradientCSS(colormap, reverseColormap),
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
function getGradientCSS(colormapName, reversed = false) {
  const stops = [];
  const numStops = 10;
  const colormapFunc = getColormap(colormapName);
  const invert = reversed && colormapName !== 'label';

  for (let i = 0; i < numStops; i++) {
    const t = i / (numStops - 1);
    const sample = invert ? t : 1 - t;
    const color = colormapFunc(sample);
    stops.push(`rgb(${color.join(',')}) ${t * 100}%`);
  }

  return `linear-gradient(to bottom, ${stops.join(', ')})`;
}

export default MapViewer;
