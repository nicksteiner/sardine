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
import { CoordinateGrid } from '../components/CoordinateGrid.jsx';
import { ROIOverlay } from '../components/ROIOverlay.jsx';
import ClassificationOverlay from '../components/ClassificationOverlay.jsx';
import { PixelExplorer } from '../components/PixelExplorer.jsx';
import { ROIProfilePlot } from '../components/ROIProfilePlot.jsx';

/**
 * SARViewer - Basic SAR image viewer component
 * Built on deck.gl with React
 *
 * Accepts a ref that exposes `getCanvas()` for figure export.
 */
export const SARViewer = forwardRef(function SARViewer({
  getTile,
  tileVersion = 0, // Bumped when progressive tile refinement is ready
  imageData, // Full image data for BitmapLayer approach
  cogUrl, // COG URL for SARTiledCOGLayer approach
  bounds,
  contrastLimits = [-25, 0],
  useDecibels = true,
  colormap = 'grayscale',
  gamma = 1.0,
  stretchMode = 'linear',
  compositeId = null, // SAR RGB composite ID (null = single band)
  multiLook = false,  // Multi-look mode (area-averaged resampling)
  maskInvalid = false,        // Hide invalid (0) and fill (255) pixels
  maskLayoverShadow = false,  // Hide layover/shadow pixels (mask < 100)
  useCoherenceMask = false,   // GUNW: threshold low-coherence pixels
  coherenceThreshold = 0.3,   // GUNW: coherence threshold (0–1)
  coherenceThresholdMax = 1.0, // Upper threshold for range mode
  coherenceMaskMode = 0,       // 0=below min, 1=outside [min,max]
  incidenceAngleData = null,   // {data, width, height} for angle masking / vertical displacement
  verticalDisplacement = false, // GUNW: divide LOS by cos(θ) for vertical component
  correctionLayers = null,       // GUNW: {ionosphere, troposphereWet, ...} each {data, w, h}
  enabledCorrections = null,     // GUNW: Set of enabled correction keys
  speckleFilterType = 'none', // Speckle filter type ('none' | 'boxcar' | 'lee' | etc.)
  speckleKernelSize = 7,      // Speckle filter kernel size (3–11, odd)
  showGrid = true,    // Show coordinate grid + corner coordinates
  opacity = 1,
  toneMapping, // Tone mapping configuration
  width = '100%',
  height = '100%',
  onViewStateChange,
  initialViewState,
  style = {},
  extraLayers = [],   // Additional deck.gl layers (e.g., Overture overlay)
  roi = null,         // ROI rectangle { left, top, width, height } in image pixels
  onROIChange,        // Callback when ROI changes via Shift+drag
  imageWidth,         // Source image width in pixels (for ROI overlay)
  imageHeight,        // Source image height in pixels (for ROI overlay)
  getPixelValue,      // async (row, col, windowSize?) => value (for pixel explorer)
  pixelExplorer = false, // Enable pixel value explorer overlay
  pixelWindowSize = 1,   // Averaging window for pixel explorer (odd int)
  xCoords,            // Float64Array easting coords (length = imageWidth)
  yCoords,            // Float64Array northing coords (length = imageHeight)
  roiProfile = null,  // Precomputed profile data from main.jsx for ROIProfilePlot
  profileShow = { v: true, h: true, i: true }, // Which profile views are visible
  classificationMap = null, // Uint8Array per ROI pixel for feature space classifier
  classRegions = [],        // [{name, color, ...}] class definitions
  classifierRoiDims = null, // {w, h} grid dimensions of classification map
}, ref) {
  const containerRef = useRef(null);
  const getTileRef = useRef(getTile);
  getTileRef.current = getTile;

  // Stable getTileData wrapper — identity only changes when data props change,
  // so SARTileLayer won't re-fetch tiles when visual props (colormap, contrast, etc.) change.
  const stableGetTileData = useCallback(
    async (tile) => {
      const { bbox } = tile;
      return getTileRef.current({
        x: tile.index.x,
        y: tile.index.y,
        z: tile.index.z,
        bbox,
        multiLook,
      });
    },
    [multiLook]
  );

  const [redrawTick, setRedrawTick] = useState(0);

  // Expose getCanvas() so the parent can capture the WebGL canvas for figure export
  useImperativeHandle(ref, () => ({
    getCanvas: () => {
      if (!containerRef.current) return null;
      return containerRef.current.querySelector('canvas');
    },
    /** Get the full container element (for capturing all overlays). */
    getContainer: () => containerRef.current,
    getViewState: () => viewState,
    /** Force deck.gl to re-render (e.g. after canvas capture). */
    redraw: () => setRedrawTick(t => t + 1),
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

  // Debounce the parent callback so expensive work (histogram, stats) doesn't
  // fire 60x/sec during pan/zoom. Local viewState updates remain immediate.
  const debouncedParentCb = useRef(null);
  const debounceTimer = useRef(null);
  debouncedParentCb.current = onViewStateChange;

  const handleViewStateChange = useCallback(
    ({ viewState: newViewState }) => {
      setViewState(newViewState);
      if (debouncedParentCb.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => {
          debouncedParentCb.current({ viewState: newViewState });
        }, 150);
      }
    },
    []
  );

  // Store visual props in a ref so we can read current values in the layer
  // factory without adding them as useMemo dependencies. A separate
  // RAF-throttled tick drives re-renders only when visual props change,
  // preventing redundant layer recreations during rapid slider drags.
  const visualRef = useRef({
    contrastLimits, useDecibels, colormap, gamma, stretchMode,
    opacity, maskInvalid, maskLayoverShadow, useCoherenceMask, coherenceThreshold, coherenceThresholdMax, coherenceMaskMode,
    incidenceAngleData, verticalDisplacement, correctionLayers, enabledCorrections, speckleFilterType, speckleKernelSize, toneMapping,
  });
  const [visualTick, setVisualTick] = useState(0);
  const rafRef = useRef(null);

  useEffect(() => {
    const prev = visualRef.current;
    const changed = (
      contrastLimits !== prev.contrastLimits ||
      useDecibels !== prev.useDecibels ||
      colormap !== prev.colormap ||
      gamma !== prev.gamma ||
      stretchMode !== prev.stretchMode ||
      opacity !== prev.opacity ||
      maskInvalid !== prev.maskInvalid ||
      maskLayoverShadow !== prev.maskLayoverShadow ||
      useCoherenceMask !== prev.useCoherenceMask ||
      coherenceThreshold !== prev.coherenceThreshold ||
      coherenceThresholdMax !== prev.coherenceThresholdMax ||
      coherenceMaskMode !== prev.coherenceMaskMode ||
      incidenceAngleData !== prev.incidenceAngleData ||
      verticalDisplacement !== prev.verticalDisplacement ||
      correctionLayers !== prev.correctionLayers ||
      enabledCorrections !== prev.enabledCorrections ||
      speckleFilterType !== prev.speckleFilterType ||
      speckleKernelSize !== prev.speckleKernelSize ||
      toneMapping !== prev.toneMapping
    );
    visualRef.current = {
      contrastLimits, useDecibels, colormap, gamma, stretchMode,
      opacity, maskInvalid, maskLayoverShadow, useCoherenceMask, coherenceThreshold, coherenceThresholdMax, coherenceMaskMode,
      incidenceAngleData, verticalDisplacement, correctionLayers, enabledCorrections, speckleFilterType, speckleKernelSize, toneMapping,
    };
    if (changed && !rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setVisualTick(t => t + 1);
      });
    }
  }, [contrastLimits, useDecibels, colormap, gamma, stretchMode, opacity, maskInvalid, maskLayoverShadow, useCoherenceMask, coherenceThreshold, coherenceThresholdMax, coherenceMaskMode, incidenceAngleData, verticalDisplacement, correctionLayers, enabledCorrections, speckleFilterType, speckleKernelSize, toneMapping]);

  // Create the SAR layer (either tile-based or bitmap-based)
  const layers = useMemo(() => {
    const v = visualRef.current;

    // Use SARTiledCOGLayer if cogUrl is provided (best for projected COGs)
    if (cogUrl) {
      return [
        new SARTiledCOGLayer({
          id: 'sar-tiled-cog-layer',
          url: cogUrl,
          bounds,
          contrastLimits: v.contrastLimits,
          useDecibels: v.useDecibels,
          colormap: v.colormap,
          gamma: v.gamma,
          stretchMode: v.stretchMode,
          opacity: v.opacity,
          maskInvalid: v.maskInvalid,
          maskLayoverShadow: v.maskLayoverShadow,
          toneMapping: v.toneMapping,
          onLoadingChange: handleLoadingChange,
        }),
      ];
    }

    // Use BitmapLayer if full image data is provided
    if (imageData && imageData.data) {
      return [
        new SARBitmapLayer({
          id: 'sar-bitmap-layer',
          data: imageData.data,
          dataMask: imageData.mask || null,
          width: imageData.width,
          height: imageData.height,
          bounds,
          contrastLimits: v.contrastLimits,
          useDecibels: v.useDecibels,
          colormap: v.colormap,
          gamma: v.gamma,
          stretchMode: v.stretchMode,
          opacity: v.opacity,
          maskInvalid: v.maskInvalid,
          maskLayoverShadow: v.maskLayoverShadow,
        }),
      ];
    }

    // Otherwise use TileLayer
    if (getTile) {
      return [
        new SARTileLayer({
          id: `sar-tile-layer-v${tileVersion}`,
          getTileData: stableGetTileData,
          bounds,
          contrastLimits: v.contrastLimits,
          useDecibels: v.useDecibels,
          colormap: v.colormap,
          gamma: v.gamma,
          stretchMode: v.stretchMode,
          opacity: v.opacity,
          multiLook,
          maskInvalid: v.maskInvalid,
          maskLayoverShadow: v.maskLayoverShadow,
          useCoherenceMask: v.useCoherenceMask,
          coherenceThreshold: v.coherenceThreshold,
          coherenceThresholdMax: v.coherenceThresholdMax,
          coherenceMaskMode: v.coherenceMaskMode,
          incidenceAngleData: v.incidenceAngleData,
          verticalDisplacement: v.verticalDisplacement,
          correctionLayers: v.correctionLayers,
          enabledCorrections: v.enabledCorrections,
          speckleFilterType: v.speckleFilterType,
          speckleKernelSize: v.speckleKernelSize,
        }),
      ];
    }

    return [];
  // eslint-disable-next-line react-hooks/exhaustive-deps -- visualTick drives visual prop updates via RAF throttle; redrawTick forces recreation after canvas capture
  }, [cogUrl, stableGetTileData, tileVersion, imageData, bounds, multiLook, handleLoadingChange, redrawTick, visualTick]);

  const allLayers = useMemo(() => {
    const baseLayers = layers;
    // Append any extra overlay layers (Overture, annotations, etc.)
    return [...baseLayers, ...extraLayers];
  }, [layers, extraLayers]);

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
        layers={allLayers}
        controller={true}
        glOptions={{ preserveDrawingBuffer: true }}
        parameters={{ clearColor: [0.039, 0.086, 0.157, 1] }}
      />
      <ROIOverlay
        viewState={viewState}
        bounds={bounds}
        imageWidth={imageWidth}
        imageHeight={imageHeight}
        roi={roi}
        onROIChange={onROIChange}
      />
      {classificationMap && roi && classifierRoiDims && (
        <ClassificationOverlay
          viewState={viewState}
          bounds={bounds}
          imageWidth={imageWidth}
          imageHeight={imageHeight}
          roi={roi}
          classificationMap={classificationMap}
          classRegions={classRegions}
          roiDims={classifierRoiDims}
        />
      )}
      <PixelExplorer
        viewState={viewState}
        bounds={bounds}
        imageWidth={imageWidth}
        imageHeight={imageHeight}
        getPixelValue={getPixelValue}
        useDecibels={useDecibels}
        windowSize={pixelWindowSize}
        enabled={pixelExplorer}
        xCoords={xCoords}
        yCoords={yCoords}
      />
      <ROIProfilePlot
        roi={roi}
        profileData={roiProfile}
        viewState={viewState}
        bounds={bounds}
        imageWidth={imageWidth}
        imageHeight={imageHeight}
        useDecibels={useDecibels}
        show={profileShow}
      />
      {showGrid && <CoordinateGrid viewState={viewState} bounds={bounds} />}
      <LoadingIndicator
        tilesLoading={loadingStatus.tilesLoading}
        tilesLoaded={loadingStatus.tilesLoaded}
        totalTiles={loadingStatus.totalTiles}
        currentOverview={loadingStatus.currentOverview}
        totalOverviews={loadingStatus.totalOverviews}
      />
      <ScaleBar viewState={viewState} bounds={bounds} />
      {/* Zoom-to-extent / Home button */}
      {bounds && (bounds[2] - bounds[0]) > 0 && (
        <button
          onClick={() => {
            setViewState(defaultViewState);
            onViewStateChange?.({ viewState: defaultViewState });
          }}
          title="Zoom to data extent"
          style={{
            position: 'absolute',
            top: 40,
            left: 10,
            width: 28,
            height: 28,
            background: 'rgba(10, 22, 40, 0.85)',
            border: '1px solid var(--sardine-border, #1e3a5f)',
            borderRadius: 'var(--radius-sm, 4px)',
            color: 'var(--sardine-cyan, #4ec9d4)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            zIndex: 10,
            fontSize: '14px',
            lineHeight: 1,
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="2" width="12" height="12" rx="1" />
            <circle cx="8" cy="8" r="2" />
          </svg>
        </button>
      )}
      <ColorbarOverlay
        colormap={colormap}
        contrastLimits={contrastLimits}
        useDecibels={useDecibels}
        compositeId={compositeId}
      />
      {/* SARdine branding badge */}
      <div style={{
        position: 'absolute',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '0.7rem',
        fontWeight: 700,
        letterSpacing: '1px',
        pointerEvents: 'none',
        zIndex: 10,
        opacity: 0.6,
      }}>
        <span style={{ color: 'var(--sardine-cyan, #4ec9d4)' }}>SAR</span>
        <span style={{ color: 'var(--text-primary, #e8edf5)' }}>dine</span>
      </div>
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
      { key: 'R', color: 'var(--sardine-magenta, #d45cff)' },
      { key: 'G', color: 'var(--sardine-green, #3ddc84)' },
      { key: 'B', color: 'var(--sardine-cyan, #4ec9d4)' },
    ];

    // Get per-channel labels from the preset
    const getLabel = (ch) => {
      if (!preset) return ch;
      // Handle freeman-durden style (channelLabels) or standard style (channels)
      if (preset.channelLabels) {
        return preset.channelLabels[ch] || ch;
      }
      const chDef = preset.channels?.[ch];
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
