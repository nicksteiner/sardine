import React, { useState, useCallback, useMemo, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Map, ScaleControl } from 'maplibre-gl';
import DeckGL from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import { SARTileLayer } from '../layers/SARTileLayer.js';
import { getColormap } from '../utils/colormap.js';
import { createReprojectedTileFetcher } from '../utils/reproject-tiles.js';
import { makeMapFrame } from '../utils/view-frame.js';
import { ROIOverlay } from '../components/ROIOverlay.jsx';
import { TransectLineOverlay } from '../components/TransectLineOverlay.jsx';
import { AnnotationOverlay } from '../components/AnnotationOverlay.jsx';

// MapLibre CSS is imported by the app (app/main.jsx); library users include
// 'maplibre-gl/dist/maplibre-gl.css' in their own build.

/** Basemap credit for exported figures (OpenFreeMap tiles, OSM data). */
export const BASEMAP_CREDIT = '© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap';

/**
 * MapViewer - SAR overlay on MapLibre basemap
 * Provides geographic context for SAR imagery.
 *
 * Carries the same markup overlays as SARViewer (ROI box, transect / measure
 * line, arrow + text annotations) through a map-frame coordinate contract
 * (view-frame.js), so marks made on the basemap persist in image pixels and
 * round-trip to the native view, GeoJSON markup, and figure export.
 *
 * Ref API (mirrors SARViewer): getCanvas() — basemap + data composited into
 * one canvas for figure export; getViewState(); getFrame() — the map frame
 * (with cssWidth/cssHeight) for exporters; getContainer(); redraw().
 */
export const MapViewer = forwardRef(function MapViewer({
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
  // ── Markup (same contract as SARViewer) ──
  sceneBounds = null,       // the scene's own `bounds` the marks are stored against
  imageWidth = 0,
  imageHeight = 0,
  measure = null,           // ground-measure helper (measure.js)
  roi = null,
  onROIChange = null,
  roiArmed = false,
  transectEnabled = false,
  transectLine = null,
  onTransectLineChange = null,
  annotations = [],
  annotationMode = 'off',
  annotationColor = 'red',
  annotationSize = 'medium',
  onAnnotationsChange = null,
  selectedAnnotationId = null,
  onSelectAnnotation = null,
}, ref) {
  const containerRef = useRef(null);
  const mapContainerRef = useRef(null);
  const deckWrapRef = useRef(null);
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

  // Map frame: scene world ↔ screen through the image CRS (view-frame.js).
  const frame = useMemo(() => {
    if (!reproject || !sceneBounds || !imageWidth || !imageHeight) return null;
    return makeMapFrame({
      bounds: sceneBounds,
      imageWidth,
      imageHeight,
      worldBounds: reproject.worldBounds,
      crs: reproject.crs,
    });
  }, [reproject, sceneBounds, imageWidth, imageHeight]);

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
      // Figure export reads the basemap pixels back (getCanvas composite).
      preserveDrawingBuffer: true,
    });
    map.addControl(new ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-left');

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

  const [redrawTick, setRedrawTick] = useState(0);
  useImperativeHandle(ref, () => ({
    /** Basemap + data composited into one canvas (device pixels). */
    getCanvas: () => {
      const deckCanvas = deckWrapRef.current?.querySelector('canvas');
      if (!deckCanvas) return null;
      const out = document.createElement('canvas');
      out.width = deckCanvas.width;
      out.height = deckCanvas.height;
      const ctx = out.getContext('2d');
      const mapCanvas = mapRef.current?.getCanvas?.();
      if (mapCanvas) {
        try { ctx.drawImage(mapCanvas, 0, 0, out.width, out.height); } catch (_) { /* tainted/unavailable → data only */ }
      }
      ctx.drawImage(deckCanvas, 0, 0);
      return out;
    },
    getContainer: () => containerRef.current,
    getViewState: () => viewState,
    getFrame: () => {
      if (!frame) return null;
      const el = containerRef.current;
      return { ...frame, cssWidth: el?.clientWidth || 0, cssHeight: el?.clientHeight || 0 };
    },
    redraw: () => setRedrawTick((t) => t + 1),
  }), [viewState, frame]);

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
  }, [getTile, fetcher, bounds, contrastLimits, useDecibels, colormap, reverseColormap, opacity, layerProps, tileVersion, extraLayers, overlayFetchers, redrawTick]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const markup = !!(frame && sceneBounds && imageWidth && imageHeight);

  return (
    <div ref={containerRef} style={containerStyle}>
      {/* MapLibre basemap */}
      <div ref={mapContainerRef} style={mapContainerStyle} />

      {/* Deck.gl overlay */}
      <div ref={deckWrapRef} style={{ position: 'absolute', inset: 0 }}>
        <DeckGL
          views={new MapView({ repeat: true })}
          viewState={viewState}
          onViewStateChange={handleViewStateChange}
          layers={layers}
          controller={true}
          deviceProps={{ webgl: { preserveDrawingBuffer: true } }}
          onClick={onClick ? (info) => { if (info?.coordinate) onClick(info.coordinate); } : undefined}
          style={{ position: 'absolute', top: 0, left: 0 }}
        />
      </div>

      {/* Markup overlays — same components as the native view, map frame */}
      {markup && (
        <>
          <ROIOverlay
            viewState={viewState}
            bounds={sceneBounds}
            imageWidth={imageWidth}
            imageHeight={imageHeight}
            roi={roi}
            onROIChange={onROIChange}
            frame={frame}
            measure={measure}
            armed={roiArmed}
          />
          <TransectLineOverlay
            enabled={transectEnabled}
            viewState={viewState}
            bounds={sceneBounds}
            imageWidth={imageWidth}
            imageHeight={imageHeight}
            line={transectLine}
            onLineChange={onTransectLineChange}
            frame={frame}
            measure={measure}
          />
          <AnnotationOverlay
            viewState={viewState}
            bounds={sceneBounds}
            mode={annotationMode}
            color={annotationColor}
            size={annotationSize}
            annotations={annotations}
            onAnnotationsChange={onAnnotationsChange}
            selectedId={selectedAnnotationId}
            onSelectAnnotation={onSelectAnnotation}
            frame={frame}
          />
        </>
      )}

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
});

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
