import React, { useState, useEffect, useRef } from 'react';

/**
 * ThroughputOverlay - Compact HUD showing live S3 streaming stats.
 * Displays current speed (MB/s), total bytes downloaded, request count,
 * and adaptive concurrency level.
 *
 * Position: top-left corner of the viewer, semi-transparent dark panel.
 */
export function ThroughputOverlay({ loader, visible = true }) {
  const [stats, setStats] = useState(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!loader || !visible) {
      setStats(null);
      return;
    }

    // Set up the live callback from h5chunk batch fetches
    if (loader.onStreamingStats !== undefined) {
      loader.onStreamingStats = (s) => setStats({ ...s });
    }

    // Also poll periodically (catches _fetchBytes reads that don't fire onStats)
    intervalRef.current = setInterval(() => {
      if (loader.getStreamingStats) {
        const s = loader.getStreamingStats();
        if (s && s.totalBytes > 0) setStats({ ...s });
      }
    }, 500);

    return () => {
      clearInterval(intervalRef.current);
      if (loader.onStreamingStats !== undefined) {
        loader.onStreamingStats = null;
      }
    };
  }, [loader, visible]);

  if (!visible || !stats || stats.totalBytes === 0) return null;

  const formatBytes = (bytes) => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
  };

  const elapsed = stats.elapsedMs / 1000;

  return (
    <div style={{
      position: 'absolute',
      top: 8,
      left: 8,
      zIndex: 1000,
      backgroundColor: 'rgba(10, 20, 40, 0.85)',
      border: '1px solid var(--sardine-border, #1e3a5f)',
      borderRadius: 6,
      padding: '6px 10px',
      fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
      fontSize: '0.65rem',
      color: 'var(--text-secondary, #8899bb)',
      lineHeight: 1.6,
      pointerEvents: 'none',
      userSelect: 'none',
      minWidth: 140,
    }}>
      <div style={{ color: 'var(--sardine-cyan, #4ec9d4)', fontWeight: 600, marginBottom: 2, fontSize: '0.6rem', letterSpacing: '0.5px' }}>
        S3 STREAMING
      </div>
      <div>
        <span style={{ color: speedColor(stats.currentMbps) }}>
          {stats.currentMbps.toFixed(1)}
        </span>
        <span style={{ color: 'var(--text-muted, #5a7099)' }}> MB/s</span>
      </div>
      <div>
        <span>{formatBytes(stats.totalBytes)}</span>
        <span style={{ color: 'var(--text-muted, #5a7099)' }}> downloaded</span>
      </div>
      <div>
        <span>{stats.totalRequests}</span>
        <span style={{ color: 'var(--text-muted, #5a7099)' }}> requests</span>
        <span style={{ color: 'var(--text-muted, #5a7099)' }}> / </span>
        <span>{elapsed.toFixed(1)}s</span>
      </div>
      <div style={{ color: 'var(--text-muted, #5a7099)' }}>
        avg {stats.avgMbps.toFixed(1)} MB/s
        {' '}c={stats.concurrency}
      </div>
    </div>
  );
}

function speedColor(mbps) {
  if (mbps >= 20) return '#4ade80'; // green — fast
  if (mbps >= 5) return '#facc15';  // yellow — medium
  if (mbps >= 1) return '#fb923c';  // orange — slow
  return '#f87171';                 // red — very slow
}
