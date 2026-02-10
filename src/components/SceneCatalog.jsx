import React, { useState, useCallback, useMemo, useRef } from 'react';
import { GeoJsonLayer } from '@deck.gl/layers';
import { presignGeoJSON } from '../utils/s3-presign.js';

/**
 * SceneCatalog — Browse, select and load NISAR scenes from a GeoJSON catalog.
 *
 * Workflow:
 *   1. User loads a GeoJSON catalog (file drop, URL, or pasted JSON)
 *      - Features have scene footprint polygons
 *      - Properties contain: filename, s3_uri/s3_key, track, frame, etc.
 *   2. Footprints render on the deck.gl map as clickable polygons
 *   3. User can optionally enter AWS credentials to pre-sign URLs in-browser
 *   4. Click a scene → fires onSelectScene({url, name, ...properties})
 *      which the parent (main.jsx) routes to the existing remote loader
 *
 * Props:
 *   onSelectScene: (sceneInfo) => void   — called when user picks a scene to load
 *   onStatus: (type, message, details?) => void — status logging
 *   onLayersChange: (layers[]) => void   — passes deck.gl layers to parent for map overlay
 */
export function SceneCatalog({ onSelectScene, onStatus, onLayersChange }) {
  // GeoJSON catalog state
  const [catalog, setCatalog] = useState(null);
  const [catalogUrl, setCatalogUrl] = useState('');
  const [catalogName, setCatalogName] = useState('');
  const [loadingCatalog, setLoadingCatalog] = useState(false);

  // AWS credentials for pre-signing (kept in memory only, never persisted)
  const [showCredentials, setShowCredentials] = useState(false);
  const [credentials, setCredentials] = useState({
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
    region: 'us-west-2',
  });
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState(false);

  // Scene selection
  const [selectedFeatureIdx, setSelectedFeatureIdx] = useState(null);
  const [filterText, setFilterText] = useState('');

  const fileInputRef = useRef(null);

  // ─── Load catalog from URL ────────────────────────────────────────────

  const loadCatalogFromUrl = useCallback(async () => {
    if (!catalogUrl.trim()) return;
    setLoadingCatalog(true);
    setSigned(false);
    try {
      const resp = await fetch(catalogUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const geojson = await resp.json();
      if (!geojson.features) throw new Error('Not a valid GeoJSON FeatureCollection');
      setCatalog(geojson);
      setCatalogName(catalogUrl.split('/').pop() || 'catalog.geojson');
      onStatus?.('success', `Loaded ${geojson.features.length} scenes from catalog`);
    } catch (e) {
      onStatus?.('error', 'Failed to load catalog', e.message);
    } finally {
      setLoadingCatalog(false);
    }
  }, [catalogUrl, onStatus]);

  // ─── Load catalog from file drop/pick ─────────────────────────────────

  const loadCatalogFromFile = useCallback(async (file) => {
    setLoadingCatalog(true);
    setSigned(false);
    try {
      const text = await file.text();
      const geojson = JSON.parse(text);
      if (!geojson.features) throw new Error('Not a valid GeoJSON FeatureCollection');
      setCatalog(geojson);
      setCatalogName(file.name);
      onStatus?.('success', `Loaded ${geojson.features.length} scenes from ${file.name}`);
    } catch (e) {
      onStatus?.('error', 'Failed to parse GeoJSON', e.message);
    } finally {
      setLoadingCatalog(false);
    }
  }, [onStatus]);

  // ─── Pre-sign all URLs in catalog ─────────────────────────────────────

  const handlePresign = useCallback(async () => {
    if (!catalog || !credentials.accessKeyId || !credentials.secretAccessKey) {
      onStatus?.('warning', 'Enter AWS credentials before signing');
      return;
    }
    setSigning(true);
    try {
      const presigned = await presignGeoJSON(catalog, credentials, 3600);
      setCatalog(presigned);
      setSigned(true);
      const count = presigned.features.filter(f => f.properties?.presigned_url).length;
      onStatus?.('success', `Pre-signed ${count} scene URLs (valid 1 hour)`);
    } catch (e) {
      onStatus?.('error', 'Pre-signing failed', e.message);
    } finally {
      setSigning(false);
    }
  }, [catalog, credentials, onStatus]);

  // ─── Scene selection → parent ─────────────────────────────────────────

  const handleSelectScene = useCallback((feature, idx) => {
    setSelectedFeatureIdx(idx);
    const props = feature.properties || {};
    // Determine the best URL: presigned_url > url > presigned_url from s3_uri
    const url = props.presigned_url || props.url || props.s3_url || null;
    const name = props.filename || props.name || props.granule_id || `Scene ${idx + 1}`;

    if (!url) {
      onStatus?.('warning', `No URL for ${name} — add credentials and pre-sign, or ensure features have a "url" property`);
      return;
    }

    onSelectScene?.({
      url,
      name,
      size: props.size || 0,
      type: 'nisar', // default — could detect from filename
      ...props,
    });
    onStatus?.('info', `Selected: ${name}`);
  }, [onSelectScene, onStatus]);

  // ─── Filtered feature list ────────────────────────────────────────────

  const filteredFeatures = useMemo(() => {
    if (!catalog?.features) return [];
    if (!filterText.trim()) return catalog.features;
    const q = filterText.toLowerCase();
    return catalog.features.filter(f => {
      const p = f.properties || {};
      return (
        (p.filename && p.filename.toLowerCase().includes(q)) ||
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.track != null && String(p.track).includes(q)) ||
        (p.frame != null && String(p.frame).includes(q))
      );
    });
  }, [catalog, filterText]);

  // ─── Deck.gl overlay layers ───────────────────────────────────────────

  const layers = useMemo(() => {
    if (!catalog?.features) return [];

    const allLayer = new GeoJsonLayer({
      id: 'scene-catalog-all',
      data: catalog,
      pickable: true,
      stroked: true,
      filled: true,
      lineWidthMinPixels: 1,
      getLineColor: [78, 201, 212, 200],  // sardine cyan
      getFillColor: [78, 201, 212, 30],
      getLineWidth: 1,
      opacity: 0.8,
      onClick: (info) => {
        if (info.object) {
          const idx = catalog.features.indexOf(info.object);
          handleSelectScene(info.object, idx);
        }
      },
    });

    const layers = [allLayer];

    // Highlight selected feature
    if (selectedFeatureIdx != null && catalog.features[selectedFeatureIdx]) {
      const selected = catalog.features[selectedFeatureIdx];
      layers.push(new GeoJsonLayer({
        id: 'scene-catalog-selected',
        data: { type: 'FeatureCollection', features: [selected] },
        pickable: false,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 3,
        getLineColor: [255, 200, 0, 255],  // gold highlight
        getFillColor: [255, 200, 0, 50],
        getLineWidth: 3,
      }));
    }

    return layers;
  }, [catalog, selectedFeatureIdx, handleSelectScene]);

  // Push layers to parent whenever they change
  React.useEffect(() => {
    onLayersChange?.(layers);
  }, [layers, onLayersChange]);

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      {/* Catalog input */}
      <div className="control-group">
        <label>GeoJSON Catalog</label>
        <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
          <input
            type="text"
            value={catalogUrl}
            onChange={e => setCatalogUrl(e.target.value)}
            placeholder="URL to scenes.geojson"
            style={{ flex: 1 }}
            onKeyDown={e => e.key === 'Enter' && loadCatalogFromUrl()}
          />
          <button
            onClick={loadCatalogFromUrl}
            disabled={loadingCatalog || !catalogUrl.trim()}
            style={{ whiteSpace: 'nowrap' }}
          >
            {loadingCatalog ? '...' : 'Load'}
          </button>
        </div>
      </div>

      {/* File picker */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".geojson,.json"
        style={{ display: 'none' }}
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) loadCatalogFromFile(f);
          e.target.value = '';
        }}
      />
      <button
        className="btn-secondary"
        onClick={() => fileInputRef.current?.click()}
        style={{ width: '100%' }}
      >
        {catalog ? 'Change Catalog File...' : 'Choose Catalog File...'}
      </button>

      {/* Catalog info */}
      {catalog && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {catalogName} — {catalog.features.length} scenes
          {signed && <span style={{ color: 'var(--status-success)', marginLeft: '6px' }}>signed</span>}
        </div>
      )}

      {/* AWS Credentials (collapsible) */}
      {catalog && (
        <div>
          <div
            onClick={() => setShowCredentials(s => !s)}
            style={{
              cursor: 'pointer',
              fontSize: '0.75rem',
              color: 'var(--sardine-cyan)',
              userSelect: 'none',
              marginBottom: showCredentials ? 'var(--space-xs)' : 0,
            }}
          >
            {showCredentials ? '\u25BC' : '\u25B6'} AWS Credentials (for pre-signing)
          </div>
          {showCredentials && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)',
              padding: 'var(--space-sm)',
              background: 'var(--sardine-bg-raised)',
              border: '1px solid var(--sardine-border)',
              borderRadius: 'var(--radius-sm)',
            }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                Credentials are stored in memory only and never persisted.
              </div>
              <input
                type="text"
                placeholder="Access Key ID"
                value={credentials.accessKeyId}
                onChange={e => setCredentials(c => ({ ...c, accessKeyId: e.target.value }))}
              />
              <input
                type="password"
                placeholder="Secret Access Key"
                value={credentials.secretAccessKey}
                onChange={e => setCredentials(c => ({ ...c, secretAccessKey: e.target.value }))}
              />
              <input
                type="text"
                placeholder="Session Token (optional)"
                value={credentials.sessionToken}
                onChange={e => setCredentials(c => ({ ...c, sessionToken: e.target.value }))}
              />
              <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
                <input
                  type="text"
                  placeholder="Region"
                  value={credentials.region}
                  onChange={e => setCredentials(c => ({ ...c, region: e.target.value }))}
                  style={{ flex: 1 }}
                />
                <button
                  onClick={handlePresign}
                  disabled={signing || !credentials.accessKeyId}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {signing ? 'Signing...' : signed ? 'Re-sign' : 'Pre-sign URLs'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Scene list */}
      {catalog && catalog.features.length > 0 && (
        <div>
          <div className="control-group">
            <label>Scenes ({filteredFeatures.length})</label>
            <input
              type="text"
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
              placeholder="Filter by name, track, frame..."
              style={{ fontSize: '0.75rem' }}
            />
          </div>
          <div style={{
            maxHeight: '200px',
            overflowY: 'auto',
            border: '1px solid var(--sardine-border)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--sardine-bg-raised)',
          }}>
            {filteredFeatures.map((f, i) => {
              const p = f.properties || {};
              const name = p.filename || p.name || `Scene ${i + 1}`;
              const actualIdx = catalog.features.indexOf(f);
              const isSelected = actualIdx === selectedFeatureIdx;
              const hasUrl = !!(p.presigned_url || p.url || p.s3_url);
              return (
                <div
                  key={actualIdx}
                  onClick={() => handleSelectScene(f, actualIdx)}
                  style={{
                    padding: '4px 8px',
                    cursor: 'pointer',
                    fontSize: '0.7rem',
                    fontFamily: 'var(--font-mono)',
                    background: isSelected ? 'rgba(78, 201, 212, 0.15)' : 'transparent',
                    borderBottom: '1px solid var(--sardine-border)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                  title={name}
                >
                  <span style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    color: isSelected ? 'var(--sardine-cyan)' : 'var(--text-primary)',
                  }}>
                    {p.track != null && p.frame != null
                      ? `T${p.track}F${p.frame} `
                      : ''}
                    {name.length > 50 ? '...' + name.slice(-47) : name}
                  </span>
                  <span style={{
                    width: '6px', height: '6px',
                    borderRadius: '50%',
                    background: hasUrl
                      ? 'var(--status-success)'
                      : 'var(--text-muted)',
                    flexShrink: 0,
                  }} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default SceneCatalog;
