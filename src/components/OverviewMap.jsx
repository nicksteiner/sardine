import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { fetchWorldCoastlines, fetchOvertureTile, fetchSceneContext } from '../loaders/overture-loader.js';

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
  const [sceneContext, setSceneContext] = useState(null); // { roads, borders, places }
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef(null);
  const centerAtDragStartRef = useRef(null);
  const fetchedZoomRef = useRef(-1);
  const svgRef = useRef(null);

  const mapW = 400;
  const mapH = 240;

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

  // Fetch scene context layers (roads, borders) when scene footprint is available
  useEffect(() => {
    if (!visible || !wgs84Bounds) {
      setSceneContext(null);
      return;
    }
    // Pad the bbox slightly so context extends beyond the footprint
    const pad = Math.max(
      (wgs84Bounds.maxLon - wgs84Bounds.minLon) * 0.5,
      (wgs84Bounds.maxLat - wgs84Bounds.minLat) * 0.5
    );
    const paddedBounds = {
      minLon: wgs84Bounds.minLon - pad,
      minLat: Math.max(-85, wgs84Bounds.minLat - pad),
      maxLon: wgs84Bounds.maxLon + pad,
      maxLat: Math.min(85, wgs84Bounds.maxLat + pad),
    };

    // Fetch transportation and divisions — catch each independently
    const contextResult = { roads: [], borders: [] };
    const fetches = [];

    fetches.push(
      fetchSceneContext(paddedBounds, { themes: ['transportation'] })
        .then(result => {
          if (result.transportation?.layers) {
            for (const features of Object.values(result.transportation.layers)) {
              // At overview zoom, include all road segments (already filtered by tile zoom)
              contextResult.roads.push(...features);
            }
          }
          console.log(`[OverviewMap] Roads: ${contextResult.roads.length} features`);
        })
        .catch(err => console.warn('[OverviewMap] Transportation fetch failed:', err.message))
    );

    fetches.push(
      fetchSceneContext(paddedBounds, { themes: ['divisions'] })
        .then(result => {
          if (result.divisions?.layers) {
            for (const features of Object.values(result.divisions.layers)) {
              contextResult.borders.push(...features);
            }
          }
          console.log(`[OverviewMap] Borders: ${contextResult.borders.length} features`);
        })
        .catch(err => console.warn('[OverviewMap] Divisions fetch failed:', err.message))
    );

    Promise.all(fetches).then(() => {
      setSceneContext(contextResult);
    });
  }, [visible, wgs84Bounds]);

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

  // Context layer paths (roads, borders)
  const roadPaths = useMemo(() => {
    if (!sceneContext?.roads?.length) return '';
    return sceneContext.roads.map(f => geoToSVGPath(f.geometry, lonToX, latToY)).filter(Boolean).join(' ');
  }, [sceneContext, lonToX, latToY]);

  const borderPaths = useMemo(() => {
    if (!sceneContext?.borders?.length) return '';
    return sceneContext.borders.map(f => geoToSVGPath(f.geometry, lonToX, latToY)).filter(Boolean).join(' ');
  }, [sceneContext, lonToX, latToY]);

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
    // Adaptive spacing based on zoom
    const niceSpacings = [60, 30, 15, 10, 5, 2, 1];
    const targetLines = 6;
    const approxSpacing = lonSpan / targetLines;
    let spacing = niceSpacings.find(s => s <= approxSpacing) || 1;

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

  // Format coordinate for display
  const fmtCoord = (v, axis) => {
    const abs = Math.abs(v);
    const suffix = axis === 'lon' ? (v >= 0 ? 'E' : 'W') : (v >= 0 ? 'N' : 'S');
    return abs < 1 ? `${abs.toFixed(2)}°${suffix}` :
           abs < 10 ? `${abs.toFixed(1)}°${suffix}` :
           `${Math.round(abs)}°${suffix}`;
  };

  // ── SVG export (black wireframe for presentations) ──
  function handleExportSVG() {
    const margin = 12;
    const totalW = mapW + margin * 2;
    const totalH = mapH + margin * 2 + 16; // extra for bottom label

    // Build graticule paths
    const gratLines = graticuleLines.map(g => {
      if (g.type === 'v') return `<line x1="${(g.x + margin).toFixed(1)}" y1="${margin}" x2="${(g.x + margin).toFixed(1)}" y2="${mapH + margin}" stroke="#ccc" stroke-width="0.3"/>`;
      return `<line x1="${margin}" y1="${(g.y + margin).toFixed(1)}" x2="${mapW + margin}" y2="${(g.y + margin).toFixed(1)}" stroke="#ccc" stroke-width="0.3"/>`;
    }).join('\n    ');

    // Graticule labels
    const gratLabels = [
      ...graticuleLines.filter(g => g.type === 'h' && g.y > 10 && g.y < mapH - 6).map(g =>
        `<text x="${margin - 2}" y="${(g.y + margin - 1).toFixed(1)}" text-anchor="end" font-size="7" fill="#666">${fmtCoord(g.pos, 'lat')}</text>`
      ),
      ...graticuleLines.filter(g => g.type === 'v' && g.x > 20 && g.x < mapW - 20).map(g =>
        `<text x="${(g.x + margin).toFixed(1)}" y="${mapH + margin + 10}" text-anchor="middle" font-size="7" fill="#666">${fmtCoord(g.pos, 'lon')}</text>`
      ),
    ].join('\n    ');

    // Scene footprint
    let fpSVG = '';
    if (footprint) {
      const fx = footprint.x + margin;
      const fy = footprint.y + margin;
      fpSVG = `
    <rect x="${fx.toFixed(1)}" y="${fy.toFixed(1)}" width="${footprint.w.toFixed(1)}" height="${footprint.h.toFixed(1)}"
      fill="none" stroke="#000" stroke-width="1.5"/>`;
      // Corner ticks
      const corners = [
        [fx, fy], [fx + footprint.w, fy],
        [fx, fy + footprint.h], [fx + footprint.w, fy + footprint.h],
      ];
      corners.forEach(([cx, cy], ci) => {
        const dx = ci % 2 === 0 ? 1 : -1;
        const dy = ci < 2 ? 1 : -1;
        fpSVG += `\n    <line x1="${cx}" y1="${cy}" x2="${cx + dx * 6}" y2="${cy}" stroke="#000" stroke-width="1.2"/>`;
        fpSVG += `\n    <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy + dy * 6}" stroke="#000" stroke-width="1.2"/>`;
      });
      // Label
      if (wgs84Bounds) {
        const ly = fy > 24 ? fy - 5 : fy + footprint.h + 11;
        fpSVG += `\n    <text x="${(fx + footprint.w / 2).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="7" font-weight="600" fill="#000">${fmtCoord(wgs84Bounds.minLat, 'lat')}\u2013${fmtCoord(wgs84Bounds.maxLat, 'lat')}, ${fmtCoord(wgs84Bounds.minLon, 'lon')}\u2013${fmtCoord(wgs84Bounds.maxLon, 'lon')}</text>`;
      }
    }

    // Offset all paths by margin
    const offsetPath = (d) => {
      if (!d) return '';
      // Shift M/L coordinates by margin
      return d.replace(/([ML])(-?[\d.]+),(-?[\d.]+)/g, (_, cmd, x, y) =>
        `${cmd}${(parseFloat(x) + margin).toFixed(1)},${(parseFloat(y) + margin).toFixed(1)}`
      );
    };

    const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" width="${totalW * 2}" height="${totalH * 2}"
  font-family="'Helvetica Neue', Helvetica, Arial, sans-serif">
  <!-- Background -->
  <rect x="0" y="0" width="${totalW}" height="${totalH}" fill="white"/>
  <rect x="${margin}" y="${margin}" width="${mapW}" height="${mapH}" fill="white" stroke="#000" stroke-width="0.5"/>

  <!-- Graticule -->
  <g>
    ${gratLines}
  </g>

  <!-- Land -->
  ${landPaths ? `<path d="${offsetPath(landPaths)}" fill="#eee" stroke="#333" stroke-width="0.5" stroke-linejoin="round" fill-rule="evenodd"/>` : ''}

  <!-- Water -->
  ${waterPaths ? `<path d="${offsetPath(waterPaths)}" fill="white" stroke="#999" stroke-width="0.3" stroke-linejoin="round" fill-rule="evenodd"/>` : ''}

  <!-- Borders -->
  ${borderPaths ? `<path d="${offsetPath(borderPaths)}" fill="none" stroke="#666" stroke-width="0.5" stroke-dasharray="3,2" stroke-linejoin="round"/>` : ''}

  <!-- Roads -->
  ${roadPaths ? `<path d="${offsetPath(roadPaths)}" fill="none" stroke="#999" stroke-width="0.3" stroke-linejoin="round" stroke-linecap="round"/>` : ''}

  <!-- Labels -->
  <g>
    ${gratLabels}
  </g>

  <!-- Scene footprint -->
  ${fpSVG}
</svg>`;

    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'overview-map.svg';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Render ──

  if (!visible) {
    // Collapsed globe button only
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
    <div className="overview-map">
      {/* Title bar */}
      <div className="overview-map-header">
        <span className="overview-map-title">
          Overview
          {loading && <span className="overview-map-loading" />}
        </span>
        <div className="overview-map-controls">
          <button className="overview-map-btn" onClick={handleExportSVG} title="Export SVG">
            <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M2 10v2h10v-2M7 2v7M4 6l3 3 3-3"/>
            </svg>
          </button>
          <button className="overview-map-btn" onClick={handleResetView} title="Reset view">R</button>
          <button className="overview-map-btn" onClick={handleZoomOut} title="Zoom out" disabled={zoomIdx === 0}>&minus;</button>
          <span className="overview-map-zoom-label">{zoom.label}</span>
          <button className="overview-map-btn" onClick={handleZoomIn} title="Zoom in" disabled={zoomIdx === ZOOM_LEVELS.length - 1}>+</button>
          <button className="overview-map-btn overview-map-close" onClick={onToggle} title="Close">&times;</button>
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
        <defs>
          {/* Glow filter for scene footprint */}
          <filter id="footprint-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* Label background */}
          <filter id="label-bg" x="-4" y="-2" width="calc(100% + 8)" height="calc(100% + 4)">
            <feFlood floodColor="#0a1628" floodOpacity="0.85" result="bg" />
            <feMerge><feMergeNode in="bg" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Ocean background */}
        <rect x={0} y={0} width={mapW} height={mapH} fill="#070d19" />

        {/* Graticule — fine lines */}
        {graticuleLines.map((g, i) => {
          const isSpecial = g.isPrime || g.isEquator;
          if (g.type === 'v') {
            return (
              <line key={`g${i}`}
                x1={g.x} y1={0} x2={g.x} y2={mapH}
                stroke={isSpecial ? 'rgba(78, 201, 212, 0.12)' : 'rgba(30, 58, 95, 0.35)'}
                strokeWidth={isSpecial ? '0.7' : '0.3'}
              />
            );
          }
          return (
            <line key={`g${i}`}
              x1={0} y1={g.y} x2={mapW} y2={g.y}
              stroke={isSpecial ? 'rgba(78, 201, 212, 0.12)' : 'rgba(30, 58, 95, 0.35)'}
              strokeWidth={isSpecial ? '0.7' : '0.3'}
            />
          );
        })}

        {/* Land mass */}
        {landPaths ? (
          <path d={landPaths} fill="#14253f" stroke="#2a4a70" strokeWidth="0.5" strokeLinejoin="round" fillRule="evenodd" />
        ) : loading ? (
          <text x={mapW / 2} y={mapH / 2} textAnchor="middle" fill="#2a4a70" fontSize="9"
            fontFamily="'JetBrains Mono', monospace" letterSpacing="1">
            Loading coastlines…
          </text>
        ) : null}

        {/* Water bodies (lakes, inland seas) */}
        {waterPaths && (
          <path d={waterPaths} fill="#070d19" stroke="#1a3050" strokeWidth="0.3" strokeLinejoin="round" fillRule="evenodd" />
        )}

        {/* Administrative borders */}
        {borderPaths && (
          <path d={borderPaths} fill="none" stroke="#2e5580" strokeWidth="0.6" strokeLinejoin="round"
            strokeDasharray="3,2" opacity="0.6" />
        )}

        {/* Road network */}
        {roadPaths && (
          <path d={roadPaths} fill="none" stroke="#3a5570" strokeWidth="0.4" strokeLinejoin="round"
            strokeLinecap="round" opacity="0.5" />
        )}

        {/* Graticule labels — latitude (left edge) */}
        {graticuleLines.filter(g => g.type === 'h').map((g, i) => {
          const yPos = g.y;
          if (yPos < 10 || yPos > mapH - 6) return null;
          return (
            <text key={`gl${i}`}
              x={3} y={yPos - 2}
              fill="#3a6090" fontSize="6.5"
              fontFamily="'JetBrains Mono', monospace"
              fontWeight="500"
            >
              {fmtCoord(g.pos, 'lat')}
            </text>
          );
        })}
        {/* Graticule labels — longitude (bottom edge) */}
        {graticuleLines.filter(g => g.type === 'v').map((g, i) => {
          const xPos = g.x;
          if (xPos < 20 || xPos > mapW - 20) return null;
          return (
            <text key={`gL${i}`}
              x={xPos} y={mapH - 4}
              textAnchor="middle"
              fill="#3a6090" fontSize="6.5"
              fontFamily="'JetBrains Mono', monospace"
              fontWeight="500"
            >
              {fmtCoord(g.pos, 'lon')}
            </text>
          );
        })}

        {/* Scene footprint */}
        {footprint && (
          <>
            {/* Soft glow halo */}
            <rect
              x={footprint.x - 1} y={footprint.y - 1}
              width={footprint.w + 2} height={footprint.h + 2}
              fill="none" stroke="rgba(78, 201, 212, 0.35)" strokeWidth="4"
              rx="2" filter="url(#footprint-glow)"
            />
            {/* Scene fill — semi-transparent with crisp border */}
            <rect
              x={footprint.x} y={footprint.y}
              width={footprint.w} height={footprint.h}
              fill="rgba(78, 201, 212, 0.12)" stroke="#4ec9d4" strokeWidth="1.2" rx="1"
            />
            {/* Corner ticks for precision */}
            {[
              [footprint.x, footprint.y],
              [footprint.x + footprint.w, footprint.y],
              [footprint.x, footprint.y + footprint.h],
              [footprint.x + footprint.w, footprint.y + footprint.h],
            ].map(([cx, cy], ci) => {
              const dx = ci % 2 === 0 ? 1 : -1;
              const dy = ci < 2 ? 1 : -1;
              return (
                <g key={`ct${ci}`}>
                  <line x1={cx} y1={cy} x2={cx + dx * 5} y2={cy} stroke="#4ec9d4" strokeWidth="1.2" />
                  <line x1={cx} y1={cy} x2={cx} y2={cy + dy * 5} stroke="#4ec9d4" strokeWidth="1.2" />
                </g>
              );
            })}
            {/* Label with lat/lon extent */}
            {wgs84Bounds && (() => {
              const labelY = footprint.y > 24 ? footprint.y - 6 : footprint.y + footprint.h + 12;
              const labelText = `${fmtCoord(wgs84Bounds.minLat, 'lat')}–${fmtCoord(wgs84Bounds.maxLat, 'lat')}, ${fmtCoord(wgs84Bounds.minLon, 'lon')}–${fmtCoord(wgs84Bounds.maxLon, 'lon')}`;
              return (
                <g>
                  {/* Background pill */}
                  <rect
                    x={footprint.x + footprint.w / 2 - labelText.length * 2.3}
                    y={labelY - 7}
                    width={labelText.length * 4.6}
                    height={10}
                    rx="3"
                    fill="rgba(10, 22, 40, 0.88)"
                    stroke="rgba(78, 201, 212, 0.3)"
                    strokeWidth="0.5"
                  />
                  <text
                    x={footprint.x + footprint.w / 2}
                    y={labelY}
                    textAnchor="middle"
                    fill="#4ec9d4" fontSize="6.5"
                    fontFamily="'JetBrains Mono', monospace"
                    fontWeight="600"
                    letterSpacing="0.3"
                  >
                    {labelText}
                  </text>
                </g>
              );
            })()}
          </>
        )}

        {/* Center crosshair (when zoomed) */}
        {zoomIdx > 0 && (
          <g opacity="0.3">
            <line x1={mapW / 2 - 6} y1={mapH / 2} x2={mapW / 2 + 6} y2={mapH / 2}
              stroke="#4ec9d4" strokeWidth="0.5" />
            <line x1={mapW / 2} y1={mapH / 2 - 6} x2={mapW / 2} y2={mapH / 2 + 6}
              stroke="#4ec9d4" strokeWidth="0.5" />
          </g>
        )}

        {/* Attribution — subtle bottom-right */}
        <text x={mapW - 5} y={12} textAnchor="end" fill="#1e3a5f" fontSize="5.5"
          fontFamily="'JetBrains Mono', monospace" opacity="0.6" letterSpacing="0.5">
          Overture Maps
        </text>
      </svg>

      {/* Status bar */}
      <div className="overview-map-status">
        <span>
          {fmtCoord(center[1], 'lat')}, {fmtCoord(center[0], 'lon')}
        </span>
        {wgs84Bounds && (
          <span style={{ color: 'var(--sardine-cyan)' }}>
            {fmtCoord(wgs84Bounds.minLat, 'lat')}–{fmtCoord(wgs84Bounds.maxLat, 'lat')}
          </span>
        )}
      </div>
    </div>
  );
}

export default OverviewMap;
