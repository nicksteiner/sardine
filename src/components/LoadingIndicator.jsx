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
        backgroundColor: 'var(--sardine-bg-raised, #0f1f38)',
        color: 'var(--text-primary, #e8edf5)',
        padding: '10px 14px',
        borderRadius: 'var(--radius-sm, 4px)',
        fontSize: '0.75rem',
        fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        pointerEvents: 'none',
        border: '1px solid var(--sardine-border, #1e3a5f)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {isLoading && (
          <div
            style={{
              width: '12px',
              height: '12px',
              border: '2px solid var(--sardine-border, #1e3a5f)',
              borderTop: '2px solid var(--sardine-cyan, #4ec9d4)',
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
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted, #5a7099)' }}>
          Overview: {currentOverview} / {totalOverviews - 1} (Level {currentOverview})
        </div>
      )}
    </div>
  );
}

export default LoadingIndicator;
