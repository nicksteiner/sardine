/**
 * NISARSearch — CMR granule search for NISAR GCOV/GUNW products.
 *
 * Uses NASA CMR Granule Search API (CORS-enabled, no proxy needed).
 * Token paste for Earthdata auth on data download URLs.
 * Supports single-scene load and multi-select for time-series.
 *
 * Props:
 *   onSelectScene: ({url, name, type, token, ...}) => void — single scene
 *   onSelectTimeSeries: ({scenes: [{url, name, datetime}], token, type}) => void — multi-scene
 *   onStatus: (type, message, details?) => void
 *   onLayersChange: (layers[]) => void — deck.gl footprint layers
 *   viewBounds: [west, south, east, north] | null
 *   onZoomToBounds: (bbox) => void
 */
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { GeoJsonLayer } from '@deck.gl/layers';
import { NISAR_PRODUCTS, searchGranules } from '../loaders/cmr-client.js';

export function NISARSearch({ onSelectScene, onSelectTimeSeries, onStatus, onLayersChange, onGranulesChange, onTokenChange, viewBounds, onZoomToBounds }) {
  // ─── Search state ───────────────────────────────────────────────────
  const [product, setProduct] = useState(NISAR_PRODUCTS[0].id);
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [useBbox, setUseBbox] = useState(false);
  const [track, setTrack] = useState('');
  const [frame, setFrame] = useState('');

  // ─── Auth ───────────────────────────────────────────────────────────
  const [token, setToken] = useState('');
  const [showAuth, setShowAuth] = useState(false);

  // ─── Results ────────────────────────────────────────────────────────
  const [granules, setGranules] = useState([]);
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState(null);
  const [pageNum, setPageNum] = useState(1);
  const [selectedIdx, setSelectedIdx] = useState(null);

  // ─── Multi-select ──────────────────────────────────────────────────
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIndices, setSelectedIndices] = useState(new Set());

  const currentProduct = NISAR_PRODUCTS.find(p => p.id === product);

  // ─── Search ─────────────────────────────────────────────────────────

  const handleSearch = useCallback(async (append = false) => {
    setSearching(true);
    if (!append) {
      setGranules([]);
      setSelectedIdx(null);
      setSelectedIndices(new Set());
      setPageNum(1);
      setHits(null);
    }

    const page = append ? pageNum + 1 : 1;

    try {
      const result = await searchGranules({
        shortName: product,
        bbox: useBbox && viewBounds ? viewBounds : undefined,
        dateStart: dateStart || undefined,
        dateEnd: dateEnd || undefined,
        track: track ? parseInt(track) : undefined,
        frame: frame ? parseInt(frame) : undefined,
        pageSize: 25,
        pageNum: page,
      });

      if (append) {
        setGranules(prev => [...prev, ...result.granules]);
      } else {
        setGranules(result.granules);
      }
      setHits(result.hits);
      setPageNum(page);

      const count = append ? granules.length + result.granules.length : result.granules.length;
      onStatus?.('success', `${count} of ${result.hits} granules`);
    } catch (e) {
      onStatus?.('error', 'CMR search failed', e.message);
    } finally {
      setSearching(false);
    }
  }, [product, useBbox, viewBounds, dateStart, dateEnd, track, frame, pageNum, granules.length, onStatus]);

  // ─── Select granule (single or multi) ──────────────────────────────

  const handleClick = useCallback((granule, idx) => {
    if (multiSelect) {
      setSelectedIndices(prev => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        return next;
      });
      return;
    }

    // Single-select: load immediately
    setSelectedIdx(idx);
    if (!granule.dataUrl) {
      onStatus?.('warning', `No data URL for ${granule.id}`);
      return;
    }
    onSelectScene?.({
      url: granule.dataUrl,
      name: granule.id,
      type: currentProduct?.type || 'nisar',
      size: granule.size || 0,
      token: token || undefined,
    });
    onStatus?.('info', `Loading: ${granule.id}`);
  }, [multiSelect, currentProduct, token, onSelectScene, onStatus]);

  // ─── Load time series ──────────────────────────────────────────────

  const handleLoadTimeSeries = useCallback(() => {
    const selected = [...selectedIndices]
      .sort((a, b) => a - b)
      .map(i => granules[i])
      .filter(g => g && g.dataUrl);

    if (selected.length < 2) {
      onStatus?.('warning', 'Select at least 2 granules with data URLs');
      return;
    }

    // Sort by datetime for proper temporal ordering
    selected.sort((a, b) => {
      if (!a.datetime || !b.datetime) return 0;
      return new Date(a.datetime) - new Date(b.datetime);
    });

    const scenes = selected.map(g => ({
      url: g.dataUrl,
      name: g.id,
      datetime: g.datetime,
      track: g.track,
      frame: g.frame,
    }));

    onSelectTimeSeries?.({
      scenes,
      token: token || undefined,
      type: currentProduct?.type || 'nisar',
      product: product,
    });

    onStatus?.('info', `Loading time series: ${scenes.length} scenes`);
  }, [selectedIndices, granules, token, currentProduct, product, onSelectTimeSeries, onStatus]);

  // ─── Select all / clear ────────────────────────────────────────────

  const handleSelectAll = useCallback(() => {
    const withData = new Set();
    granules.forEach((g, i) => { if (g.dataUrl) withData.add(i); });
    setSelectedIndices(withData);
  }, [granules]);

  // ─── Zoom to results ───────────────────────────────────────────────

  const handleZoomToResults = useCallback(() => {
    if (granules.length === 0) return;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const g of granules) {
      if (!g.bbox) continue;
      minLon = Math.min(minLon, g.bbox[0]);
      minLat = Math.min(minLat, g.bbox[1]);
      maxLon = Math.max(maxLon, g.bbox[2]);
      maxLat = Math.max(maxLat, g.bbox[3]);
    }
    if (isFinite(minLon)) {
      onZoomToBounds?.([minLon, minLat, maxLon, maxLat]);
    }
  }, [granules, onZoomToBounds]);

  // ─── Deck.gl footprint layers ──────────────────────────────────────

  const layers = useMemo(() => {
    if (granules.length === 0) return [];

    const features = granules
      .filter(g => g.geometry)
      .map((g, i) => ({
        type: 'Feature',
        geometry: g.geometry,
        properties: { id: g.id, _idx: i },
      }));

    if (features.length === 0) return [];

    const result = [
      new GeoJsonLayer({
        id: 'cmr-results-all',
        data: { type: 'FeatureCollection', features },
        pickable: true,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 1,
        getLineColor: [78, 201, 212, 200],
        getFillColor: [78, 201, 212, 30],
        getLineWidth: 1,
        opacity: 0.8,
        onClick: (info) => {
          if (info.object) {
            const idx = info.object.properties._idx;
            if (idx >= 0) handleClick(granules[idx], idx);
          }
        },
      }),
    ];

    // Highlight selected granules
    const highlightIndices = multiSelect ? [...selectedIndices] : (selectedIdx != null ? [selectedIdx] : []);
    const highlightFeatures = highlightIndices
      .map(i => granules[i])
      .filter(g => g?.geometry)
      .map(g => ({ type: 'Feature', geometry: g.geometry, properties: {} }));

    if (highlightFeatures.length > 0) {
      result.push(new GeoJsonLayer({
        id: 'cmr-results-selected',
        data: { type: 'FeatureCollection', features: highlightFeatures },
        pickable: false,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 3,
        getLineColor: [255, 200, 0, 255],
        getFillColor: [255, 200, 0, 50],
        getLineWidth: 3,
      }));
    }

    return result;
  }, [granules, selectedIdx, selectedIndices, multiSelect]);

  useEffect(() => {
    onLayersChange?.(layers);
  }, [layers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Forward granule footprints for OverviewMap (lat/lon polygons + data for click-to-load)
  useEffect(() => {
    if (!onGranulesChange) return;
    const footprints = granules
      .filter(g => g.geometry)
      .map((g, i) => ({
        geometry: g.geometry,
        selected: multiSelect ? selectedIndices.has(i) : i === selectedIdx,
        id: g.id,
        dataUrl: g.dataUrl,
        datetime: g.datetime,
        track: g.track,
        frame: g.frame,
        _idx: i,
      }));
    onGranulesChange(footprints);
  }, [granules, selectedIdx, selectedIndices, multiSelect]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      {/* Product selector */}
      <div className="control-group">
        <label>NISAR Product</label>
        <select
          value={product}
          onChange={e => setProduct(e.target.value)}
          style={{ fontSize: '0.75rem' }}
        >
          {NISAR_PRODUCTS.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {currentProduct && (
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '2px' }}>
            {currentProduct.description}
          </div>
        )}
      </div>

      {/* Auth token */}
      <div>
        <div
          onClick={() => setShowAuth(v => !v)}
          style={{
            cursor: 'pointer',
            fontSize: '0.75rem',
            color: token ? 'var(--status-success)' : 'var(--sardine-cyan)',
            userSelect: 'none',
          }}
        >
          {showAuth ? '\u25BC' : '\u25B6'} Earthdata Token
          {token && <span style={{ fontSize: '0.6rem', marginLeft: '4px' }}>(set)</span>}
        </div>
        {showAuth && (
          <div style={{
            marginTop: 'var(--space-xs)',
            padding: 'var(--space-sm)',
            background: 'var(--sardine-bg-raised)',
            border: '1px solid var(--sardine-border)',
            borderRadius: 'var(--radius-sm)',
          }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
              Required for data download. Get a token:<br />
              <code style={{ fontSize: '0.6rem', color: 'var(--sardine-cyan)', userSelect: 'all' }}>
                curl -n https://urs.earthdata.nasa.gov/api/users/tokens
              </code>
              <br />Paste the <code>access_token</code> value. Stored in memory only.
            </div>
            <input
              type="password"
              value={token}
              onChange={e => { setToken(e.target.value); onTokenChange?.(e.target.value); }}
              placeholder="Earthdata bearer token"
              style={{ width: '100%', fontSize: '0.75rem' }}
            />
          </div>
        )}
      </div>

      {/* Search filters */}
      <div className="control-group">
        <label>Search Filters</label>
        <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
          <input
            type="date"
            value={dateStart}
            onChange={e => setDateStart(e.target.value)}
            style={{ flex: 1, fontSize: '0.7rem' }}
            title="Start date"
          />
          <input
            type="date"
            value={dateEnd}
            onChange={e => setDateEnd(e.target.value)}
            style={{ flex: 1, fontSize: '0.7rem' }}
            title="End date"
          />
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-xs)', marginTop: '4px' }}>
          <input
            type="number"
            value={track}
            onChange={e => setTrack(e.target.value)}
            placeholder="Track"
            style={{ flex: 1, fontSize: '0.7rem' }}
            title="NISAR Track number"
          />
          <input
            type="number"
            value={frame}
            onChange={e => setFrame(e.target.value)}
            placeholder="Frame"
            style={{ flex: 1, fontSize: '0.7rem' }}
            title="NISAR Frame number"
          />
        </div>
        <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
          <input
            type="checkbox"
            checked={useBbox}
            onChange={e => setUseBbox(e.target.checked)}
          />
          Limit to overview map extent
          {useBbox && !viewBounds && (
            <span style={{ color: 'var(--status-warning)', fontSize: '0.6rem' }}>(pan overview map first)</span>
          )}
        </label>
        <button
          onClick={() => handleSearch(false)}
          disabled={searching}
          style={{ width: '100%', marginTop: '4px' }}
        >
          {searching ? 'Searching...' : 'Search CMR'}
        </button>
      </div>

      {/* Results header + multi-select toggle */}
      {granules.length > 0 && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
              {granules.length}{hits != null ? ` of ${hits}` : ''} granules
              <span style={{ color: 'var(--sardine-cyan)', marginLeft: '6px' }}>
                {'\u25CF'} {granules.filter(g => g.geometry).length} footprints
              </span>
            </div>
            <label style={{ fontSize: '0.65rem', display: 'flex', alignItems: 'center', gap: '3px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={multiSelect}
                onChange={e => {
                  setMultiSelect(e.target.checked);
                  setSelectedIndices(new Set());
                }}
              />
              Multi
            </label>
          </div>
          <button
            className="btn-secondary"
            onClick={handleZoomToResults}
            style={{ width: '100%', fontSize: '0.7rem' }}
          >
            Zoom to Results
          </button>
        </>
      )}

      {/* Multi-select controls */}
      {multiSelect && granules.length > 0 && (
        <div style={{
          display: 'flex', gap: 'var(--space-xs)', alignItems: 'center',
          padding: '4px',
          background: 'var(--sardine-bg-raised)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--sardine-border)',
        }}>
          <button
            onClick={handleLoadTimeSeries}
            disabled={selectedIndices.size < 2}
            style={{ fontSize: '0.65rem', flex: 1 }}
          >
            Load {selectedIndices.size} as Time Series
          </button>
          <button
            className="btn-secondary"
            onClick={handleSelectAll}
            style={{ fontSize: '0.6rem', padding: '2px 6px' }}
          >
            All
          </button>
          {selectedIndices.size > 0 && (
            <button
              className="btn-secondary"
              onClick={() => setSelectedIndices(new Set())}
              style={{ fontSize: '0.6rem', padding: '2px 6px' }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Granule list */}
      {granules.length > 0 && (
        <div style={{
          maxHeight: '300px',
          overflowY: 'auto',
          border: '1px solid var(--sardine-border)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--sardine-bg-raised)',
        }}>
          {granules.map((g, i) => {
            const isSelected = multiSelect ? selectedIndices.has(i) : i === selectedIdx;
            const hasData = !!g.dataUrl;
            const date = g.datetime ? new Date(g.datetime).toISOString().slice(0, 10) : '';
            const meta = [
              g.track != null ? `T${g.track}` : '',
              g.frame != null ? `F${g.frame}` : '',
              g.direction === 'D' ? 'Desc' : g.direction === 'A' ? 'Asc' : '',
              g.polarization || '',
            ].filter(Boolean).join(' | ');

            return (
              <div
                key={g.id || i}
                onClick={() => handleClick(g, i)}
                style={{
                  padding: '4px 8px',
                  cursor: hasData ? 'pointer' : 'default',
                  fontSize: '0.7rem',
                  fontFamily: 'var(--font-mono)',
                  background: isSelected ? 'rgba(78, 201, 212, 0.15)' : 'transparent',
                  borderBottom: '1px solid var(--sardine-border)',
                  opacity: hasData ? 1 : 0.5,
                }}
                title={`${g.id}\n${hasData ? g.dataUrl : 'No data URL'}`}
              >
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '4px',
                }}>
                  {multiSelect && (
                    <span style={{
                      width: '14px', height: '14px',
                      border: '1px solid var(--sardine-border)',
                      borderRadius: '2px',
                      background: isSelected ? 'var(--sardine-cyan)' : 'transparent',
                      flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.55rem', color: 'var(--sardine-bg)',
                    }}>
                      {isSelected ? '\u2713' : ''}
                    </span>
                  )}
                  <span style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    color: isSelected ? 'var(--sardine-cyan)' : 'var(--text-primary)',
                  }}>
                    {g.id.length > 50 ? '...' + g.id.slice(-47) : g.id}
                  </span>
                  <span style={{
                    width: '6px', height: '6px',
                    borderRadius: '50%',
                    background: hasData ? 'var(--status-success)' : 'var(--text-muted)',
                    flexShrink: 0,
                  }} />
                </div>
                <div style={{
                  fontSize: '0.6rem',
                  color: 'var(--text-muted)',
                  marginTop: '1px',
                }}>
                  {date}{meta ? ` | ${meta}` : ''}
                  {g.size && (
                    <span style={{ marginLeft: '4px' }}>
                      {(g.size / 1e9).toFixed(1)} GB
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Load more */}
      {hits != null && granules.length < hits && (
        <button
          className="btn-secondary"
          onClick={() => handleSearch(true)}
          disabled={searching}
          style={{ width: '100%', fontSize: '0.7rem' }}
        >
          {searching ? 'Loading...' : `Load More (${granules.length}/${hits})`}
        </button>
      )}
    </div>
  );
}

export default NISARSearch;
