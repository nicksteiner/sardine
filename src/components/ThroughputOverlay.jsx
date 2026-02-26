/**
 * ThroughputOverlay — Live streaming metrics floating panel.
 *
 * Shows throughput (MB/s), bytes transferred vs estimated total,
 * chunks loaded vs total, concurrency, and a progress bar.
 * Auto-fades after 5s of idle. Dismissable, reappears on new session.
 */
import React, { useState, useEffect, useRef } from 'react';

const formatBytes = (bytes) => {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
};

export function ThroughputOverlay({ metrics, totalChunks = 0, estimatedBytes = 0 }) {
  const [dismissed, setDismissed] = useState(false);
  const [faded, setFaded] = useState(false);
  const fadeTimer = useRef(null);

  // Auto-fade after 5s of no active fetches
  useEffect(() => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    if (!metrics || metrics.activeFetches === 0) {
      fadeTimer.current = setTimeout(() => setFaded(true), 5000);
    } else {
      setFaded(false);
    }
    return () => { if (fadeTimer.current) clearTimeout(fadeTimer.current); };
  }, [metrics?.lastUpdate, metrics?.activeFetches]);

  // Reappear when a new streaming session starts
  useEffect(() => {
    if (metrics && metrics.chunksLoaded > 0) {
      setDismissed(false);
      setFaded(false);
    }
  }, [metrics?.chunksLoaded > 0]);

  if (!metrics || dismissed) return null;

  const { totalBytes, chunksLoaded, avgMbps, concurrency, activeFetches } = metrics;
  const isActive = activeFetches > 0;
  const pct = totalChunks > 0 ? Math.min(100, (chunksLoaded / totalChunks) * 100) : 0;

  const row = (label, value) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: '#3a5070' }}>{label}</span>
      <span>{value}</span>
    </div>
  );

  return (
    <div
      style={{
        position: 'absolute',
        top: 10,
        left: 10,
        background: 'rgba(10, 22, 40, 0.92)',
        backdropFilter: 'blur(8px)',
        border: '1px solid #1e3a5f',
        borderRadius: 3,
        padding: '8px 12px',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: '0.65rem',
        color: '#8fa4c4',
        zIndex: 100,
        pointerEvents: 'auto',
        opacity: faded ? 0.3 : 1,
        transition: 'opacity 0.5s ease',
        minWidth: 175,
        lineHeight: 1.7,
      }}
      onMouseEnter={() => setFaded(false)}
    >
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 4, paddingBottom: 3, borderBottom: '1px dashed #162d4a',
      }}>
        <span style={{
          fontSize: '0.6rem', fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase',
          color: isActive ? '#4ec9d4' : '#5a7099',
        }}>
          {isActive ? 'STREAMING' : 'IDLE'}
        </span>
        <span
          onClick={() => setDismissed(true)}
          style={{ cursor: 'pointer', color: '#3a5070', fontSize: '0.7rem', marginLeft: 8 }}
        >x</span>
      </div>

      {/* Metrics rows */}
      {row('Throughput', <span style={{ color: '#4ec9d4', fontWeight: 500 }}>{avgMbps.toFixed(1)} MB/s</span>)}
      {row('Downloaded', formatBytes(totalBytes))}
      {row('Chunks', totalChunks > 0
        ? `${chunksLoaded} / ${totalChunks}`
        : String(chunksLoaded)
      )}
      {row('Concurrency', isActive ? `${concurrency} (${activeFetches} active)` : String(concurrency))}

      {/* Progress bar */}
      {totalChunks > 0 && (
        <div style={{ marginTop: 5 }}>
          <div style={{
            height: 4, borderRadius: 2, background: '#162d4a', overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', borderRadius: 2, width: `${pct}%`,
              background: pct >= 100 ? '#2ecc71' : '#4ec9d4',
              transition: 'width 0.3s ease',
            }} />
          </div>
          <div style={{ textAlign: 'right', fontSize: '0.55rem', color: '#5a7099', marginTop: 2 }}>
            {pct.toFixed(0)}%
          </div>
        </div>
      )}
    </div>
  );
}

export default ThroughputOverlay;
