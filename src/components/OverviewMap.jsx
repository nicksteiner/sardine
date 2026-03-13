import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import { GeoJsonLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';

/**
 * OverviewMap — Toggleable geographic overview using deck.gl MapView.
 *
 * Renders CMR search footprints and the active scene footprint on a dark
 * basemap tile layer. Uses deck.gl for GPU-accelerated rendering (replaces
 * the old SVG approach for better performance with many footprints).
 *
 * Props:
 *   @param {Object|null} wgs84Bounds — { minLon, minLat, maxLon, maxLat } scene footprint
 *   @param {boolean} visible — external visibility toggle
 *   @param {Function} onToggle — callback when user clicks the open/close button
 *   @param {Array|null} cmrFootprints — [{geometry, selected, id, dataUrl, ...}]
 *   @param {Function|null} onSelectFootprint — callback(index) when a footprint is clicked
 */

const MAP_VIEW = new MapView({ id: 'overview-map', repeat: true });

// Dark basemap tiles (CartoDB dark-matter, no API key needed)
const BASEMAP_URL = 'https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png';

export function OverviewMap({ wgs84Bounds, visible = false, onToggle, cmrFootprints = null, onSelectFootprint = null, onViewBoundsChange = null }) {
  const containerRef = useRef(null);

  // View state in geographic coordinates
  const [viewState, setViewState] = useState({
    longitude: 0,
    latitude: 20,
    zoom: 1,
    pitch: 0,
    bearing: 0,
  });

  // Snap to scene footprint when it changes
  useEffect(() => {
    if (wgs84Bounds && visible) {
      const lon = (wgs84Bounds.minLon + wgs84Bounds.maxLon) / 2;
      const lat = (wgs84Bounds.minLat + wgs84Bounds.maxLat) / 2;
      const spanLon = wgs84Bounds.maxLon - wgs84Bounds.minLon;
      const spanLat = wgs84Bounds.maxLat - wgs84Bounds.minLat;
      const span = Math.max(spanLon, spanLat);
      const zoom = Math.max(0, Math.min(18, Math.log2(360 / span) - 1.5));
      setViewState(v => ({ ...v, longitude: lon, latitude: lat, zoom }));
    }
  }, [wgs84Bounds, visible]);

  // Auto-center on CMR footprints when they appear and no scene data
  useEffect(() => {
    if (!visible || !cmrFootprints?.length || wgs84Bounds) return;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const fp of cmrFootprints) {
      if (!fp.geometry?.coordinates) continue;
      const flat = (function flatten(c) {
        if (typeof c[0] === 'number') return [c];
        return c.flatMap(flatten);
      })(fp.geometry.coordinates);
      for (const [lon, lat] of flat) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
    if (!isFinite(minLon)) return;
    const span = Math.max(maxLon - minLon, maxLat - minLat);
    const zoom = Math.max(0, Math.min(18, Math.log2(360 / span) - 1));
    setViewState(v => ({
      ...v,
      longitude: (minLon + maxLon) / 2,
      latitude: (minLat + maxLat) / 2,
      zoom,
    }));
  }, [visible, cmrFootprints, wgs84Bounds]);

  // ── Layers ──

  const layers = useMemo(() => {
    const result = [];

    // Dark basemap tiles
    result.push(new TileLayer({
      id: 'overview-basemap',
      data: BASEMAP_URL,
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      renderSubLayers: (props) => {
        const { boundingBox } = props.tile;
        return new BitmapLayer(props, {
          data: null,
          image: props.data,
          bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]],
        });
      },
    }));

    // CMR footprints — all results
    if (cmrFootprints?.length) {
      const unselected = cmrFootprints
        .map((fp, i) => fp.geometry && !fp.selected ? { type: 'Feature', geometry: fp.geometry, properties: { _idx: i } } : null)
        .filter(Boolean);

      const selected = cmrFootprints
        .map((fp, i) => fp.geometry && fp.selected ? { type: 'Feature', geometry: fp.geometry, properties: { _idx: i } } : null)
        .filter(Boolean);

      if (unselected.length) {
        result.push(new GeoJsonLayer({
          id: 'overview-cmr-all',
          data: { type: 'FeatureCollection', features: unselected },
          pickable: !!onSelectFootprint,
          stroked: true,
          filled: true,
          lineWidthMinPixels: 1,
          getLineColor: [78, 201, 212, 180],
          getFillColor: [78, 201, 212, 20],
          getLineWidth: 1,
          onClick: (info) => {
            if (info.object && onSelectFootprint) {
              onSelectFootprint(info.object.properties._idx);
            }
          },
        }));
      }

      if (selected.length) {
        result.push(new GeoJsonLayer({
          id: 'overview-cmr-selected',
          data: { type: 'FeatureCollection', features: selected },
          pickable: !!onSelectFootprint,
          stroked: true,
          filled: true,
          lineWidthMinPixels: 2,
          getLineColor: [255, 200, 0, 255],
          getFillColor: [255, 200, 0, 40],
          getLineWidth: 2,
          onClick: (info) => {
            if (info.object && onSelectFootprint) {
              onSelectFootprint(info.object.properties._idx);
            }
          },
        }));
      }
    }

    // Scene footprint (loaded data extent in WGS84)
    if (wgs84Bounds) {
      const { minLon, minLat, maxLon, maxLat } = wgs84Bounds;
      result.push(new GeoJsonLayer({
        id: 'overview-scene-footprint',
        data: {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [minLon, minLat], [maxLon, minLat],
                [maxLon, maxLat], [minLon, maxLat],
                [minLon, minLat],
              ]],
            },
            properties: {},
          }],
        },
        pickable: false,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 2,
        getLineColor: [78, 201, 212, 255],
        getFillColor: [78, 201, 212, 25],
        getLineWidth: 2,
      }));
    }

    return result;
  }, [cmrFootprints, wgs84Bounds, onSelectFootprint]);

  // ── Handlers ──

  const handleViewStateChange = useCallback(({ viewState: vs }) => {
    setViewState(vs);
    // Report visible extent as [west, south, east, north] for CMR bbox filtering
    if (onViewBoundsChange) {
      // Approximate visible extent from zoom level and container size (400×240)
      const degsPerPx = 360 / (256 * Math.pow(2, vs.zoom));
      const halfW = (400 / 2) * degsPerPx;
      const halfH = (240 / 2) * degsPerPx;
      onViewBoundsChange([
        Math.max(-180, vs.longitude - halfW),
        Math.max(-90, vs.latitude - halfH),
        Math.min(180, vs.longitude + halfW),
        Math.min(90, vs.latitude + halfH),
      ]);
    }
  }, [onViewBoundsChange]);

  const handleResetView = useCallback(() => {
    if (wgs84Bounds) {
      const lon = (wgs84Bounds.minLon + wgs84Bounds.maxLon) / 2;
      const lat = (wgs84Bounds.minLat + wgs84Bounds.maxLat) / 2;
      const spanLon = wgs84Bounds.maxLon - wgs84Bounds.minLon;
      const span = Math.max(spanLon, wgs84Bounds.maxLat - wgs84Bounds.minLat);
      setViewState(v => ({ ...v, longitude: lon, latitude: lat, zoom: Math.log2(360 / span) - 1.5 }));
    } else {
      setViewState(v => ({ ...v, longitude: 0, latitude: 20, zoom: 1 }));
    }
  }, [wgs84Bounds]);

  // Format coordinate for status bar
  const fmtCoord = (v, axis) => {
    const abs = Math.abs(v);
    const suffix = axis === 'lon' ? (v >= 0 ? 'E' : 'W') : (v >= 0 ? 'N' : 'S');
    return abs < 1 ? `${abs.toFixed(2)}°${suffix}` :
           abs < 10 ? `${abs.toFixed(1)}°${suffix}` :
           `${Math.round(abs)}°${suffix}`;
  };

  // ── Render ──

  if (!visible) {
    return (
      <div className="overview-map-toggle" onClick={onToggle} title="Overview Map">
        <svg className="overview-map-toggle-icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.2">
          <circle cx="10" cy="10" r="8" />
          <ellipse cx="10" cy="10" rx="4" ry="8" />
          <line x1="2" y1="10" x2="18" y2="10" />
          <path d="M3.5 5.5 Q10 4 16.5 5.5" />
          <path d="M3.5 14.5 Q10 16 16.5 14.5" />
        </svg>
      </div>
    );
  }

  return (
    <div className="overview-map" ref={containerRef}>
      {/* Title bar */}
      <div className="overview-map-header">
        <span className="overview-map-title">Overview</span>
        <div className="overview-map-controls">
          <button className="overview-map-btn" onClick={handleResetView} title="Reset view">R</button>
          <button className="overview-map-btn" onClick={() => setViewState(v => ({ ...v, zoom: Math.max(0, v.zoom - 1) }))} title="Zoom out">&minus;</button>
          <span className="overview-map-zoom-label">z{Math.round(viewState.zoom)}</span>
          <button className="overview-map-btn" onClick={() => setViewState(v => ({ ...v, zoom: Math.min(18, v.zoom + 1) }))} title="Zoom in">+</button>
          <button className="overview-map-btn overview-map-close" onClick={onToggle} title="Close">&times;</button>
        </div>
      </div>

      {/* deck.gl map */}
      <div style={{ width: 400, height: 240, position: 'relative' }}>
        <DeckGL
          views={MAP_VIEW}
          viewState={viewState}
          onViewStateChange={handleViewStateChange}
          layers={layers}
          controller={{ dragRotate: false }}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
          getCursor={({ isDragging }) => isDragging ? 'grabbing' : (onSelectFootprint && cmrFootprints?.length ? 'pointer' : 'grab')}
        />
      </div>

      {/* Status bar */}
      <div className="overview-map-status">
        <span>
          {fmtCoord(viewState.latitude, 'lat')}, {fmtCoord(viewState.longitude, 'lon')}
        </span>
        {wgs84Bounds && (
          <span style={{ color: 'var(--sardine-cyan)' }}>
            {fmtCoord(wgs84Bounds.minLat, 'lat')}–{fmtCoord(wgs84Bounds.maxLat, 'lat')}
          </span>
        )}
        {cmrFootprints?.length > 0 && !wgs84Bounds && (
          <span style={{ color: 'var(--sardine-cyan)' }}>
            {cmrFootprints.length} granules
          </span>
        )}
      </div>
    </div>
  );
}

export default OverviewMap;
