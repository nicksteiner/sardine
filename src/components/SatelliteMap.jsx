import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import { GeoJsonLayer, BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';

const MAP_VIEW = new MapView({ id: 'satellite-map', repeat: true });

function tileToQuadkey(x, y, z) {
  let qk = '';
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit++;
    if ((y & mask) !== 0) digit += 2;
    qk += digit;
  }
  return qk;
}

/**
 * SatelliteMap — Bing VirtualEarth aerial imagery panel.
 *
 * Toggle button sits next to the OverviewMap wireframe globe. When open,
 * shows Bing aerial tiles with the loaded scene footprint overlaid.
 *
 * Props:
 *   @param {{ minLon, minLat, maxLon, maxLat }|null} wgs84Bounds
 *   @param {boolean} visible
 *   @param {Function} onToggle
 */
export function SatelliteMap({ wgs84Bounds, visible = false, onToggle }) {
  const [viewState, setViewState] = useState({
    longitude: 0,
    latitude: 20,
    zoom: 1,
    pitch: 0,
    bearing: 0,
  });

  // Persist the last valid bounds so the footprint doesn't vanish during
  // RGB reload (imageData briefly changes → wgs84Bounds recomputes)
  const stableBoundsRef = useRef(wgs84Bounds);
  if (wgs84Bounds) stableBoundsRef.current = wgs84Bounds;
  const stableBounds = stableBoundsRef.current;

  // Snap to scene footprint only when bounds first become available or panel opens
  const snappedRef = useRef(false);
  useEffect(() => {
    if (wgs84Bounds && visible && !snappedRef.current) {
      snappedRef.current = true;
      const lon = (wgs84Bounds.minLon + wgs84Bounds.maxLon) / 2;
      const lat = (wgs84Bounds.minLat + wgs84Bounds.maxLat) / 2;
      const span = Math.max(
        wgs84Bounds.maxLon - wgs84Bounds.minLon,
        wgs84Bounds.maxLat - wgs84Bounds.minLat,
      );
      const zoom = Math.max(0, Math.min(18, Math.log2(360 / span) - 1.5));
      setViewState(v => ({ ...v, longitude: lon, latitude: lat, zoom }));
    }
    if (!visible) snappedRef.current = false; // reset when panel closes
  }, [wgs84Bounds, visible]);

  // Stable Bing tile layer — created once, never rebuilt, preserves tile cache
  const tileLayer = useMemo(() => new TileLayer({
    id: 'satellite-bing-aerial',
    getTileData: ({ x, y, z }) => {
      const qk = tileToQuadkey(x, y, z);
      const srv = (x + y) % 4;
      const url = `https://ecn.t${srv}.tiles.virtualearth.net/tiles/a${qk}.jpeg?g=1`;
      return fetch(url, { mode: 'cors' })
        .then(r => r.ok ? r.blob() : null)
        .then(b => b ? createImageBitmap(b) : null)
        .catch(() => null);
    },
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: (props) => {
      const { boundingBox } = props.tile;
      if (!props.data) return null;
      return new BitmapLayer(props, {
        data: null,
        image: props.data,
        bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]],
      });
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Footprint layer — uses stableBounds so it survives transient null during RGB reload
  const layers = useMemo(() => {
    const result = [tileLayer];
    if (stableBounds) {
      const { minLon, minLat, maxLon, maxLat } = stableBounds;
      result.push(new GeoJsonLayer({
        id: 'satellite-scene-footprint',
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
        getFillColor: [78, 201, 212, 18],
        getLineWidth: 2,
      }));
    }
    return result;
  }, [tileLayer, stableBounds]);

  const handleViewStateChange = useCallback(({ viewState: vs }) => {
    setViewState(vs);
  }, []);

  const handleResetView = useCallback(() => {
    if (stableBoundsRef.current) {
      const b = stableBoundsRef.current;
      const lon = (b.minLon + b.maxLon) / 2;
      const lat = (b.minLat + b.maxLat) / 2;
      const span = Math.max(b.maxLon - b.minLon, b.maxLat - b.minLat);
      setViewState(v => ({ ...v, longitude: lon, latitude: lat, zoom: Math.log2(360 / span) - 1.5 }));
    } else {
      setViewState(v => ({ ...v, longitude: 0, latitude: 20, zoom: 1 }));
    }
  }, []);

  const fmtCoord = (v, axis) => {
    const abs = Math.abs(v);
    const suffix = axis === 'lon' ? (v >= 0 ? 'E' : 'W') : (v >= 0 ? 'N' : 'S');
    return abs < 1 ? `${abs.toFixed(2)}°${suffix}`
      : abs < 10 ? `${abs.toFixed(1)}°${suffix}`
      : `${Math.round(abs)}°${suffix}`;
  };

  if (!visible) {
    return (
      <div className="satellite-map-toggle" onClick={onToggle} title="Satellite View (Bing VirtualEarth)">
        {/* Aerial/satellite icon — 2×2 filled grid contrasting with wireframe globe */}
        <svg className="overview-map-toggle-icon" viewBox="0 0 20 20" width="18" height="18" fill="currentColor" stroke="none">
          <rect x="2"  y="2"  width="7" height="7" rx="1" opacity="0.9" />
          <rect x="11" y="2"  width="7" height="7" rx="1" opacity="0.6" />
          <rect x="2"  y="11" width="7" height="7" rx="1" opacity="0.5" />
          <rect x="11" y="11" width="7" height="7" rx="1" opacity="0.8" />
        </svg>
      </div>
    );
  }

  return (
    <div className="satellite-map">
      <div className="overview-map-header">
        <span className="overview-map-title">Satellite · Bing VirtualEarth</span>
        <div className="overview-map-controls">
          <button className="overview-map-btn" onClick={handleResetView} title="Reset view">R</button>
          <button className="overview-map-btn" onClick={() => setViewState(v => ({ ...v, zoom: Math.max(0, v.zoom - 1) }))} title="Zoom out">&minus;</button>
          <span className="overview-map-zoom-label">z{Math.round(viewState.zoom)}</span>
          <button className="overview-map-btn" onClick={() => setViewState(v => ({ ...v, zoom: Math.min(18, v.zoom + 1) }))} title="Zoom in">+</button>
          <button className="overview-map-btn overview-map-close" onClick={onToggle} title="Close">&times;</button>
        </div>
      </div>

      <div style={{ width: 400, height: 240, position: 'relative' }}>
        <DeckGL
          views={MAP_VIEW}
          viewState={viewState}
          onViewStateChange={handleViewStateChange}
          layers={layers}
          controller={{ dragRotate: false }}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
          getCursor={({ isDragging }) => isDragging ? 'grabbing' : 'grab'}
        />
      </div>

      <div className="overview-map-status">
        <span>{fmtCoord(viewState.latitude, 'lat')}, {fmtCoord(viewState.longitude, 'lon')}</span>
        {wgs84Bounds && (
          <span style={{ color: 'var(--sardine-cyan)' }}>
            © Bing Maps
          </span>
        )}
      </div>
    </div>
  );
}

export default SatelliteMap;
