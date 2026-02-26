/**
 * ROIWorkflow — WKT-based Region of Interest workflow for SARdine.
 *
 * Three-step wizard:
 *   1. Set ROI: paste WKT polygon/bbox, validate, preview bbox
 *   2. Discover Files: search STAC/CMR for NISAR files covering the ROI
 *   3. Select & Load: pick files, choose polarization, load ROI subset
 *
 * Props:
 *   onLoadSubset: ({url, name, type, roiBounds, roiCrs, ...}) => void
 *   onStatus: (type, message) => void
 *   onLayersChange: (layers[]) => void — deck.gl overlay layers for ROI + footprints
 *   onZoomToBounds: (bbox) => void — zoom map to bbox
 *   serverOrigin: string — for server-mediated S3 presigning
 */
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { GeoJsonLayer } from '@deck.gl/layers';
import { validateWKT, wktToBbox, wktToGeoJSON } from '../utils/wkt.js';
import {
  STAC_ENDPOINTS,
  listCollections,
  searchItems,
  resolveAsset,
} from '../loaders/stac-client.js';
import { parseNISARFilename } from '../utils/bucket-browser.js';

const STEPS = ['Set ROI', 'Discover', 'Load'];

export function ROIWorkflow({ onLoadSubset, onStatus, onLayersChange, onZoomToBounds, serverOrigin = '' }) {
  // ─── Step state ──────────────────────────────────────────────────────
  const [step, setStep] = useState(0);

  // ─── Step 1: ROI ─────────────────────────────────────────────────────
  const [wktInput, setWktInput] = useState('');
  const [validation, setValidation] = useState(null); // {valid, error?, bbox?, type?}

  // ─── Step 2: Discover ────────────────────────────────────────────────
  const [endpointUrl, setEndpointUrl] = useState(STAC_ENDPOINTS[0].url);
  const [collections, setCollections] = useState([]);
  const [selectedCollection, setSelectedCollection] = useState('');
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [items, setItems] = useState([]);
  const [searching, setSearching] = useState(false);
  const [matched, setMatched] = useState(null);
  const [nextToken, setNextToken] = useState(null);
  const [token, setToken] = useState('');

  // ─── Step 3: Select & Load ───────────────────────────────────────────
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [frequency, setFrequency] = useState('A');
  const [polarization, setPolarization] = useState('HHHH');

  // ─── WKT validation ──────────────────────────────────────────────────
  const handleWktChange = useCallback((value) => {
    setWktInput(value);
    if (!value.trim()) {
      setValidation(null);
      return;
    }
    setValidation(validateWKT(value));
  }, []);

  // ─── ROI bbox (derived) ──────────────────────────────────────────────
  const roiBbox = useMemo(() => {
    if (!validation?.valid) return null;
    return validation.bbox;
  }, [validation]);

  // ─── Step 2: Connect to STAC endpoint ────────────────────────────────
  const handleConnect = useCallback(async () => {
    setCollectionsLoading(true);
    setCollections([]);
    setSelectedCollection('');
    try {
      const colls = await listCollections(endpointUrl, { token: token || undefined });
      setCollections(colls);
      onStatus?.('success', `Found ${colls.length} collections`);
      // Auto-select NISAR collection
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
  }, [endpointUrl, token, onStatus]);

  // ─── Step 2: Search ──────────────────────────────────────────────────
  const handleSearch = useCallback(async (append = false) => {
    if (!roiBbox) return;

    setSearching(true);
    if (!append) {
      setItems([]);
      setSelectedIdx(null);
      setNextToken(null);
      setMatched(null);
    }

    try {
      const params = {
        bbox: roiBbox,
        limit: 25,
        token: token || undefined,
        nextToken: append ? nextToken : undefined,
      };
      if (selectedCollection) params.collections = [selectedCollection];
      if (dateStart || dateEnd) {
        const start = dateStart || '..';
        const end = dateEnd || '..';
        params.datetime = `${start}T00:00:00Z/${end}T23:59:59Z`;
      }

      const result = await searchItems(endpointUrl, params);

      if (append) {
        setItems(prev => [...prev, ...result.items]);
      } else {
        setItems(result.items);
      }
      setNextToken(result.nextToken);
      if (result.matched != null) setMatched(result.matched);

      const count = append ? items.length + result.items.length : result.items.length;
      const matchStr = result.matched != null ? ` of ${result.matched}` : '';
      onStatus?.('success', `${count}${matchStr} items covering ROI`);
    } catch (e) {
      onStatus?.('error', 'STAC search failed', e.message);
    } finally {
      setSearching(false);
    }
  }, [roiBbox, endpointUrl, selectedCollection, dateStart, dateEnd, token, nextToken, items.length, onStatus]);

  // ─── Step 3: Load selected file with ROI bounds ──────────────────────
  const handleLoadSubset = useCallback((item) => {
    const asset = resolveAsset(item);
    if (!asset) {
      onStatus?.('warning', `No loadable asset in ${item.id}`);
      return;
    }

    onLoadSubset?.({
      url: asset.href,
      name: item.id,
      type: asset.type === 'application/x-hdf5' ? 'nisar' : 'cog',
      roiBounds: roiBbox,
      roiCrs: 'EPSG:4326',
      frequency,
      polarization,
    });
    onStatus?.('info', `Loading ROI subset from ${item.id}`);
  }, [roiBbox, frequency, polarization, onLoadSubset, onStatus]);

  // ─── Deck.gl layers: ROI polygon + search result footprints ──────────
  const layers = useMemo(() => {
    const result = [];

    // ROI polygon overlay
    if (validation?.valid) {
      try {
        const roiFeature = wktToGeoJSON(wktInput);
        result.push(new GeoJsonLayer({
          id: 'roi-polygon',
          data: { type: 'FeatureCollection', features: [roiFeature] },
          pickable: false,
          stroked: true,
          filled: true,
          lineWidthMinPixels: 2,
          getLineColor: [255, 100, 50, 230],
          getFillColor: [255, 100, 50, 40],
          getLineWidth: 2,
        }));
      } catch { /* ignore parse errors */ }
    }

    // Search result footprints
    if (items.length > 0) {
      result.push(new GeoJsonLayer({
        id: 'roi-search-results',
        data: { type: 'FeatureCollection', features: items },
        pickable: true,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 1,
        getLineColor: [78, 201, 212, 200],
        getFillColor: [78, 201, 212, 30],
        getLineWidth: 1,
      }));
    }

    // Highlight selected item
    if (selectedIdx != null && items[selectedIdx]) {
      result.push(new GeoJsonLayer({
        id: 'roi-selected-item',
        data: { type: 'FeatureCollection', features: [items[selectedIdx]] },
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
  }, [validation, wktInput, items, selectedIdx]);

  useEffect(() => {
    onLayersChange?.(layers);
  }, [layers]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Parse NISAR filenames for display ───────────────────────────────
  const parsedItems = useMemo(() => {
    return items.map(item => ({
      item,
      parsed: parseNISARFilename(item.id),
      datetime: item.properties?.datetime,
    }));
  }, [items]);

  // ─── Zoom to ROI ────────────────────────────────────────────────────
  const handleZoomToROI = useCallback(() => {
    if (roiBbox) {
      onZoomToBounds?.(roiBbox);
    }
  }, [roiBbox, onZoomToBounds]);

  // ─── Render ──────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      {/* Step indicator */}
      <div style={{ display: 'flex', gap: '4px', fontSize: '0.65rem' }}>
        {STEPS.map((label, i) => (
          <button
            key={label}
            className={i === step ? '' : 'btn-secondary'}
            onClick={() => setStep(i)}
            disabled={i > 0 && !validation?.valid}
            style={{
              flex: 1,
              fontSize: '0.65rem',
              padding: '3px 4px',
              opacity: i === step ? 1 : 0.7,
            }}
          >
            {i + 1}. {label}
          </button>
        ))}
      </div>

      {/* ─── Step 1: Set ROI ─────────────────────────────────── */}
      {step === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          <div className="control-group">
            <label>WKT Geometry</label>
            <textarea
              value={wktInput}
              onChange={e => handleWktChange(e.target.value)}
              placeholder={'POLYGON ((lon1 lat1, lon2 lat2, ...))\nor BBOX(west, south, east, north)'}
              rows={4}
              style={{
                fontSize: '0.7rem',
                fontFamily: 'monospace',
                resize: 'vertical',
                width: '100%',
                background: 'var(--sardine-bg)',
                color: 'var(--sardine-text)',
                border: `1px solid ${validation === null ? 'var(--border-color)' : validation.valid ? 'var(--status-success)' : 'var(--status-error)'}`,
                borderRadius: '4px',
                padding: '6px',
              }}
            />
          </div>

          {/* Validation feedback */}
          {validation && (
            <div style={{
              fontSize: '0.65rem',
              color: validation.valid ? 'var(--status-success)' : 'var(--status-error)',
            }}>
              {validation.valid
                ? `${validation.type} — bbox: [${validation.bbox.map(v => v.toFixed(4)).join(', ')}]`
                : validation.error
              }
            </div>
          )}

          <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
            <button
              onClick={handleZoomToROI}
              disabled={!validation?.valid}
              className="btn-secondary"
              style={{ flex: 1, fontSize: '0.65rem' }}
            >
              Zoom to ROI
            </button>
            <button
              onClick={() => { setStep(1); handleConnect(); }}
              disabled={!validation?.valid}
              style={{ flex: 1, fontSize: '0.65rem' }}
            >
              Search Files
            </button>
          </div>
        </div>
      )}

      {/* ─── Step 2: Discover ─────────────────────────────────── */}
      {step === 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          {/* ROI summary */}
          {roiBbox && (
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
              ROI: [{roiBbox.map(v => v.toFixed(3)).join(', ')}]
            </div>
          )}

          {/* Endpoint */}
          <div className="control-group">
            <label>STAC Endpoint</label>
            <select
              value={endpointUrl}
              onChange={e => { setEndpointUrl(e.target.value); setCollections([]); setItems([]); }}
              style={{ fontSize: '0.75rem' }}
            >
              {STAC_ENDPOINTS.map(ep => (
                <option key={ep.id} value={ep.url}>
                  {ep.label}{ep.requiresAuth ? ' *' : ''}
                </option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 'var(--space-xs)', marginTop: '4px' }}>
              <button
                onClick={handleConnect}
                disabled={collectionsLoading}
                style={{ flex: 1, fontSize: '0.65rem' }}
              >
                {collectionsLoading ? 'Loading...' : 'Connect'}
              </button>
            </div>
          </div>

          {/* Auth token */}
          <div className="control-group">
            <label>Auth Token (if needed)</label>
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="Bearer token for authenticated endpoints"
              style={{ fontSize: '0.7rem' }}
            />
          </div>

          {/* Collection selector */}
          {collections.length > 0 && (
            <div className="control-group">
              <label>Collection ({collections.length})</label>
              <select
                value={selectedCollection}
                onChange={e => setSelectedCollection(e.target.value)}
                style={{ fontSize: '0.75rem' }}
              >
                <option value="">All Collections</option>
                {collections.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.title || c.id}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Date range */}
          <div className="control-group">
            <label>Date Range</label>
            <div style={{ display: 'flex', gap: '4px' }}>
              <input
                type="date"
                value={dateStart}
                onChange={e => setDateStart(e.target.value)}
                style={{ flex: 1, fontSize: '0.65rem' }}
              />
              <input
                type="date"
                value={dateEnd}
                onChange={e => setDateEnd(e.target.value)}
                style={{ flex: 1, fontSize: '0.65rem' }}
              />
            </div>
          </div>

          {/* Search button */}
          <button
            onClick={() => handleSearch(false)}
            disabled={searching || !roiBbox}
            style={{ fontSize: '0.7rem' }}
          >
            {searching ? 'Searching...' : 'Search ROI'}
          </button>

          {/* Results list */}
          {items.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '2px' }}>
                {items.length}{matched != null ? ` of ${matched}` : ''} results
              </div>
              <div style={{
                maxHeight: '200px',
                overflowY: 'auto',
                border: '1px solid var(--border-color)',
                borderRadius: '4px',
              }}>
                {parsedItems.map(({ item, parsed, datetime }, idx) => (
                  <div
                    key={item.id}
                    onClick={() => { setSelectedIdx(idx); setStep(2); }}
                    style={{
                      padding: '4px 6px',
                      cursor: 'pointer',
                      fontSize: '0.65rem',
                      background: selectedIdx === idx ? 'var(--sardine-bg-raised)' : 'transparent',
                      borderBottom: '1px solid var(--border-color)',
                    }}
                  >
                    <div style={{ fontWeight: selectedIdx === idx ? 600 : 400 }}>
                      {item.id}
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.6rem' }}>
                      {parsed
                        ? `T${parsed.track} F${parsed.frame} ${parsed.direction === 'A' ? 'Asc' : 'Desc'} ${parsed.polarization || ''}`
                        : ''
                      }
                      {datetime ? ` | ${datetime.slice(0, 10)}` : ''}
                    </div>
                  </div>
                ))}
              </div>

              {/* Load more */}
              {nextToken && (
                <button
                  onClick={() => handleSearch(true)}
                  disabled={searching}
                  className="btn-secondary"
                  style={{ fontSize: '0.65rem' }}
                >
                  {searching ? 'Loading...' : 'Load More'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ─── Step 3: Select & Load ───────────────────────────── */}
      {step === 2 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          {/* Selected file info */}
          {selectedIdx != null && items[selectedIdx] && (() => {
            const item = items[selectedIdx];
            const parsed = parseNISARFilename(item.id);
            return (
              <div style={{
                padding: '6px',
                background: 'var(--sardine-bg-raised)',
                borderRadius: '4px',
                fontSize: '0.65rem',
              }}>
                <div style={{ fontWeight: 600, marginBottom: '2px' }}>{item.id}</div>
                {parsed && (
                  <div style={{ color: 'var(--text-muted)' }}>
                    Track {parsed.track} | Frame {parsed.frame} | {parsed.direction === 'A' ? 'Ascending' : 'Descending'}
                    {parsed.polarization ? ` | ${parsed.polarization}` : ''}
                  </div>
                )}
                {item.properties?.datetime && (
                  <div style={{ color: 'var(--text-muted)' }}>
                    {item.properties.datetime}
                  </div>
                )}
              </div>
            );
          })()}

          {/* ROI summary */}
          {roiBbox && (
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
              ROI bbox: [{roiBbox.map(v => v.toFixed(4)).join(', ')}]
            </div>
          )}

          {/* Frequency / Polarization */}
          <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
            <div className="control-group" style={{ flex: 1 }}>
              <label>Frequency</label>
              <select
                value={frequency}
                onChange={e => setFrequency(e.target.value)}
                style={{ fontSize: '0.75rem' }}
              >
                <option value="A">Frequency A</option>
                <option value="B">Frequency B</option>
              </select>
            </div>
            <div className="control-group" style={{ flex: 1 }}>
              <label>Polarization</label>
              <select
                value={polarization}
                onChange={e => setPolarization(e.target.value)}
                style={{ fontSize: '0.75rem' }}
              >
                <option value="HHHH">HHHH</option>
                <option value="HVHV">HVHV</option>
                <option value="VVVV">VVVV</option>
                <option value="VHVH">VHVH</option>
              </select>
            </div>
          </div>

          {/* Load button */}
          <button
            onClick={() => {
              if (selectedIdx != null && items[selectedIdx]) {
                handleLoadSubset(items[selectedIdx]);
              }
            }}
            disabled={selectedIdx == null}
            style={{ fontSize: '0.7rem' }}
          >
            Load ROI Subset
          </button>

          {/* Back to results */}
          <button
            onClick={() => setStep(1)}
            className="btn-secondary"
            style={{ fontSize: '0.65rem' }}
          >
            Back to Results
          </button>
        </div>
      )}
    </div>
  );
}
