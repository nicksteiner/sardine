/**
 * reproject-demo.jsx — W033 spike page: open a projected COG (UTM etc.) and
 * draw it on a Web Mercator MapLibre basemap through warped tile meshes.
 *
 *   npx vite --config vite.test.config.js --port 5175
 *   http://localhost:5175/test/reproject-demo.html?cog=<url>[,<url2>&comp=dual-pol-h]
 *
 * Dev-only; not part of the production build.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MapViewer } from '../src/viewers/MapViewer.jsx';
import { loadCOGRGBComposite, loadLocalTIF } from '../src/loaders/cog-loader.js';
import { rgbContrastFromBandStats } from '../src/utils/sar-composites.js';
import { getRequiredDatasets } from '../src/utils/sar-composites.js';

const status = (msg) => { document.getElementById('status').textContent = msg; };
const params = new URLSearchParams(location.search);
const cogs = (params.get('cog') || '').split(',').filter(Boolean);
const comp = params.get('comp') || 'dual-pol-h';
const mapStyle = params.get('style') || 'https://tiles.openfreemap.org/styles/liberty';

async function main() {
  if (!cogs.length) { status('add ?cog=<url> (or ?cog=a,b&comp=dual-pol-h)'); return; }
  const t0 = performance.now();
  let scene, layerProps, contrastLimits;
  if (cogs.length > 1) {
    const polNames = getRequiredDatasets(comp);
    scene = await loadCOGRGBComposite({ urls: cogs, polNames, compositeId: comp });
    contrastLimits = rgbContrastFromBandStats(comp, scene.bandStats, polNames, true) || [-25, 0];
    layerProps = { stretchMode: 'sigmoid' };
  } else {
    scene = await loadLocalTIF(cogs[0]);
    contrastLimits = [-25, 0];
    layerProps = {};
  }
  status(`${scene.width}×${scene.height} ${scene.crs} — opened in ${((performance.now() - t0) / 1000).toFixed(2)} s`);

  const reproject = {
    width: scene.width,
    height: scene.height,
    worldBounds: scene.worldBounds || scene.geoBounds || scene.bounds,
    crs: scene.crs,
  };

  createRoot(document.getElementById('root')).render(
    <MapViewer
      getTile={scene.getRGBTile || scene.getTile}
      reproject={reproject}
      contrastLimits={contrastLimits}
      useDecibels={true}
      opacity={1}
      mapStyle={mapStyle}
      showControls={false}
      layerProps={layerProps}
    />
  );
}

main().catch((e) => { status(`error: ${e.message}`); console.error(e); });
