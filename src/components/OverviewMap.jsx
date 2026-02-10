import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { fetchWorldCoastlines, fetchOvertureTile } from '../loaders/overture-loader.js';

/**
 * OverviewMap — Toggleable, zoomable global overview map overlay.
 *
 * Lives in the bottom-left of the viewer container. Can be opened/closed
 * with a small globe button. Supports zoom in/out with +/- buttons and
 * mouse wheel, plus click-drag panning.
 *
 * Shows Overture Maps coastline geometry at the current zoom level,
 * with the active scene footprint highlighted.
 *
 * Props:
 *   @param {Object|null} wgs84Bounds — { minLon, minLat, maxLon, maxLat } scene footprint
 *   @param {boolean} visible — external visibility toggle
 *   @param {Function} onToggle — callback when user clicks the open/close button
 */

// ── Zoom presets ──
// Each zoom level defines how many degrees of longitude are visible in the map width
const ZOOM_LEVELS = [
  { label: '1×', lonSpan: 360, tileZoom: 0 },   // Whole world
  { label: '2×', lonSpan: 180, tileZoom: 1 },   // Hemisphere
  { label: '4×', lonSpan: 90,  tileZoom: 2 },   // Quarter
  { label: '8×', lonSpan: 45,  tileZoom: 3 },   // Region
  { label: '16×', lonSpan: 22.5, tileZoom: 3 }, // Country
  { label: '32×', lonSpan: 11.25, tileZoom: 4 }, // Metro
];

/**
 * Convert GeoJSON geometry → SVG path string within a given viewport.
 */
function geoToSVGPath(geometry, lonToX, latToY) {
  if (!geometry) return '';

  function ringToPath(coords) {
    if (!coords || coords.length === 0) return '';
    const parts = coords.map((c, i) => {
      const x = lonToX(c[0]);
      const y = latToY(c[1]);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return parts.join(' ') + ' Z';
  }

  function lineToPath(coords) {
    if (!coords || coords.length === 0) return '';
    return coords.map((c, i) => {
      const x = lonToX(c[0]);
      const y = latToY(c[1]);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }

  switch (geometry.type) {
    case 'Polygon':
      return (geometry.coordinates || []).map(ringToPath).join(' ');
    case 'MultiPolygon':
      return (geometry.coordinates || []).flatMap(poly => poly.map(ringToPath)).join(' ');
    case 'LineString':
      return lineToPath(geometry.coordinates);
    case 'MultiLineString':
      return (geometry.coordinates || []).map(lineToPath).join(' ');
    default:
      return '';
  }
}


export function OverviewMap({ wgs84Bounds, visible = false, onToggle }) {
  const [zoomIdx, setZoomIdx] = useState(0);
  // Center of view in degrees [lon, lat]
  const [center, setCenter] = useState([0, 20]);
  const [coastlines, setCoastlines] = useState(null);
  const [detailTiles, setDetailTiles] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef(null);
  const centerAtDragStartRef = useRef(null);
  const fetchedZoomRef = useRef(-1);
  const svgRef = useRef(null);

  const mapW = 380;
  const mapH = 220;

  const zoom = ZOOM_LEVELS[zoomIdx];

  // Snap center to scene footprint when footprint changes
  useEffect(() => {
    if (wgs84Bounds && visible) {
      const cLon = (wgs84Bounds.minLon + wgs84Bounds.maxLon) / 2;
      const cLat = (wgs84Bounds.minLat + wgs84Bounds.maxLat) / 2;
      setCenter([cLon, cLat]);

      // Auto-zoom to fit footprint
      const spanLon = wgs84Bounds.maxLon - wgs84Bounds.minLon;
      const targetSpan = spanLon * 6; // footprint should be ~1/6 of view width
      const bestIdx = ZOOM_LEVELS.findIndex(z => z.lonSpan <= targetSpan);
      if (bestIdx >= 0) {
        setZoomIdx(bestIdx);
      }
    }
  }, [wgs84Bounds, visible]);

  // Fetch base coastlines (z0/z1) on first open
  useEffect(() => {
    if (!visible || coastlines) return;
    setLoading(true);
    fetchWorldCoastlines({ zoom: 1 })
      .then(data => {
        setCoastlines(data);
        setLoading(false);
      })
      .catch(err => {
        console.warn('[OverviewMap] Coastline fetch failed:', err.message);
        setLoading(false);
      });
  }, [visible, coastlines]);

  // Fetch detail tiles when zoom > z1
  useEffect(() => {
    if (!visible || zoom.tileZoom <= 1) {
      setDetailTiles(null);
      fetchedZoomRef.current = -1;
      return;
    }
    if (fetchedZoomRef.current === zoom.tileZoom &&
        detailTiles?._center?.[0] === Math.round(center[0]) &&
        detailTiles?._center?.[1] === Math.round(center[1])) {
      return; // Already fetched for this viewport
    }

    const tz = zoom.tileZoom;
    const n = Math.pow(2, tz);
    const lonSpan = zoom.lonSpan;
    const latSpan = lonSpan * (mapH / mapW);

    const minLon = center[0] - lonSpan / 2;
    const maxLon = center[0] + lonSpan / 2;
    const minLat = center[1] - latSpan / 2;
    const maxLat = center[1] + latSpan / 2;

    // Tile range
    const xMin = Math.max(0, Math.floor(((minLon + 180) / 360) * n));
    const xMax = Math.min(n - 1, Math.floor(((maxLon + 180) / 360) * n));

    function latToTileY(lat) {
      const latRad = lat * Math.PI / 180;
      return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    }
    const yMin = Math.max(0, latToTileY(Math.min(85, maxLat)));
    const yMax = Math.min(n - 1, latToTileY(Math.max(-85, minLat)));

    // Limit tile count to avoid excessive fetching
    const tileCount = (xMax - xMin + 1) * (yMax - yMin + 1);
    if (tileCount > 25) {
      return; // Too many tiles at this zoom
    }

    const fetches = [];
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        fetches.push(fetchOvertureTile('base', tz, x, y));
      }
    }

    setLoading(true);
    Promise.all(fetches).then(results => {
      const land = [];
      const water = [];
      for (const decoded of results) {
        for (const [layerName, features] of Object.entries(decoded.layers)) {
          for (const f of features) {
            const sub = f.properties?.subtype || f.properties?.class || layerName;
            if (layerName === 'water' || sub === 'ocean' || sub === 'sea' || sub === 'lake') {
              water.push(f);
            } else {
              land.push(f);
            }
          }
        }
      }
      setDetailTiles({ land, water, _center: [Math.round(center[0]), Math.round(center[1])] });
      fetchedZoomRef.current = tz;
      setLoading(false);
    }).catch(err => {
      console.warn('[OverviewMap] Detail tiles failed:', err.message);
      setLoading(false);
    });
  }, [visible, zoomIdx, center[0], center[1]]);

  // Projection functions for current viewport
  const lonSpan = zoom.lonSpan;
  const latSpan = lonSpan * (mapH / mapW);

  const lonToX = useCallback((lon) => {
    return ((lon - (center[0] - lonSpan / 2)) / lonSpan) * mapW;
  }, [center[0], lonSpan]);

  const latToY = useCallback((lat) => {
    return ((center[1] + latSpan / 2 - lat) / latSpan) * mapH;
  }, [center[1], latSpan]);

  const xToLon = useCallback((x) => {
    return (x / mapW) * lonSpan + (center[0] - lonSpan / 2);
  }, [center[0], lonSpan]);

  const yToLat = useCallback((y) => {
    return (center[1] + latSpan / 2) - (y / mapH) * latSpan;
  }, [center[1], latSpan]);

  // Which coastline set to render
  const displayData = (zoom.tileZoom > 1 && detailTiles) ? detailTiles : coastlines;

  const landPaths = useMemo(() => {
    if (!displayData?.land) return '';
    return displayData.land.map(f => geoToSVGPath(f.geometry, lonToX, latToY)).filter(Boolean).join(' ');
  }, [displayData, lonToX, latToY]);

  const waterPaths = useMemo(() => {
    if (!displayData?.water) return '';
    return displayData.water.map(f => geoToSVGPath(f.geometry, lonToX, latToY)).filter(Boolean).join(' ');
  }, [displayData, lonToX, latToY]);

  // Scene footprint in SVG coordinates
  const footprint = useMemo(() => {
    if (!wgs84Bounds) return null;
    const x1 = lonToX(wgs84Bounds.minLon);
    const y1 = latToY(wgs84Bounds.maxLat);
    const x2 = lonToX(wgs84Bounds.maxLon);
    const y2 = latToY(wgs84Bounds.minLat);
    const w = Math.max(3, x2 - x1);
    const h = Math.max(3, y2 - y1);
    return { x: x1, y: y1, w, h };
  }, [wgs84Bounds, lonToX, latToY]);

  // ── Interaction handlers ──

  function handleZoomIn() {
    setZoomIdx(z => Math.min(z + 1, ZOOM_LEVELS.length - 1));
  }

  function handleZoomOut() {
    setZoomIdx(z => Math.max(z - 1, 0));
  }

  function handleWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.deltaY < 0) {
      handleZoomIn();
    } else {
      handleZoomOut();
    }
  }

  function handleMouseDown(e) {
    if (e.button !== 0) return;
    setDragging(true);
    const rect = svgRef.current.getBoundingClientRect();
    dragStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    centerAtDragStartRef.current = [...center];
    e.preventDefault();
  }

  function handleMouseMove(e) {
    if (!dragging || !dragStartRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = (e.clientX - rect.left) - dragStartRef.current.x;
    const dy = (e.clientY - rect.top) - dragStartRef.current.y;

    // Convert pixel delta to degree delta
    const dLon = -(dx / mapW) * lonSpan;
    const dLat = (dy / mapH) * latSpan;

    setCenter([
      Math.max(-180, Math.min(180, centerAtDragStartRef.current[0] + dLon)),
      Math.max(-85, Math.min(85, centerAtDragStartRef.current[1] + dLat)),
    ]);
  }

  function handleMouseUp() {
    setDragging(false);
    dragStartRef.current = null;
  }

  // Global mouse up to handle drag release outside SVG
  useEffect(() => {
    if (!dragging) return;
    const up = () => handleMouseUp();
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [dragging]);

  function handleResetView() {
    setZoomIdx(0);
    if (wgs84Bounds) {
      setCenter([
        (wgs84Bounds.minLon + wgs84Bounds.maxLon) / 2,
        (wgs84Bounds.minLat + wgs84Bounds.maxLat) / 2,
      ]);
    } else {
      setCenter([0, 20]);
    }
  }

  // Graticule lines for current viewport
  const graticuleLines = useMemo(() => {
    // Grid spacing depends on zoom
    let spacing = 30;
    if (lonSpan <= 90) spacing = 15;
    if (lonSpan <= 45) spacing = 10;
    if (lonSpan <= 22) spacing = 5;

    const lines = [];
    const minLon = center[0] - lonSpan / 2;
    const maxLon = center[0] + lonSpan / 2;
    const minLat = center[1] - latSpan / 2;
    const maxLat = center[1] + latSpan / 2;

    // Vertical (longitude) lines
    const startLon = Math.ceil(minLon / spacing) * spacing;
    for (let lon = startLon; lon <= maxLon; lon += spacing) {
      lines.push({ type: 'v', pos: lon, x: lonToX(lon), isEquator: false, isPrime: lon === 0 });
    }

    // Horizontal (latitude) lines
    const startLat = Math.ceil(minLat / spacing) * spacing;
    for (let lat = startLat; lat <= maxLat; lat += spacing) {
      lines.push({ type: 'h', pos: lat, y: latToY(lat), isEquator: lat === 0, isPrime: false });
    }
    return lines;
  }, [center, lonSpan, latSpan, lonToX, latToY]);

  // ── Render ──

  if (!visible) {
    // Collapsed globe button only
    return (
      <div className="overview-map-toggle" onClick={onToggle} title="Open Overview Map">
        <span className="overview-map-toggle-icon">🌍</span>
      </div>
    );
  }

  return (
    <div className="overview-map">
      {/* Title bar */}
      <div className="overview-map-header">
        <span className="overview-map-title">
          <span style={{ marginRight: '4px' }}>🌍</span>
          Overview
          {loading && <span className="overview-map-loading"> ⟳</span>}
        </span>
        <div className="overview-map-controls">
          <button className="overview-map-btn" onClick={handleResetView} title="Reset view">⌂</button>
          <button className="overview-map-btn" onClick={handleZoomOut} title="Zoom out" disabled={zoomIdx === 0}>−</button>
          <span className="overview-map-zoom-label">{zoom.label}</span>
          <button className="overview-map-btn" onClick={handleZoomIn} title="Zoom in" disabled={zoomIdx === ZOOM_LEVELS.length - 1}>+</button>
          <button className="overview-map-btn overview-map-close" onClick={onToggle} title="Close overview map">✕</button>
        </div>
      </div>

      {/* Map SVG */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${mapW} ${mapH}`}
        width={mapW}
        height={mapH}
        className="overview-map-svg"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
      >
        {/* Background */}
        <rect x={0} y={0} width={mapW} height={mapH} fill="#060e1a" />

        {/* Graticule */}
        {graticuleLines.map((g, i) => {
          if (g.type === 'v') {
            return (
              <line key={`g${i}`}
                x1={g.x} y1={0} x2={g.x} y2={mapH}
                stroke={g.isPrime ? '#162d4a' : '#0d1f35'}
                strokeWidth={g.isPrime ? '0.8' : '0.4'}
                strokeDasharray={g.isPrime ? '3,2' : undefined}
              />
            );
          }
          return (
            <line key={`g${i}`}
              x1={0} y1={g.y} x2={mapW} y2={g.y}
              stroke={g.isEquator ? '#162d4a' : '#0d1f35'}
              strokeWidth={g.isEquator ? '0.8' : '0.4'}
              strokeDasharray={g.isEquator ? '3,2' : undefined}
            />
          );
        })}

        {/* Graticule labels */}
        {graticuleLines.filter(g => g.type === 'h').map((g, i) => (
          <text key={`gl${i}`}
            x={4} y={g.y - 2}
            fill="#1e3a5f" fontSize="6" fontFamily="JetBrains Mono, monospace"
          >
            {Math.abs(g.pos)}°{g.pos >= 0 ? 'N' : 'S'}
          </text>
        ))}
        {graticuleLines.filter(g => g.type === 'v').map((g, i) => (
          <text key={`gL${i}`}
            x={g.x + 2} y={mapH - 4}
            fill="#1e3a5f" fontSize="6" fontFamily="JetBrains Mono, monospace"
          >
            {Math.abs(g.pos)}°{g.pos >= 0 ? 'E' : 'W'}
          </text>
        ))}

        {/* Land */}
        {landPaths ? (
          <path d={landPaths} fill="#122240" stroke="#1e3a5f" strokeWidth="0.4" fillRule="evenodd" />
        ) : loading ? (
          <text x={mapW / 2} y={mapH / 2} textAnchor="middle" fill="#1e3a5f" fontSize="10"
            fontFamily="JetBrains Mono, monospace">
            Loading Overture Maps…
          </text>
        ) : null}

        {/* Water bodies */}
        {waterPaths && (
          <path d={waterPaths} fill="#0a1628" stroke="#1e3a5f" strokeWidth="0.3" fillRule="evenodd" opacity="0.7" />
        )}

        {/* Scene footprint */}
        {footprint && (
          <>
            {/* Outer glow */}
            <rect
              x={footprint.x - 2} y={footprint.y - 2}
              width={footprint.w + 4} height={footprint.h + 4}
              fill="none" stroke="rgba(78, 201, 212, 0.2)" strokeWidth="3" rx="2"
            />
            {/* Fill */}
            <rect
              x={footprint.x} y={footprint.y}
              width={footprint.w} height={footprint.h}
              fill="rgba(78, 201, 212, 0.2)" stroke="#4ec9d4" strokeWidth="1.5" rx="1"
            />
            {/* Center crosshair */}
            <line
              x1={footprint.x + footprint.w / 2 - 6} y1={footprint.y + footprint.h / 2}
              x2={footprint.x + footprint.w / 2 + 6} y2={footprint.y + footprint.h / 2}
              stroke="#4ec9d4" strokeWidth="0.8"
            />
            <line
              x1={footprint.x + footprint.w / 2} y1={footprint.y + footprint.h / 2 - 6}
              x2={footprint.x + footprint.w / 2} y2={footprint.y + footprint.h / 2 + 6}
              stroke="#4ec9d4" strokeWidth="0.8"
            />
            {/* Label */}
            {wgs84Bounds && (
              <text
                x={footprint.x + footprint.w / 2}
                y={footprint.y - 4}
                textAnchor="middle"
                fill="#4ec9d4" fontSize="7" fontFamily="JetBrains Mono, monospace"
                fontWeight="600"
              >
                Scene
              </text>
            )}
          </>
        )}

        {/* Center crosshair (when zoomed) */}
        {zoomIdx > 0 && (
          <>
            <line x1={mapW / 2 - 5} y1={mapH / 2} x2={mapW / 2 + 5} y2={mapH / 2}
              stroke="#1e3a5f" strokeWidth="0.5" />
            <line x1={mapW / 2} y1={mapH / 2 - 5} x2={mapW / 2} y2={mapH / 2 + 5}
              stroke="#1e3a5f" strokeWidth="0.5" />
          </>
        )}

        {/* Attribution */}
        <text x={mapW - 4} y={12} textAnchor="end" fill="#1e3a5f" fontSize="6"
          fontFamily="JetBrains Mono, monospace">
          Overture Maps
        </text>
      </svg>

      {/* Status bar */}
      <div className="overview-map-status">
        <span>
          {center[0].toFixed(1)}°{center[0] >= 0 ? 'E' : 'W'}, {center[1].toFixed(1)}°{center[1] >= 0 ? 'N' : 'S'}
        </span>
        <span>
          {lonSpan.toFixed(0)}° × {latSpan.toFixed(0)}°
        </span>
        {wgs84Bounds && (
          <span style={{ color: 'var(--sardine-cyan)' }}>
            Scene: {wgs84Bounds.minLat.toFixed(1)}°–{wgs84Bounds.maxLat.toFixed(1)}°N
          </span>
        )}
      </div>
    </div>
  );
}

export default OverviewMap;
