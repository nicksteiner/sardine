/**
 * STACSearch — STAC catalog search and scene browser for SARdine.
 *
 * Connects to STAC API endpoints, searches by collection/bbox/date,
 * displays footprints on the map, and routes scene selection to the
 * existing remote loader via onSelectScene.
 *
 * Props:
 *   onSelectScene: ({url, name, type, ...}) => void — single scene picked for loading
 *   onSelectMultiple: ({urls, names, types, mode, items}) => void — multiple scenes for multi-band/temporal
 *   onStatus: (type, message, details?) => void — status logging
 *   onLayersChange: (layers[]) => void — deck.gl footprint layers
 *   viewBounds: [west, south, east, north] | null — current map viewport for bbox
 */
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { GeoJsonLayer } from '@deck.gl/layers';
import {
  STAC_ENDPOINTS,
  listCollections,
  searchItems,
  itemToScene,
  extractItemFilters,
  formatDatetime,
  resolveAsset,
} from '../loaders/stac-client.js';

export function STACSearch({ onSelectScene, onSelectMultiple, onStatus, onLayersChange, viewBounds }) {
  // ─── Connection state ────────────────────────────────────────────────
  const [endpointUrl, setEndpointUrl] = useState(STAC_ENDPOINTS[0].url);
  const [customUrl, setCustomUrl] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [token, setToken] = useState('');
  const [showAuth, setShowAuth] = useState(false);

  // ─── Collections ─────────────────────────────────────────────────────
  const [collections, setCollections] = useState([]);
  const [selectedCollection, setSelectedCollection] = useState('');
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [collectionFilter, setCollectionFilter] = useState('');

  // ─── Search parameters ───────────────────────────────────────────────
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [useBbox, setUseBbox] = useState(false);

  // ─── Results ─────────────────────────────────────────────────────────
  const [items, setItems] = useState([]);
  const [searching, setSearching] = useState(false);
  const [nextToken, setNextToken] = useState(null);
  const [matched, setMatched] = useState(null);
  const [selectedItemIdx, setSelectedItemIdx] = useState(null);

  // ─── Multi-select ──────────────────────────────────────────────────
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [multiMode, setMultiMode] = useState('temporal'); // 'temporal' | 'multi-band'

  // ─── Filters on results ──────────────────────────────────────────────
  const [filterPol, setFilterPol] = useState('');
  const [filterOrbit, setFilterOrbit] = useState('');
  const [filterPlatform, setFilterPlatform] = useState('');

  const activeUrl = useCustom ? customUrl.trim() : endpointUrl;
  const currentEndpoint = STAC_ENDPOINTS.find(e => e.url === endpointUrl);

  // ─── Load collections on endpoint change ─────────────────────────────

  const handleLoadCollections = useCallback(async () => {
    if (!activeUrl) return;
    setCollectionsLoading(true);
    setCollections([]);
    setSelectedCollection('');
    setItems([]);
    setNextToken(null);

    try {
      const colls = await listCollections(activeUrl, { token: token || undefined });
      setCollections(colls);
      onStatus?.('success', `Found ${colls.length} collections`);

      // Auto-select first SAR/NISAR collection if available
      const nisar = colls.find(c =>
        c.id.toLowerCase().includes('nisar') ||
        c.id.toLowerCase().includes('gcov')
      );
      if (nisar) setSelectedCollection(nisar.id);
    } catch (e) {
      onStatus?.('error', 'Failed to load collections', e.message);
    } finally {
      setCollectionsLoading(false);
    }
  }, [activeUrl, token, onStatus]);

  // ─── Search ──────────────────────────────────────────────────────────

  const handleSearch = useCallback(async (append = false) => {
    if (!activeUrl) return;

    setSearching(true);
    if (!append) {
      setItems([]);
      setSelectedItemIdx(null);
      setNextToken(null);
      setMatched(null);
    }

    try {
      const params = {
        collections: selectedCollection ? [selectedCollection] : undefined,
        limit: 25,
        token: token || undefined,
        nextToken: append ? nextToken : undefined,
      };

      // Date range
      if (dateStart || dateEnd) {
        const start = dateStart || '..';
        const end = dateEnd || '..';
        params.datetime = `${start}T00:00:00Z/${end}T23:59:59Z`;
      }

      // Bounding box from current viewport
      if (useBbox && viewBounds) {
        params.bbox = viewBounds;
      }

      const result = await searchItems(activeUrl, params);

      if (append) {
        setItems(prev => [...prev, ...result.items]);
      } else {
        setItems(result.items);
      }
      setNextToken(result.nextToken);
      if (result.matched != null) setMatched(result.matched);

      const count = append
        ? items.length + result.items.length
        : result.items.length;
      const matchStr = result.matched != null ? ` of ${result.matched}` : '';
      onStatus?.('success', `${count}${matchStr} items found`);
    } catch (e) {
      onStatus?.('error', 'STAC search failed', e.message);
    } finally {
      setSearching(false);
    }
  }, [activeUrl, selectedCollection, dateStart, dateEnd, useBbox, viewBounds, token, nextToken, items.length, onStatus]);

  // ─── Scene selection (single) ────────────────────────────────────────

  const handleSelectItem = useCallback((item, idx) => {
    if (multiSelect) {
      // Toggle selection in multi-select mode
      setSelectedIndices(prev => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        return next;
      });
      return;
    }
    setSelectedItemIdx(idx);
    const scene = itemToScene(item);
    if (!scene) {
      onStatus?.('warning', `No loadable asset in ${item.id}`, 'Item has no HDF5 or COG assets');
      return;
    }
    onSelectScene?.(scene);
    onStatus?.('info', `Selected: ${scene.name}`);
  }, [multiSelect, onSelectScene, onStatus]);

  // ─── Load multiple selected items ──────────────────────────────────

  const handleLoadMultiple = useCallback(() => {
    if (selectedIndices.size < 2) {
      onStatus?.('warning', 'Select at least 2 items for multi-file loading');
      return;
    }

    const selected = [...selectedIndices]
      .sort((a, b) => a - b)
      .map(i => filteredItems[i])
      .filter(Boolean);

    const resolved = selected
      .map(item => {
        const asset = resolveAsset(item);
        if (!asset) return null;
        const p = item.properties || {};
        return {
          url: asset.href,
          name: item.id,
          type: asset.type,
          datetime: p.datetime,
          polarizations: p['sar:polarizations'],
        };
      })
      .filter(Boolean);

    if (resolved.length < 2) {
      onStatus?.('warning', `Only ${resolved.length} items have loadable assets`);
      return;
    }

    onSelectMultiple?.({
      scenes: resolved,
      mode: multiMode,
    });
    onStatus?.('info', `Loading ${resolved.length} items as ${multiMode}`);
  }, [selectedIndices, filteredItems, multiMode, onSelectMultiple, onStatus]);

  // ─── Filter options from search results ──────────────────────────────

  const filterOptions = useMemo(() => {
    if (items.length === 0) return null;
    return extractItemFilters(items);
  }, [items]);

  // ─── Apply result filters ────────────────────────────────────────────

  const filteredItems = useMemo(() => {
    if (!filterPol && !filterOrbit && !filterPlatform) return items;
    return items.filter(item => {
      const p = item.properties || {};
      if (filterPol && !(p['sar:polarizations'] || []).includes(filterPol)) return false;
      if (filterOrbit && p['sat:orbit_state'] !== filterOrbit) return false;
      if (filterPlatform && p.platform !== filterPlatform) return false;
      return true;
    });
  }, [items, filterPol, filterOrbit, filterPlatform]);

  // ─── Filtered collection list ────────────────────────────────────────

  const filteredCollections = useMemo(() => {
    if (!collectionFilter.trim()) return collections;
    const q = collectionFilter.toLowerCase();
    return collections.filter(c =>
      (c.id && c.id.toLowerCase().includes(q)) ||
      (c.title && c.title.toLowerCase().includes(q)) ||
      (c.description && c.description.toLowerCase().includes(q))
    );
  }, [collections, collectionFilter]);

  // ─── Deck.gl footprint layers ────────────────────────────────────────

  const layers = useMemo(() => {
    if (filteredItems.length === 0) return [];

    const fc = {
      type: 'FeatureCollection',
      features: filteredItems,
    };

    const allLayer = new GeoJsonLayer({
      id: 'stac-results-all',
      data: fc,
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
          const idx = filteredItems.indexOf(info.object);
          handleSelectItem(info.object, idx);
        }
      },
    });

    const result = [allLayer];

    // Highlight: multi-select or single-select
    const highlightFeatures = multiSelect
      ? [...selectedIndices].map(i => filteredItems[i]).filter(Boolean)
      : (selectedItemIdx != null && filteredItems[selectedItemIdx])
        ? [filteredItems[selectedItemIdx]]
        : [];

    if (highlightFeatures.length > 0) {
      result.push(new GeoJsonLayer({
        id: 'stac-results-selected',
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
  }, [filteredItems, selectedItemIdx, selectedIndices, multiSelect, handleSelectItem]);

  useEffect(() => {
    onLayersChange?.(layers);
  }, [layers, onLayersChange]);

  // ─── Render ──────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      {/* Endpoint selector */}
      <div className="control-group">
        <label>STAC Endpoint</label>
        {!useCustom ? (
          <select
            value={endpointUrl}
            onChange={e => setEndpointUrl(e.target.value)}
            style={{ fontSize: '0.75rem' }}
          >
            {STAC_ENDPOINTS.map(ep => (
              <option key={ep.id} value={ep.url}>
                {ep.label}{ep.requiresAuth ? ' *' : ''}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={customUrl}
            onChange={e => setCustomUrl(e.target.value)}
            placeholder="https://your-stac-api.example.com/stac"
            style={{ fontSize: '0.75rem' }}
          />
        )}
        <div style={{ display: 'flex', gap: 'var(--space-xs)', marginTop: '4px' }}>
          <button
            className="btn-secondary"
            onClick={() => setUseCustom(v => !v)}
            style={{ fontSize: '0.65rem', flex: 1 }}
          >
            {useCustom ? 'Use Preset' : 'Custom URL'}
          </button>
          <button
            onClick={handleLoadCollections}
            disabled={collectionsLoading || !activeUrl}
            style={{ flex: 1 }}
          >
            {collectionsLoading ? 'Loading...' : 'Connect'}
          </button>
        </div>
      </div>

      {/* Endpoint description */}
      {!useCustom && currentEndpoint && (
        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
          {currentEndpoint.description}
          {currentEndpoint.requiresAuth && (
            <span style={{ color: 'var(--status-warning)', marginLeft: '4px' }}>
              (requires auth)
            </span>
          )}
        </div>
      )}

      {/* Auth token (collapsible) */}
      <div>
        <div
          onClick={() => setShowAuth(v => !v)}
          style={{
            cursor: 'pointer',
            fontSize: '0.75rem',
            color: 'var(--sardine-cyan)',
            userSelect: 'none',
          }}
        >
          {showAuth ? '\u25BC' : '\u25B6'} Authentication
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
              Bearer token (e.g. NASA Earthdata Login token). Stored in memory only.
            </div>
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="Bearer token"
              style={{ width: '100%', fontSize: '0.75rem' }}
            />
          </div>
        )}
      </div>

      {/* Collection selector */}
      {collections.length > 0 && (
        <div className="control-group">
          <label>Collection ({filteredCollections.length})</label>
          {collections.length > 10 && (
            <input
              type="text"
              value={collectionFilter}
              onChange={e => setCollectionFilter(e.target.value)}
              placeholder="Filter collections..."
              style={{ fontSize: '0.7rem', marginBottom: '4px' }}
            />
          )}
          <select
            value={selectedCollection}
            onChange={e => setSelectedCollection(e.target.value)}
            style={{ fontSize: '0.75rem' }}
          >
            <option value="">All collections</option>
            {filteredCollections.map(c => (
              <option key={c.id} value={c.id}>
                {c.title || c.id}
              </option>
            ))}
          </select>
          {selectedCollection && (
            <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '2px' }}>
              {collections.find(c => c.id === selectedCollection)?.description?.slice(0, 120)}
            </div>
          )}
        </div>
      )}

      {/* Search parameters */}
      {(collections.length > 0 || useCustom) && (
        <div className="control-group">
          <label>Search</label>
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
          <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
            <input
              type="checkbox"
              checked={useBbox}
              onChange={e => setUseBbox(e.target.checked)}
            />
            Limit to current viewport
            {useBbox && !viewBounds && (
              <span style={{ color: 'var(--status-warning)', fontSize: '0.6rem' }}>(no bounds)</span>
            )}
          </label>
          <button
            onClick={() => handleSearch(false)}
            disabled={searching}
            style={{ width: '100%', marginTop: '4px' }}
          >
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>
      )}

      {/* Result filters */}
      {filterOptions && items.length > 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
          {filterOptions.polarizations.length > 1 && (
            <select
              value={filterPol}
              onChange={e => setFilterPol(e.target.value)}
              style={{ fontSize: '0.65rem', flex: 1 }}
            >
              <option value="">Pol: All</option>
              {filterOptions.polarizations.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          )}
          {filterOptions.orbitDirections.length > 1 && (
            <select
              value={filterOrbit}
              onChange={e => setFilterOrbit(e.target.value)}
              style={{ fontSize: '0.65rem', flex: 1 }}
            >
              <option value="">Orbit: All</option>
              {filterOptions.orbitDirections.map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          )}
          {filterOptions.platforms.length > 1 && (
            <select
              value={filterPlatform}
              onChange={e => setFilterPlatform(e.target.value)}
              style={{ fontSize: '0.65rem', flex: 1 }}
            >
              <option value="">Platform: All</option>
              {filterOptions.platforms.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Results count + multi-select toggle */}
      {items.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
            {filteredItems.length}{filteredItems.length !== items.length ? `/${items.length}` : ''} items
            {matched != null && ` of ${matched} total`}
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
      )}

      {/* Multi-select controls */}
      {multiSelect && items.length > 0 && (
        <div style={{
          display: 'flex', gap: 'var(--space-xs)', alignItems: 'center',
          padding: '4px',
          background: 'var(--sardine-bg-raised)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--sardine-border)',
        }}>
          <select
            value={multiMode}
            onChange={e => setMultiMode(e.target.value)}
            style={{ fontSize: '0.65rem', flex: 1 }}
          >
            <option value="temporal">Temporal Stack</option>
            <option value="multi-band">Multi-Band</option>
          </select>
          <button
            onClick={handleLoadMultiple}
            disabled={selectedIndices.size < 2}
            style={{ fontSize: '0.65rem', whiteSpace: 'nowrap' }}
          >
            Load {selectedIndices.size} Selected
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

      {/* Item list */}
      {filteredItems.length > 0 && (
        <div style={{
          maxHeight: '250px',
          overflowY: 'auto',
          border: '1px solid var(--sardine-border)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--sardine-bg-raised)',
        }}>
          {filteredItems.map((item, i) => {
            const p = item.properties || {};
            const isSelected = multiSelect ? selectedIndices.has(i) : i === selectedItemIdx;
            const asset = resolveAsset(item);
            const hasAsset = !!asset;
            const date = formatDatetime(p.datetime);
            const pols = (p['sar:polarizations'] || []).join('+');
            const orbit = p['sat:orbit_state'];

            return (
              <div
                key={item.id || i}
                onClick={() => handleSelectItem(item, i)}
                style={{
                  padding: '4px 8px',
                  cursor: hasAsset ? 'pointer' : 'default',
                  fontSize: '0.7rem',
                  fontFamily: 'var(--font-mono)',
                  background: isSelected ? 'rgba(78, 201, 212, 0.15)' : 'transparent',
                  borderBottom: '1px solid var(--sardine-border)',
                  opacity: hasAsset ? 1 : 0.5,
                }}
                title={`${item.id}\n${date}${pols ? ' | ' + pols : ''}${orbit ? ' | ' + orbit : ''}\n${hasAsset ? asset.type.toUpperCase() + ': ' + asset.key : 'No loadable asset'}`}
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
                    {item.id.length > 45 ? '...' + item.id.slice(-42) : item.id}
                  </span>
                  <span style={{
                    width: '6px', height: '6px',
                    borderRadius: '50%',
                    background: hasAsset ? 'var(--status-success)' : 'var(--text-muted)',
                    flexShrink: 0,
                  }} />
                </div>
                <div style={{
                  fontSize: '0.6rem',
                  color: 'var(--text-muted)',
                  marginTop: '1px',
                }}>
                  {date}{pols ? ` | ${pols}` : ''}{orbit ? ` | ${orbit}` : ''}
                  {hasAsset && <span style={{ marginLeft: '4px', color: 'var(--sardine-cyan)' }}>[{asset.type}]</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Load more */}
      {nextToken && (
        <button
          className="btn-secondary"
          onClick={() => handleSearch(true)}
          disabled={searching}
          style={{ width: '100%', fontSize: '0.7rem' }}
        >
          {searching ? 'Loading...' : 'Load More'}
        </button>
      )}
    </div>
  );
}

export default STACSearch;
