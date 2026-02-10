import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { SARTileLayer } from '../layers/SARTileLayer.js';

/**
 * ComparisonViewer - Side-by-side SAR image viewer with linked pan/zoom
 * Allows comparison of two SAR images with synchronized navigation
 */
export function ComparisonViewer({
  leftImage,
  rightImage,
  width = '100%',
  height = '100%',
  syncViews = true,
  showLabels = true,
  leftLabel = 'Left',
  rightLabel = 'Right',
  style = {},
}) {
  // Merge bounds from both images
  const combinedBounds = useMemo(() => {
    const leftBounds = leftImage?.bounds || [0, 0, 1, 1];
    const rightBounds = rightImage?.bounds || [0, 0, 1, 1];

    return [
      Math.min(leftBounds[0], rightBounds[0]),
      Math.min(leftBounds[1], rightBounds[1]),
      Math.max(leftBounds[2], rightBounds[2]),
      Math.max(leftBounds[3], rightBounds[3]),
    ];
  }, [leftImage?.bounds, rightImage?.bounds]);

  // Calculate initial view state from combined bounds
  const defaultViewState = useMemo(() => {
    const [minX, minY, maxX, maxY] = combinedBounds;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const zoom = Math.log2(360 / Math.max(spanX, spanY)) - 1;

    return {
      target: [centerX, centerY],
      zoom: Math.max(-2, Math.min(zoom, 10)),
      minZoom: -2,
      maxZoom: 20,
    };
  }, [combinedBounds]);

  const [viewState, setViewState] = useState(defaultViewState);
  const activeViewRef = useRef(null);

  const handleViewStateChange = useCallback(
    (viewId) =>
      ({ viewState: newViewState }) => {
        if (syncViews || activeViewRef.current === viewId) {
          setViewState(newViewState);
        }
      },
    [syncViews]
  );

  const handleMouseEnter = useCallback((viewId) => {
    activeViewRef.current = viewId;
  }, []);

  const containerStyle = useMemo(
    () => ({
      position: 'relative',
      width,
      height,
      display: 'flex',
      backgroundColor: 'var(--sardine-bg, #0a1628)',
      ...style,
    }),
    [width, height, style]
  );

  const panelStyle = {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
    borderRight: '1px solid var(--sardine-border, #1e3a5f)',
  };

  const rightPanelStyle = {
    ...panelStyle,
    borderRight: 'none',
    borderLeft: '1px solid var(--sardine-border, #1e3a5f)',
  };

  const labelStyle = {
    position: 'absolute',
    top: '10px',
    left: '10px',
    background: 'var(--sardine-bg-raised, #0f1f38)',
    border: '1px solid var(--sardine-border, #1e3a5f)',
    color: 'var(--text-primary, #e8edf5)',
    padding: '5px 10px',
    borderRadius: 'var(--radius-sm, 4px)',
    fontSize: '0.75rem',
    fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
    fontWeight: '600',
    letterSpacing: '0.5px',
    zIndex: 1000,
  };

  return (
    <div style={containerStyle}>
      {/* Left Panel */}
      <div style={panelStyle} onMouseEnter={() => handleMouseEnter('left')}>
        {showLabels && <div style={labelStyle}>{leftLabel}</div>}
        <ViewerPanel
          image={leftImage}
          viewState={viewState}
          onViewStateChange={handleViewStateChange('left')}
        />
      </div>

      {/* Divider */}
      <div
        style={{
          width: '4px',
          backgroundColor: 'var(--sardine-border, #1e3a5f)',
          cursor: 'col-resize',
        }}
      />

      {/* Right Panel */}
      <div style={rightPanelStyle} onMouseEnter={() => handleMouseEnter('right')}>
        {showLabels && <div style={labelStyle}>{rightLabel}</div>}
        <ViewerPanel
          image={rightImage}
          viewState={viewState}
          onViewStateChange={handleViewStateChange('right')}
        />
      </div>
    </div>
  );
}

/**
 * ViewerPanel - Individual viewer panel for comparison
 */
function ViewerPanel({ image, viewState, onViewStateChange }) {
  const layers = useMemo(() => {
    if (!image?.getTile) return [];

    return [
      new SARTileLayer({
        id: 'sar-layer',
        getTile: image.getTile,
        bounds: image.bounds,
        contrastLimits: image.contrastLimits || [-25, 0],
        useDecibels: image.useDecibels !== false,
        colormap: image.colormap || 'grayscale',
        opacity: image.opacity || 1,
      }),
    ];
  }, [image]);

  const views = useMemo(
    () =>
      new OrthographicView({
        id: 'ortho-view',
        flipY: false,
      }),
    []
  );

  if (!image) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted, #5a7099)',
        }}
      >
        No image loaded
      </div>
    );
  }

  return (
    <DeckGL
      views={views}
      viewState={viewState}
      onViewStateChange={onViewStateChange}
      layers={layers}
      controller={true}
      style={{ width: '100%', height: '100%' }}
    />
  );
}

/**
 * SwipeComparisonViewer - Swipe-style comparison with single view
 * Allows swiping between two images
 */
export function SwipeComparisonViewer({
  leftImage,
  rightImage,
  width = '100%',
  height = '100%',
  initialSwipePosition = 0.5,
  style = {},
}) {
  const [swipePosition, setSwipePosition] = useState(initialSwipePosition);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef(null);

  // Calculate view state from combined bounds
  const combinedBounds = useMemo(() => {
    const leftBounds = leftImage?.bounds || [0, 0, 1, 1];
    const rightBounds = rightImage?.bounds || [0, 0, 1, 1];

    return [
      Math.min(leftBounds[0], rightBounds[0]),
      Math.min(leftBounds[1], rightBounds[1]),
      Math.max(leftBounds[2], rightBounds[2]),
      Math.max(leftBounds[3], rightBounds[3]),
    ];
  }, [leftImage?.bounds, rightImage?.bounds]);

  const defaultViewState = useMemo(() => {
    const [minX, minY, maxX, maxY] = combinedBounds;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const zoom = Math.log2(360 / Math.max(spanX, spanY)) - 1;

    return {
      target: [centerX, centerY],
      zoom: Math.max(-2, Math.min(zoom, 10)),
      minZoom: -2,
      maxZoom: 20,
    };
  }, [combinedBounds]);

  const [viewState, setViewState] = useState(defaultViewState);

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback(
    (e) => {
      if (!isDragging || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      setSwipePosition(Math.max(0, Math.min(1, x)));
    },
    [isDragging]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const leftLayers = useMemo(() => {
    if (!leftImage?.getTile) return [];

    return [
      new SARTileLayer({
        id: 'sar-layer-left',
        getTile: leftImage.getTile,
        bounds: leftImage.bounds,
        contrastLimits: leftImage.contrastLimits || [-25, 0],
        useDecibels: leftImage.useDecibels !== false,
        colormap: leftImage.colormap || 'grayscale',
        opacity: leftImage.opacity || 1,
      }),
    ];
  }, [leftImage]);

  const rightLayers = useMemo(() => {
    if (!rightImage?.getTile) return [];

    return [
      new SARTileLayer({
        id: 'sar-layer-right',
        getTile: rightImage.getTile,
        bounds: rightImage.bounds,
        contrastLimits: rightImage.contrastLimits || [-25, 0],
        useDecibels: rightImage.useDecibels !== false,
        colormap: rightImage.colormap || 'grayscale',
        opacity: rightImage.opacity || 1,
      }),
    ];
  }, [rightImage]);

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
      overflow: 'hidden',
      ...style,
    }),
    [width, height, style]
  );

  const swipeHandleStyle = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: `${swipePosition * 100}%`,
    width: '4px',
    backgroundColor: '#fff',
    cursor: 'ew-resize',
    zIndex: 1000,
    transform: 'translateX(-50%)',
    boxShadow: '0 0 10px rgba(0,0,0,0.5)',
  };

  return (
    <div ref={containerRef} style={containerStyle}>
      {/* Right layer (full width, underneath) */}
      <div style={{ position: 'absolute', inset: 0 }}>
        <DeckGL
          views={views}
          viewState={viewState}
          onViewStateChange={({ viewState: vs }) => setViewState(vs)}
          layers={rightLayers}
          controller={true}
        />
      </div>

      {/* Left layer (clipped) */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          clipPath: `inset(0 ${(1 - swipePosition) * 100}% 0 0)`,
        }}
      >
        <DeckGL
          views={views}
          viewState={viewState}
          onViewStateChange={({ viewState: vs }) => setViewState(vs)}
          layers={leftLayers}
          controller={true}
        />
      </div>

      {/* Swipe handle */}
      <div style={swipeHandleStyle} onMouseDown={handleMouseDown}>
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '30px',
            height: '30px',
            borderRadius: '50%',
            backgroundColor: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
          }}
        >
          ↔
        </div>
      </div>
    </div>
  );
}

export default ComparisonViewer;
