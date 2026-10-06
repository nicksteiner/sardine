#!/usr/bin/env node
/**
 * bench_exposure.mjs — live check of src/utils/exposure.js against the real
 * sources: GHS-POP 100 m (OpenLandMap COG) and VIDA building footprints
 * (Source Cooperative PMTiles). Prints people and buildings for a polygon,
 * with timings and bytes.
 *
 * Run: node test/benchmarks/bench_exposure.mjs [--bbox minLon,minLat,maxLon,maxLat]
 * Default polygon: a 0.1°×0.1° box over Iquitos, Peru.
 */
import '../helpers/dom-parser-shim.mjs';
import { openCOGReader } from '../../src/loaders/cog-tile-reader.js';
import { GHS_POP_COG_URL, sumPopulationInPolygon, countBuildingsInPolygon } from '../../src/utils/exposure.js';

const args = process.argv.slice(2);
const i = args.indexOf('--bbox');
const [minLon, minLat, maxLon, maxLat] = (i >= 0 ? args[i + 1] : '-73.30,-3.80,-73.20,-3.70').split(',').map(Number);
const rings = [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]];

const realFetch = globalThis.fetch;
let requests = 0, bytes = 0;
globalThis.fetch = async (u, init) => { requests++; const r = await realFetch(u, init); bytes += Number(r.headers.get('content-length')) || 0; return r; };

let t = performance.now();
const reader = await openCOGReader(GHS_POP_COG_URL(2021));
console.log(`GHS-POP opened in ${((performance.now() - t) / 1000).toFixed(2)} s (${reader.width}×${reader.height}, ${reader.levelCount} levels)`);

t = performance.now();
const pop = await sumPopulationInPolygon(reader, rings);
console.log(`people: ${Math.round(pop.people).toLocaleString()}  (${pop.cells.toLocaleString()} cells, ${pop.areaKm2.toFixed(1)} km², level ${pop.level}) in ${((performance.now() - t) / 1000).toFixed(2)} s`);

t = performance.now();
const b = await countBuildingsInPolygon(rings, { zoom: 14 });
console.log(`buildings: ${b.buildings.toLocaleString()} (${(b.areaM2 / 1e6).toFixed(2)} km² footprint, ${b.tiles} tiles z14) ${JSON.stringify(b.bySource)} in ${((performance.now() - t) / 1000).toFixed(2)} s`);
console.log(`network: ${requests} requests, ${(bytes / 1e6).toFixed(1)} MB`);
