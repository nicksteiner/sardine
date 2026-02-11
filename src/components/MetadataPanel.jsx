import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { fetchWorldCoastlines } from '../loaders/overture-loader.js';

/**
 * MetadataPanel — Collapsible panel showing NISAR product metadata
 * and a global overview mini-map with the scene footprint.
 *
 * The mini-map renders real coastline geometry sourced from
 * Overture Maps Foundation PMTiles (base/land theme).
 *
 * Displays:
 *   - Product identification (orbit, track, frame, look direction, times)
 *   - Spatial info (CRS, bounds, pixel spacing, dimensions)
 *   - Metadata cube summary (available fields, incidence angle range)
 *   - Mini world map with scene footprint highlighted
 */

/**
 * Convert UTM bounds to approximate WGS84 lat/lon.
 * Lightweight approximation for footprint display — no proj4 dependency.
 *
 * @param {number[]} bounds - [minX, minY, maxX, maxY] in projected CRS
 * @param {string} crs - e.g. "EPSG:32610"
 * @returns {{ minLon, minLat, maxLon, maxLat }|null}
 */
function boundsToWGS84(bounds, crs) {
  if (!bounds || !crs) return null;
  const [minX, minY, maxX, maxY] = bounds;

  const epsgMatch = crs.match(/EPSG:(\d+)/);
  if (!epsgMatch) return null;
  const epsg = parseInt(epsgMatch[1]);

  // Already WGS84
  if (epsg === 4326) {
    return { minLon: minX, minLat: minY, maxLon: maxX, maxLat: maxY };
  }

  // UTM North (326xx)
  if (epsg >= 32601 && epsg <= 32660) {
    const zone = epsg - 32600;
    return utmBoundsToLatLon(bounds, zone, true);
  }
  // UTM South (327xx)
  if (epsg >= 32701 && epsg <= 32760) {
    const zone = epsg - 32700;
    return utmBoundsToLatLon(bounds, zone, false);
  }

  // Polar stereographic — rough approximation
  if (epsg === 3031 || epsg === 3413) {
    return null; // Skip mini-map for polar projections
  }

  return null;
}

function utmBoundsToLatLon(bounds, zone, isNorth) {
  const [minX, minY, maxX, maxY] = bounds;
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const k0 = 0.9996;
  const a = 6378137;

  function toLatLon(easting, northing) {
    const x = (easting - 500000) / k0;
    const y = isNorth ? northing / k0 : (northing - 10000000) / k0;
    const lat = (y / a) * (180 / Math.PI);
    const lon = lon0 + (x / (a * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
    return { lat, lon };
  }

  const sw = toLatLon(minX, minY);
  const ne = toLatLon(maxX, maxY);
  return {
    minLon: Math.min(sw.lon, ne.lon),
    minLat: Math.min(sw.lat, ne.lat),
    maxLon: Math.max(sw.lon, ne.lon),
    maxLat: Math.max(sw.lat, ne.lat),
  };
}


/**
 * MiniMap — SVG world overview showing the scene footprint.
 * Uses equirectangular projection (lon → x, lat → y).
 *
 * On first render, fetches real coastline geometry from Overture Maps
 * PMTiles (base theme at zoom 1). Falls back to a loading state
 * until tiles arrive.
 */
function MiniMap({ wgs84Bounds, style }) {
  const svgW = 200;
  const svgH = 100;

  const [coastlines, setCoastlines] = useState(null);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);

  // Fetch Overture coastlines once
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);

    fetchWorldCoastlines({ zoom: 1 })
      .then(data => {
        setCoastlines(data);
        setLoading(false);
      })
      .catch(err => {
        console.warn('[MiniMap] Failed to load Overture coastlines:', err.message);
        setLoading(false);
      });
  }, []);

  // Equirectangular: lon [-180, 180] → [0, svgW], lat [90, -90] → [0, svgH]
  function lonToX(lon) { return ((lon + 180) / 360) * svgW; }
  function latToY(lat) { return ((90 - lat) / 180) * svgH; }

  /**
   * Convert a GeoJSON geometry to SVG path string(s).
   */
  const geoToSVGPath = useCallback((geometry) => {
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
  }, []);

  // Build SVG paths from Overture features
  const landPaths = useMemo(() => {
    if (!coastlines?.land) return '';
    return coastlines.land.map(f => geoToSVGPath(f.geometry)).filter(Boolean).join(' ');
  }, [coastlines, geoToSVGPath]);

  const waterPaths = useMemo(() => {
    if (!coastlines?.water) return '';
    return coastlines.water.map(f => geoToSVGPath(f.geometry)).filter(Boolean).join(' ');
  }, [coastlines, geoToSVGPath]);

  let footprint = null;
  if (wgs84Bounds) {
    const x1 = lonToX(wgs84Bounds.minLon);
    const y1 = latToY(wgs84Bounds.maxLat);
    const x2 = lonToX(wgs84Bounds.maxLon);
    const y2 = latToY(wgs84Bounds.minLat);
    const w = Math.max(2, x2 - x1); // min 2px so it's visible
    const h = Math.max(2, y2 - y1);
    footprint = { x: x1, y: y1, w, h };
  }

  return (
    <svg
      viewBox={`0 0 ${svgW} ${svgH}`}
      width={svgW}
      height={svgH}
      style={{
        background: '#060e1a',
        borderRadius: '4px',
        border: '1px solid var(--sardine-border, #1e3a5f)',
        ...style,
      }}
    >
      {/* Graticule (30° grid) */}
      {[...Array(11)].map((_, i) => {
        const x = (i / 12) * svgW + svgW / 12;
        return <line key={`gv${i}`} x1={x} y1={0} x2={x} y2={svgH} stroke="#0d1f35" strokeWidth="0.5" />;
      })}
      {[...Array(5)].map((_, i) => {
        const y = (i / 6) * svgH + svgH / 6;
        return <line key={`gh${i}`} x1={0} y1={y} x2={svgW} y2={y} stroke="#0d1f35" strokeWidth="0.5" />;
      })}

      {/* Equator */}
      <line x1={0} y1={svgH / 2} x2={svgW} y2={svgH / 2} stroke="#162d4a" strokeWidth="0.5" strokeDasharray="2,2" />

      {/* Overture landmasses */}
      {landPaths ? (
        <path d={landPaths} fill="#122240" stroke="#1e3a5f" strokeWidth="0.3" fillRule="evenodd" />
      ) : (
        /* Loading placeholder — subtle pulsing text */
        <text x={svgW / 2} y={svgH / 2} textAnchor="middle" fill="#1e3a5f" fontSize="7" fontFamily="JetBrains Mono, monospace">
          {loading ? '⟳ loading coastlines…' : ''}
        </text>
      )}

      {/* Overture water bodies */}
      {waterPaths && (
        <path d={waterPaths} fill="#0a1628" stroke="#1e3a5f" strokeWidth="0.2" fillRule="evenodd" opacity="0.7" />
      )}

      {/* Scene footprint */}
      {footprint && (
        <>
          {/* Glow */}
          <rect
            x={footprint.x - 1} y={footprint.y - 1}
            width={footprint.w + 2} height={footprint.h + 2}
            fill="none" stroke="rgba(78, 201, 212, 0.3)" strokeWidth="2"
            rx="1"
          />
          {/* Footprint */}
          <rect
            x={footprint.x} y={footprint.y}
            width={footprint.w} height={footprint.h}
            fill="rgba(78, 201, 212, 0.25)" stroke="#4ec9d4" strokeWidth="1"
            rx="1"
          />
          {/* Center dot */}
          <circle
            cx={footprint.x + footprint.w / 2}
            cy={footprint.y + footprint.h / 2}
            r="2"
            fill="#4ec9d4"
          />
        </>
      )}

      {/* Coordinate label */}
      {wgs84Bounds && (
        <text
          x={3} y={svgH - 3}
          fill="#5a7099" fontSize="6" fontFamily="JetBrains Mono, monospace"
        >
          {wgs84Bounds.minLat.toFixed(1)}°{wgs84Bounds.minLat >= 0 ? 'N' : 'S'},{' '}
          {wgs84Bounds.minLon.toFixed(1)}°{wgs84Bounds.minLon >= 0 ? 'E' : 'W'}
        </text>
      )}

      {/* Overture attribution */}
      <text
        x={svgW - 3} y={svgH - 3}
        textAnchor="end" fill="#1e3a5f" fontSize="4" fontFamily="JetBrains Mono, monospace"
      >
        Overture Maps
      </text>
    </svg>
  );
}

/**
 * Format a NISAR zero-Doppler time string for display.
 * Input: "2025-12-26T10:44:04.123456" → "2025-12-26 10:44:04 UTC"
 */
function formatTime(timeStr) {
  if (!timeStr) return '—';
  return timeStr.replace('T', ' ').replace(/\.\d+$/, '') + ' UTC';
}

/**
 * Format bytes → human readable
 */
function formatDimensions(w, h) {
  const mpx = ((w * h) / 1e6).toFixed(1);
  return `${w.toLocaleString()} × ${h.toLocaleString()} (${mpx} Mpx)`;
}


/**
 * MetadataRow — Single key/value row in the metadata table.
 */
function MetadataRow({ label, value, accent = false, mono = true }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="metadata-row">
      <span className="metadata-label">{label}</span>
      <span
        className={`metadata-value ${accent ? 'accent' : ''}`}
        style={mono ? { fontFamily: 'var(--font-mono)' } : undefined}
      >
        {value}
      </span>
    </div>
  );
}


/**
 * CollapsibleSection — Sub-section with toggle expand/collapse.
 */
function CollapsibleSection({ title, defaultOpen = false, children, count }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="metadata-section">
      <div
        className="metadata-section-title"
        onClick={() => setOpen(o => !o)}
        style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>{open ? '▾' : '▸'} {title}</span>
        {count != null && (
          <span style={{ fontSize: '0.55rem', color: 'var(--text-disabled)', fontFamily: 'var(--font-mono)' }}>{count}</span>
        )}
      </div>
      {open && children}
    </div>
  );
}

/**
 * Format a boolean-like identification value for display.
 */
function formatBool(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return 'True';
    if (s === 'false') return 'False';
  }
  return String(v);
}

/**
 * MetadataPanel — Main component.
 *
 * Displays the full GCOV product metadata per JPL D-102274 Rev E §5.
 * Organized into collapsible sections: Product Identification, Spatial,
 * Data, Processing, Radar Grid Cube, and File.
 *
 * @param {Object} props
 * @param {Object|null} props.imageData — The loaded NISAR/COG data object
 * @param {string} props.fileType — 'nisar' | 'cog'
 * @param {string|null} props.fileName — Name of loaded file
 */
export function MetadataPanel({ imageData, fileType, fileName }) {
  const [collapsed, setCollapsed] = useState(false);

  // Compute WGS84 footprint for mini-map
  const wgs84Bounds = useMemo(() => {
    if (!imageData) return null;
    const bounds = imageData.worldBounds || imageData.bounds;
    const crs = imageData.crs || 'EPSG:4326';
    return boundsToWGS84(bounds, crs);
  }, [imageData]);

  // Extract identification metadata
  const id = imageData?.identification || {};

  // Metadata cube summary
  const cubeSummary = useMemo(() => {
    const cube = imageData?.metadataCube;
    if (!cube) return null;
    const bounds = cube.getBounds();
    const fields = cube.getFieldNames();

    // Sample incidence angle range from the cube's first height layer
    let incMin = Infinity, incMax = -Infinity;
    const incField = cube.fields?.incidenceAngle;
    if (incField) {
      const layerSize = cube.nx * cube.ny;
      for (let i = 0; i < layerSize; i++) {
        const v = incField[i];
        if (!isNaN(v) && v > 0) {
          if (v < incMin) incMin = v;
          if (v > incMax) incMax = v;
        }
      }
    }

    return {
      fields,
      shape: bounds.shape,
      incRange: incMin < Infinity ? [incMin, incMax] : null,
      heightRange: bounds.height,
    };
  }, [imageData?.metadataCube]);

  // Count how many identification fields we actually have
  const idFieldCount = Object.keys(id).length;

  if (!imageData) return null;

  const bounds = imageData.worldBounds || imageData.bounds;
  const spacing = imageData.pixelSpacing;

  // Separate processing fields from identification fields
  const processingKeys = [
    'isFullCovariance', 'polSymApplied', 'rtcApplied', 'rfiApplied',
    'ionoRangeApplied', 'ionoAzApplied', 'dryTropoApplied', 'wetTropoApplied',
    'softwareVersion', 'backscatterConvention', 'orbitType',
  ];
  const hasProcessing = processingKeys.some(k => id[k] !== undefined);

  return (
    <div className={`metadata-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="metadata-panel-header" onClick={() => setCollapsed(c => !c)}>
        <span className="metadata-panel-title">
          <span style={{ color: 'var(--sardine-cyan)' }}>◈</span> Metadata
        </span>
        <span className="metadata-panel-toggle">{collapsed ? '◀' : '▶'}</span>
      </div>

      {!collapsed && (
        <div className="metadata-panel-body">
          {/* Mini Map */}
          <div className="metadata-section">
            <MiniMap wgs84Bounds={wgs84Bounds} style={{ width: '100%', height: 'auto' }} />
          </div>

          {/* ── Product Identification (§5.2, Table 5-2) ── */}
          {fileType === 'nisar' && idFieldCount > 0 && (
            <CollapsibleSection title="Product Identification" defaultOpen={true} count={`§5.2`}>
              <MetadataRow label="Product Type" value={id.productType} accent />
              <MetadataRow label="Product Level" value={id.productLevel} />
              <MetadataRow label="Granule ID" value={id.granuleId} />
              <MetadataRow label="Mission" value={id.missionId} />
              <MetadataRow label="Platform" value={id.platformName} />
              <MetadataRow label="Instrument" value={id.instrumentName} />
              <MetadataRow label="Radar Band" value={id.radarBand} />
              <MetadataRow label="Orbit" value={id.absoluteOrbitNumber} />
              <MetadataRow label="Track / Frame" value={
                id.trackNumber != null && id.frameNumber != null
                  ? `${id.trackNumber} / ${id.frameNumber}`
                  : id.trackNumber ?? id.frameNumber
              } />
              <MetadataRow label="Look Direction" value={id.lookDirection} />
              <MetadataRow label="Pass Direction" value={id.orbitPassDirection} />
              <MetadataRow label="Start Time" value={formatTime(id.zeroDopplerStartTime)} />
              <MetadataRow label="End Time" value={formatTime(id.zeroDopplerEndTime)} />
              <MetadataRow label="Processing Time" value={formatTime(id.processingDateTime)} />
              <MetadataRow label="Processing Center" value={id.processingCenter} />
              <MetadataRow label="Processing Type" value={id.processingType} />
              <MetadataRow label="Product Version" value={id.productVersion} />
              <MetadataRow label="Spec Version" value={id.productSpecificationVersion} />
              <MetadataRow label="CRID" value={id.compositeReleaseId} />
              <MetadataRow label="DOI" value={id.productDoi} />
              <MetadataRow label="Geocoded" value={formatBool(id.isGeocoded)} />
              <MetadataRow label="Urgent" value={formatBool(id.isUrgentObservation)} />
              <MetadataRow label="Dithered" value={formatBool(id.isDithered)} />
              <MetadataRow label="Mixed Mode" value={formatBool(id.isMixedMode)} />
              <MetadataRow label="Full Frame" value={formatBool(id.isFullFrame)} />
              <MetadataRow label="Joint Obs." value={formatBool(id.isJointObservation)} />
              <MetadataRow label="Diag. Mode" value={id.diagnosticModeFlag} />
              {id.boundingPolygon && (
                <div style={{
                  marginTop: '4px',
                  fontSize: '0.55rem',
                  color: 'var(--text-disabled)',
                  wordBreak: 'break-all',
                  fontFamily: 'var(--font-mono)',
                  lineHeight: 1.4,
                  maxHeight: '60px',
                  overflowY: 'auto',
                }}>
                  <span style={{ color: 'var(--text-muted)' }}>Bounding Polygon:</span><br />
                  {id.boundingPolygon}
                </div>
              )}
            </CollapsibleSection>
          )}

          {/* ── Spatial Info ── */}
          <CollapsibleSection title="Spatial" defaultOpen={true} count={imageData.crs}>
            <MetadataRow label="CRS" value={imageData.crs} accent />
            <MetadataRow label="Size" value={formatDimensions(imageData.width, imageData.height)} />
            {spacing && (
              <MetadataRow label="Pixel Spacing" value={`${spacing.x.toFixed(1)} × ${spacing.y.toFixed(1)} m`} />
            )}
            {bounds && (
              <>
                <MetadataRow label="Easting" value={`${bounds[0].toFixed(0)} – ${bounds[2].toFixed(0)} m`} />
                <MetadataRow label="Northing" value={`${bounds[1].toFixed(0)} – ${bounds[3].toFixed(0)} m`} />
              </>
            )}
            {wgs84Bounds && (
              <>
                <MetadataRow label="Lat" value={
                  `${wgs84Bounds.minLat.toFixed(3)}° – ${wgs84Bounds.maxLat.toFixed(3)}°`
                } />
                <MetadataRow label="Lon" value={
                  `${wgs84Bounds.minLon.toFixed(3)}° – ${wgs84Bounds.maxLon.toFixed(3)}°`
                } />
              </>
            )}
          </CollapsibleSection>

          {/* ── Product Identification ── */}
          {Object.keys(id).length > 0 && (
            <CollapsibleSection title="Product ID" defaultOpen={false} count={Object.keys(id).length}>
              {id.productType && <MetadataRow label="Product Type" value={id.productType} accent />}
              {id.missionId && <MetadataRow label="Mission" value={id.missionId} />}
              {id.granuleId && <MetadataRow label="Granule ID" value={id.granuleId} />}
              {id.absoluteOrbitNumber != null && <MetadataRow label="Orbit" value={id.absoluteOrbitNumber} />}
              {id.trackNumber != null && <MetadataRow label="Track" value={id.trackNumber} />}
              {id.frameNumber != null && <MetadataRow label="Frame" value={id.frameNumber} />}
              {id.orbitPassDirection && <MetadataRow label="Pass Direction" value={id.orbitPassDirection} />}
              {id.lookDirection && <MetadataRow label="Look Direction" value={id.lookDirection} />}
              {id.zeroDopplerStartTime && <MetadataRow label="Start Time" value={id.zeroDopplerStartTime} />}
              {id.zeroDopplerEndTime && <MetadataRow label="End Time" value={id.zeroDopplerEndTime} />}
              {id.processingDateTime && <MetadataRow label="Processing Date" value={id.processingDateTime} />}
              {id.productVersion && <MetadataRow label="Product Version" value={id.productVersion} />}
              {id.processingCenter && <MetadataRow label="Processing Center" value={id.processingCenter} />}
              {id.softwareVersion && <MetadataRow label="Software Version" value={id.softwareVersion} />}
              {id.isGeocoded !== undefined && <MetadataRow label="Geocoded" value={id.isGeocoded ? 'Yes' : 'No'} />}
              {id.isDithered !== undefined && <MetadataRow label="Dithered" value={id.isDithered ? 'Yes' : 'No'} />}
              {id.isFullFrame !== undefined && <MetadataRow label="Full Frame" value={id.isFullFrame ? 'Yes' : 'No'} />}
              {id.rtcApplied !== undefined && <MetadataRow label="RTC Applied" value={id.rtcApplied ? 'Yes' : 'No'} />}
              {id.rfiApplied !== undefined && <MetadataRow label="RFI Applied" value={id.rfiApplied ? 'Yes' : 'No'} />}
              {id.ionoRangeApplied !== undefined && <MetadataRow label="Iono Range" value={id.ionoRangeApplied ? 'Yes' : 'No'} />}
              {id.dryTropoApplied !== undefined && <MetadataRow label="Dry Tropo" value={id.dryTropoApplied ? 'Yes' : 'No'} />}
              {id.wetTropoApplied !== undefined && <MetadataRow label="Wet Tropo" value={id.wetTropoApplied ? 'Yes' : 'No'} />}
            </CollapsibleSection>
          )}

          {/* ── Data Info ── */}
          <CollapsibleSection title="Data" defaultOpen={true}>
            <MetadataRow label="Band" value={imageData.band} />
            <MetadataRow label="Frequency" value={imageData.frequency} />
            <MetadataRow label="Polarization" value={imageData.polarization} accent />
            {id.isFullCovariance !== undefined && (
              <MetadataRow label="Full Covariance" value={id.isFullCovariance ? 'Yes' : 'No'} />
            )}
            {imageData.stats?.mean_value != null && (
              <>
                <MetadataRow
                  label="Mean (γ₀)"
                  value={`${(10 * Math.log10(imageData.stats.mean_value)).toFixed(1)} dB`}
                />
                {imageData.stats.sample_stddev != null && (
                  <MetadataRow
                    label="Std. Dev."
                    value={`${(10 * Math.log10(imageData.stats.sample_stddev / imageData.stats.mean_value)).toFixed(1)} dB`}
                  />
                )}
                {imageData.stats.min_value != null && (
                  <MetadataRow
                    label="Range"
                    value={`${(10 * Math.log10(Math.max(imageData.stats.min_value, 1e-10))).toFixed(1)} – ${(10 * Math.log10(Math.max(imageData.stats.max_value, 1e-10))).toFixed(1)} dB`}
                  />
                )}
              </>
            )}
            {imageData._streaming && (
              <MetadataRow label="Access Mode" value="Streaming (h5chunk)" />
            )}
            {imageData._fullLoaded && (
              <MetadataRow label="Access Mode" value="Full load (h5wasm)" />
            )}
          </CollapsibleSection>

          {/* ── Processing Information (§5.6) ── */}
          {fileType === 'nisar' && hasProcessing && (
            <CollapsibleSection title="Processing" defaultOpen={false} count="§5.6">
              <MetadataRow label="Software" value={id.softwareVersion} accent />
              <MetadataRow label="Backscatter" value={id.backscatterConvention} />
              <MetadataRow label="Orbit Type" value={id.orbitType} />
              <MetadataRow label="RTC Applied" value={formatBool(id.rtcApplied)} />
              <MetadataRow label="RFI Correction" value={formatBool(id.rfiApplied)} />
              <MetadataRow label="Pol. Symmetrization" value={formatBool(id.polSymApplied)} />
              <MetadataRow label="Iono. Range Corr." value={formatBool(id.ionoRangeApplied)} />
              <MetadataRow label="Iono. Azimuth Corr." value={formatBool(id.ionoAzApplied)} />
              <MetadataRow label="Dry Tropo. Corr." value={formatBool(id.dryTropoApplied)} />
              <MetadataRow label="Wet Tropo. Corr." value={formatBool(id.wetTropoApplied)} />
            </CollapsibleSection>
          )}

          {/* ── Radar Grid Cube (§5.8) ── */}
          {cubeSummary && (
            <CollapsibleSection title="Radar Grid Cube" defaultOpen={false} count="§5.8">
              <MetadataRow label="Shape" value={cubeSummary.shape.join(' × ')} />
              <MetadataRow label="Fields" value={cubeSummary.fields.length} />
              {cubeSummary.incRange && (
                <MetadataRow
                  label="Inc. Angle"
                  value={`${cubeSummary.incRange[0].toFixed(1)}° – ${cubeSummary.incRange[1].toFixed(1)}°`}
                  accent
                />
              )}
              {cubeSummary.heightRange && (
                <MetadataRow
                  label="Height"
                  value={`${cubeSummary.heightRange[0].toFixed(0)} – ${cubeSummary.heightRange[1].toFixed(0)} m`}
                />
              )}
              <div style={{
                marginTop: '4px',
                fontSize: '0.55rem',
                color: 'var(--text-disabled)',
                lineHeight: 1.4,
              }}>
                {cubeSummary.fields.join(', ')}
              </div>
            </CollapsibleSection>
          )}

          {/* ── File Info ── */}
          {fileName && (
            <CollapsibleSection title="File" defaultOpen={false}>
              <div style={{
                fontSize: '0.6rem',
                color: 'var(--text-muted)',
                wordBreak: 'break-all',
                fontFamily: 'var(--font-mono)',
                lineHeight: 1.5,
              }}>
                {fileName}
              </div>
            </CollapsibleSection>
          )}

          {/* ── GCOV Spec Reference ── */}
          {fileType === 'nisar' && (
            <div style={{
              padding: '6px 8px',
              fontSize: '0.5rem',
              color: 'var(--text-disabled)',
              borderTop: '1px dashed var(--sardine-border, #1e3a5f)',
              fontFamily: 'var(--font-mono)',
              lineHeight: 1.5,
            }}>
              JPL D-102274 Rev E — NISAR L2 GCOV Product Specification v1.2.1
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default MetadataPanel;
