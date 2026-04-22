/**
 * LocalExplorer — /local
 *
 * File-drop entry point. On drop, sniffs the file type and delegates to
 * the right explorer component *in-place* (no URL change). Supported:
 *   - NISAR GCOV / GUNW HDF5 (`.h5`, `.hdf5`, `.he5`)
 *   - generic COG / GeoTIFF (`.tif`, `.tiff`, `.geotiff`)
 *
 * Every delegate page must accept `localFile` as a prop (S295 risk mitigation:
 * page inputs must come from props, not URL params, so delegation works).
 */
import React, { useState, useCallback } from 'react';
import { Link } from 'wouter';
import GCOVExplorer from './GCOVExplorer.jsx';
import COGExplorer from './COGExplorer.jsx';

function classifyFile(file) {
  if (!file) return null;
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.h5') || name.endsWith('.hdf5') || name.endsWith('.he5')) return 'nisar';
  if (name.endsWith('.tif') || name.endsWith('.tiff') || name.endsWith('.geotiff')) return 'cog';
  return null;
}

export default function LocalExplorer() {
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback((f) => {
    if (!f) return;
    const kind = classifyFile(f);
    if (!kind) {
      setError(`Unsupported file type: ${f.name}. Expected .h5 / .hdf5 / .tif / .tiff.`);
      setFile(null);
      return;
    }
    setError(null);
    setFile(f);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer?.files?.[0];
    handleFile(f);
  }, [handleFile]);

  const onPick = useCallback((e) => {
    const f = e.target.files?.[0];
    handleFile(f);
  }, [handleFile]);

  // In-place delegation: render the matching explorer as a child.
  if (file) {
    const kind = classifyFile(file);
    if (kind === 'nisar') {
      return <GCOVExplorer localFile={file} />;
    }
    if (kind === 'cog') {
      return <COGExplorer localFile={file} />;
    }
  }

  return (
    <main
      data-testid="local-explorer"
      style={{
        minHeight: '100vh',
        background: 'var(--sardine-bg, #0f1419)',
        color: 'var(--sardine-ink, #e0e0e0)',
        fontFamily: 'system-ui, sans-serif',
        padding: '3rem 2rem',
      }}
    >
      <div style={{ maxWidth: '720px', margin: '0 auto' }}>
        <header style={{ marginBottom: '2rem' }}>
          <h1 style={{ margin: 0, color: 'var(--sardine-cyan, #4ec9d4)', fontSize: '2rem' }}>
            Local File Explorer
          </h1>
          <p style={{ color: 'var(--sardine-muted, #9aa5b8)', marginTop: '0.25rem' }}>
            Drop a NISAR HDF5 or GeoTIFF from your machine. SARdine auto-routes to the
            right explorer in place. <Link href="/">← chooser</Link>
          </p>
        </header>

        <div
          data-testid="local-dropzone"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          style={{
            border: '2px dashed',
            borderColor: dragOver ? 'var(--sardine-cyan, #4ec9d4)' : 'var(--sardine-border, #2a3140)',
            background: dragOver ? 'rgba(78, 201, 212, 0.08)' : 'var(--sardine-panel, #151a24)',
            borderRadius: '10px',
            padding: '3rem 2rem',
            textAlign: 'center',
            transition: 'border-color 120ms, background 120ms',
          }}
        >
          <div style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>
            Drop a <code>.h5</code> or <code>.tif</code> here
          </div>
          <div style={{ color: 'var(--sardine-muted, #9aa5b8)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
            or click to pick
          </div>
          <input
            data-testid="local-file-input"
            type="file"
            accept=".h5,.hdf5,.he5,.tif,.tiff,.geotiff"
            onChange={onPick}
            style={{
              background: 'var(--sardine-bg, #0f1419)',
              color: 'var(--sardine-ink, #e0e0e0)',
              border: '1px solid var(--sardine-border, #2a3140)',
              borderRadius: '4px',
              padding: '0.5rem 0.75rem',
              fontFamily: 'monospace',
              cursor: 'pointer',
            }}
          />
        </div>

        {error && (
          <div
            data-testid="local-error"
            style={{
              marginTop: '1rem',
              padding: '0.75rem 1rem',
              background: 'rgba(255, 107, 107, 0.1)',
              border: '1px solid var(--sardine-red, #ff6b6b)',
              borderRadius: '6px',
              color: 'var(--sardine-red, #ff6b6b)',
              fontFamily: 'monospace',
              fontSize: '0.85rem',
            }}
          >
            {error}
          </div>
        )}

        <section
          style={{
            marginTop: '2rem',
            padding: '1rem 1.25rem',
            background: 'var(--sardine-panel, #151a24)',
            border: '1px solid var(--sardine-border, #2a3140)',
            borderRadius: '6px',
            fontSize: '0.85rem',
            color: 'var(--sardine-muted, #9aa5b8)',
          }}
        >
          <div style={{ color: 'var(--sardine-cyan, #4ec9d4)', marginBottom: '0.25rem' }}>Supported formats</div>
          <ul style={{ margin: 0, paddingLeft: '1.25rem', lineHeight: 1.6 }}>
            <li><code>.h5</code> / <code>.hdf5</code> / <code>.he5</code> — NISAR L2 GCOV or GUNW → GCOV Explorer</li>
            <li><code>.tif</code> / <code>.tiff</code> / <code>.geotiff</code> — Cloud-Optimized GeoTIFF → COG Explorer</li>
          </ul>
        </section>
      </div>
    </main>
  );
}
