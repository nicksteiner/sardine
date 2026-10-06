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
import { loadNISARGCOVFromUrl, loadNISARRGBComposite } from '../src/loaders/nisar-loader.js';
import { rgbContrastFromBandStats } from '../src/utils/sar-composites.js';
import { getRequiredDatasets } from '../src/utils/sar-composites.js';

const status = (msg) => { document.getElementById('status').textContent = msg; };
const params = new URLSearchParams(location.search);
const cogs = (params.get('cog') || '').split(',').filter(Boolean);
const h5 = params.get('url'); // NISAR GCOV HDF5 (h5chunk streaming)
const comp = params.get('comp'); // composite id → RGB; absent → single band
const pol = params.get('pol') || 'HHHH';
const freq = params.get('freq') || 'A';
const mapStyle = params.get('style') || 'https://tiles.openfreemap.org/styles/liberty';

async function main() {
  if (!cogs.length && !h5) { status('add ?cog=<url> (or ?cog=a,b&comp=dual-pol-h) or ?url=<nisar.h5>[&comp=…|&pol=HHHH]'); return; }
  const t0 = performance.now();
  let scene, layerProps, contrastLimits;
  if (h5 && comp) {
    const polNames = getRequiredDatasets(comp);
    scene = await loadNISARRGBComposite(h5, { frequency: freq, compositeId: comp, requiredPols: polNames });
    contrastLimits = rgbContrastFromBandStats(comp, scene.bandStats, polNames, true) || [-25, 0];
    layerProps = { stretchMode: 'sigmoid' };
  } else if (h5) {
    scene = await loadNISARGCOVFromUrl(h5, { frequency: freq, polarization: pol });
    contrastLimits = [-25, 0];
    layerProps = {};
  } else if (cogs.length > 1) {
    const polNames = getRequiredDatasets(comp);
    const id = comp || 'dual-pol-h';
    scene = await loadCOGRGBComposite({ urls: cogs, polNames: getRequiredDatasets(id), compositeId: id });
    contrastLimits = rgbContrastFromBandStats(id, scene.bandStats, getRequiredDatasets(id), true) || [-25, 0];
    layerProps = { stretchMode: 'sigmoid' };
  } else {
    scene = await loadLocalTIF(cogs[0]);
    contrastLimits = [-25, 0];
    layerProps = {};
  }
  status(`${scene.width}×${scene.height} ${scene.crs} — opened in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
  window.__scene = scene; // for poking at getTile from the console

  const b = scene.bounds || [];
  const pixelSpace = b[0] === 0 && b[1] === 0 && b[2] === scene.width && b[3] === scene.height;
  const reproject = {
    width: scene.width,
    height: scene.height,
    worldBounds: scene.worldBounds || scene.geoBounds || scene.bounds,
    crs: scene.crs,
    bboxSpace: pixelSpace ? 'pixel' : 'world',
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
