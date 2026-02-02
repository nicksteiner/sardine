import React, { useMemo } from 'react';

/**
 * Scale bar overlay showing map scale
 * Displays a simple line with distance
 */
export function ScaleBar({ viewState, bounds }) {
  const scaleInfo = useMemo(() => {
    if (!viewState || !bounds) {
      return null;
    }

    // Check if this is projected coordinates (meters)
    const isProjected = Math.abs(bounds[0]) > 180 || Math.abs(bounds[2]) > 180;

    if (!isProjected) {
      return null; // Only show for projected coordinates
    }

    // Calculate pixels per meter
    // For OrthographicView: zoom = log2(pixels/worldUnits)
    // So: pixels = worldUnits * 2^zoom
    const pixelsPerMeter = Math.pow(2, viewState.zoom || 0);

    // Find a nice round number for the scale bar
    // Target: 100-200 pixels wide
    const targetPixels = 150;
    const targetMeters = targetPixels / pixelsPerMeter;

    // Round to nice numbers: 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, etc.
    const magnitude = Math.pow(10, Math.floor(Math.log10(targetMeters)));
    const normalized = targetMeters / magnitude;
    let niceNumber;
    if (normalized < 1.5) niceNumber = 1;
    else if (normalized < 3.5) niceNumber = 2;
    else if (normalized < 7.5) niceNumber = 5;
    else niceNumber = 10;

    const scaleMeters = niceNumber * magnitude;
    const scalePixels = scaleMeters * pixelsPerMeter;

    // Format label
    let label;
    if (scaleMeters >= 1000) {
      label = `${(scaleMeters / 1000).toFixed(scaleMeters >= 10000 ? 0 : 1)} km`;
    } else {
      label = `${scaleMeters.toFixed(scaleMeters >= 100 ? 0 : scaleMeters >= 10 ? 0 : 1)} m`;
    }

    return { pixels: scalePixels, label };
  }, [viewState, bounds]);

  if (!scaleInfo) {
    return null;
  }

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '10px',
        left: '10px',
        zIndex: 10000,
        pointerEvents: 'none',
        padding: '8px',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        borderRadius: '4px',
      }}
    >
      {/* Scale bar */}
      <div
        style={{
          width: `${scaleInfo.pixels}px`,
          height: '5px',
          backgroundColor: 'white',
          border: '2px solid black',
          boxShadow: '0 0 6px rgba(0,0,0,0.8)',
          marginBottom: '4px',
        }}
      />
      {/* Label */}
      <div
        style={{
          fontSize: '13px',
          fontFamily: 'monospace',
          color: 'white',
          fontWeight: 'bold',
          textAlign: 'center',
          textShadow: '1px 1px 3px black, -1px -1px 3px black',
        }}
      >
        {scaleInfo.label}
      </div>
    </div>
  );
}

export default ScaleBar;
