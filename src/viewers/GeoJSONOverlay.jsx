import React, { useEffect, useState, useMemo } from 'react';
import { GeoJsonLayer } from '@deck.gl/layers';

/**
 * GeoJSONOverlay - Deck.gl layer for GeoJSON catalog boundaries
 * Props:
 *   url: string - URL to GeoJSON catalog
 *   onFeatureClick: function - callback(feature) when a boundary is clicked
 *   opacity: number - layer opacity
 */
export function GeoJSONOverlay({ url, onFeatureClick, opacity = 0.7 }) {
  const [geojson, setGeojson] = useState(null);

  useEffect(() => {
    if (!url) return;
    fetch(url)
      .then(r => r.json())
      .then(setGeojson)
      .catch(() => setGeojson(null));
  }, [url]);

  const layer = useMemo(() => {
    if (!geojson) return null;
    return new GeoJsonLayer({
      id: 'geojson-overlay',
      data: geojson,
      pickable: true,
      stroked: true,
      filled: false,
      lineWidthMinPixels: 2,
      getLineColor: [255, 255, 0, 255],
      getLineWidth: 2,
      opacity,
      onClick: info => {
        if (onFeatureClick && info.object) onFeatureClick(info.object);
      },
    });
  }, [geojson, opacity, onFeatureClick]);

  return layer ? [layer] : [];
}

export default GeoJSONOverlay;
