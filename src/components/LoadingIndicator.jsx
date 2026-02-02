import React from 'react';

/**
 * Loading indicator overlay for the map viewer
 * Shows tile loading progress and overview level
 */
export function LoadingIndicator({ tilesLoading, tilesLoaded, totalTiles, currentOverview, totalOverviews }) {
  // Always show if we have overview info
  if (tilesLoading === 0 && totalTiles === 0 && currentOverview === undefined) {
    return null; // Nothing to show
  }

  const progress = totalTiles > 0 ? (tilesLoaded / totalTiles) * 100 : 0;
  const isLoading = tilesLoading > 0;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '10px',
        right: '10px',
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        color: 'white',
        padding: '10px 14px',
        borderRadius: '4px',
        fontSize: '13px',
        fontFamily: 'monospace',
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        pointerEvents: 'none',
        border: '1px solid rgba(255, 255, 255, 0.2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {isLoading && (
          <div
            style={{
              width: '12px',
              height: '12px',
              border: '2px solid rgba(255, 255, 255, 0.3)',
              borderTop: '2px solid white',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }}
          />
        )}
        <div>
          {isLoading ? (
            <>
              Loading tiles: {tilesLoaded}/{totalTiles}
              {progress > 0 && ` (${progress.toFixed(0)}%)`}
            </>
          ) : totalTiles > 0 ? (
            `${tilesLoaded} tiles loaded`
          ) : null}
        </div>
      </div>
      {currentOverview !== undefined && totalOverviews > 0 && (
        <div style={{ fontSize: '11px', color: 'rgba(255, 255, 255, 0.8)' }}>
          Overview: {currentOverview} / {totalOverviews - 1} (Level {currentOverview})
        </div>
      )}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

export default LoadingIndicator;
