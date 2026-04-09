#!/usr/bin/env node
/**
 * Render an SVG figure of a SICD NITF's slant-range frame with Overture
 * buildings and roads projected into it via the sarpy-equivalent
 * sicd-projection module.
 *
 * Usage:
 *   node scripts/render-nitf-slant-figure.mjs <nitf-file> [--out <dir>]
 *   node scripts/render-nitf-slant-figure.mjs <dir-of-nitfs> [--out <dir>] [--limit N]
 *
 * Output: one SVG per NITF in the output dir (default
 * test/fixtures/nitf-projection/).
 *
 * The SVG viewBox is chip-local (col, row) pixel coordinates — i.e. the
 * image's native slant-range frame. Buildings with non-null Overture
 * height are drawn twice: once at h=0 (base footprint, solid) and once
 * at h=building_height (layover-shifted "top", stroked). Roads are drawn
 * at h=0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';

import { parseNITFMetadataFromBuffer } from '../src/loaders/nitf-loader.js';
import {
  buildSICDProjection,
  groundToImage,
  groundToImageBulk,
  imageBboxFromProjection,
} from '../src/utils/sicd-projection.js';
import { loadBuildingsInBbox } from '../src/loaders/overture-buildings.js';
import { fetchOvertureTile, bboxToTiles, getZoomForBbox } from '../src/loaders/overture-loader.js';

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: render-nitf-slant-figure.mjs <file|dir> [--out DIR] [--limit N]');
  process.exit(2);
}
const inputPath = args[0];
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : 'test/fixtures/nitf-projection';
const limIdx = args.indexOf('--limit');
const limit = limIdx >= 0 ? parseInt(args[limIdx + 1]) : Infinity;

fs.mkdirSync(outDir, { recursive: true });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function listNitfs(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  return fs.readdirSync(p)
    .filter(f => /\.(nitf|ntf)$/i.test(f))
    .map(f => path.join(p, f));
}

function readBuffer(file) {
  const buf = fs.readFileSync(file);
  // fs returns a Buffer; get its underlying ArrayBuffer view
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Fetch Overture road segments for a bbox via PMTiles, flattening features
 * from any tiles intersecting the bbox.
 */
async function loadRoadsInBbox(bbox, { maxTiles = 60 } = {}) {
  const zoom = Math.min(12, Math.max(8, getZoomForBbox(bbox)));
  const tiles = bboxToTiles(bbox, zoom);
  const tileCount = (tiles.maxX - tiles.minX + 1) * (tiles.maxY - tiles.minY + 1);
  if (tileCount > maxTiles) {
    console.warn(`[roads] ${tileCount} tiles at z${zoom} > maxTiles=${maxTiles}, capping`);
  }
  const features = [];
  let loaded = 0;
  outer:
  for (let x = tiles.minX; x <= tiles.maxX; x++) {
    for (let y = tiles.minY; y <= tiles.maxY; y++) {
      if (loaded >= maxTiles) break outer;
      try {
        const tileData = await fetchOvertureTile('transportation', zoom, x, y);
        for (const layerFeatures of Object.values(tileData.layers || {})) {
          for (const f of layerFeatures) {
            if (f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString')) {
              features.push(f);
            }
          }
        }
        loaded++;
      } catch (e) {
        // swallow
      }
    }
  }
  return features;
}

/**
 * Flatten a GeoJSON geometry into arrays of [lons, lats] rings.
 * Returns an array of rings — each ring is {lons: Float64Array, lats: Float64Array}.
 * For LineString: one ring. For Polygon: one ring per coordinate array.
 * For MultiPolygon: one ring per polygon's first ring (outer).
 */
function geometryToRings(geom) {
  const rings = [];
  const pushRing = (coords) => {
    const N = coords.length;
    const lons = new Float64Array(N);
    const lats = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      lons[i] = coords[i][0];
      lats[i] = coords[i][1];
    }
    rings.push({ lons, lats });
  };
  if (!geom) return rings;
  if (geom.type === 'Polygon') {
    pushRing(geom.coordinates[0]); // outer ring only
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) pushRing(poly[0]);
  } else if (geom.type === 'LineString') {
    pushRing(geom.coordinates);
  } else if (geom.type === 'MultiLineString') {
    for (const line of geom.coordinates) pushRing(line);
  }
  return rings;
}

/**
 * Project a ring's lon/lat arrays into chip-local (row, col) and format
 * as an SVG polygon/polyline points string. Returns '' if the ring falls
 * entirely outside the image extent.
 */
function ringToSvgPoints(ring, h, proj) {
  const pts = groundToImageBulk(ring.lons, ring.lats, h, proj);
  // SVG x = col, y = row (so image orientation matches typical display).
  let s = '';
  let anyInside = false;
  const nR = proj.nRows, nC = proj.nCols;
  const pad = 200;
  for (let i = 0; i < ring.lons.length; i++) {
    const row = pts[2 * i];
    const col = pts[2 * i + 1];
    if (row > -pad && row < nR + pad && col > -pad && col < nC + pad) anyInside = true;
    if (i > 0) s += ' ';
    s += `${col.toFixed(1)},${row.toFixed(1)}`;
  }
  return anyInside ? s : '';
}

// ─── SVG rendering ──────────────────────────────────────────────────────────

function buildSVG({ proj, sicd, imageBbox, buildings, roads, nitfBasename }) {
  const nR = proj.nRows;
  const nC = proj.nCols;

  // Downsample for readability: if image is huge, scale viewBox to max 4000 units
  // (we render in real pixel space but SVG handles huge viewBoxes fine, so keep 1:1)
  const strokeW = Math.max(2, Math.round(Math.min(nR, nC) / 2000));

  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${nC} ${nR}" preserveAspectRatio="xMidYMid meet">`);
  parts.push(`  <title>${nitfBasename} — slant-range projection</title>`);
  // Dark background
  parts.push(`  <rect x="0" y="0" width="${nC}" height="${nR}" fill="#0b0f14"/>`);
  // Image frame
  parts.push(`  <rect x="0" y="0" width="${nC}" height="${nR}" fill="none" stroke="#334155" stroke-width="${strokeW * 2}"/>`);

  // Grid ticks every 10% as guidance
  parts.push(`  <g stroke="#1f2937" stroke-width="${strokeW}" fill="none">`);
  for (let i = 1; i < 10; i++) {
    const x = nC * i / 10;
    const y = nR * i / 10;
    parts.push(`    <line x1="${x}" y1="0" x2="${x}" y2="${nR}"/>`);
    parts.push(`    <line x1="0" y1="${y}" x2="${nC}" y2="${y}"/>`);
  }
  parts.push(`  </g>`);

  // Roads
  parts.push(`  <g stroke="#64748b" stroke-width="${strokeW * 3}" fill="none" stroke-linejoin="round" stroke-linecap="round" opacity="0.9">`);
  let roadRings = 0;
  for (const f of roads) {
    for (const ring of geometryToRings(f.geometry)) {
      const pts = ringToSvgPoints(ring, 0, proj);
      if (pts) {
        parts.push(`    <polyline points="${pts}"/>`);
        roadRings++;
      }
    }
  }
  parts.push(`  </g>`);

  // Buildings: footprint at h=0 (solid orange)
  parts.push(`  <g fill="#ea580c" fill-opacity="0.55" stroke="#fb923c" stroke-width="${strokeW}">`);
  let bFootprint = 0, bWithHeight = 0;
  const topsSegments = []; // layover rays (base -> top centroid)
  for (const f of buildings) {
    const height = f.properties?.height;
    for (const ring of geometryToRings(f.geometry)) {
      const pts = ringToSvgPoints(ring, 0, proj);
      if (pts) {
        parts.push(`    <polygon points="${pts}"/>`);
        bFootprint++;
        // If the building has a height, also compute the layover-shifted top
        if (typeof height === 'number' && height > 0) {
          bWithHeight++;
          const topPts = ringToSvgPoints(ring, height, proj);
          if (topPts) {
            topsSegments.push({ topPts, basePts: pts });
          }
        }
      }
    }
  }
  parts.push(`  </g>`);

  // Building tops (layover positions) in a second pass so they render on top
  parts.push(`  <g fill="none" stroke="#fde047" stroke-width="${strokeW * 1.5}" stroke-opacity="0.95">`);
  for (const { topPts } of topsSegments) {
    parts.push(`    <polygon points="${topPts}"/>`);
  }
  parts.push(`  </g>`);

  // SCP marker (chip-local)
  const scpR = proj.scpRow - proj.firstRow;
  const scpC = proj.scpCol - proj.firstCol;
  const mR = Math.max(20, nR / 200);
  parts.push(`  <g stroke="#22d3ee" stroke-width="${strokeW * 3}" fill="none">`);
  parts.push(`    <circle cx="${scpC}" cy="${scpR}" r="${mR}"/>`);
  parts.push(`    <line x1="${scpC - mR * 1.5}" y1="${scpR}" x2="${scpC + mR * 1.5}" y2="${scpR}"/>`);
  parts.push(`    <line x1="${scpC}" y1="${scpR - mR * 1.5}" x2="${scpC}" y2="${scpR + mR * 1.5}"/>`);
  parts.push(`  </g>`);

  // Metadata text block
  const font = Math.max(20, Math.round(nR / 80));
  const lineH = Math.round(font * 1.25);
  const x0 = Math.round(nC * 0.015);
  let y0 = Math.round(nR * 0.03) + font;
  const meta = [
    `NITF: ${nitfBasename}`,
    `Collector: ${sicd.collector || '?'}  Mode: ${sicd.modeType || '?'}`,
    `Image: ${nC} cols × ${nR} rows   Pixel: ${sicd.pixelType || '?'}`,
    `SCP: ${proj.scpLat.toFixed(5)}°, ${proj.scpLon.toFixed(5)}°  HAE=${proj.scpHae.toFixed(1)} m`,
    `Grid: rowSS=${proj.rowSS.toFixed(3)} m  colSS=${proj.colSS.toFixed(3)} m`,
    `SCPCOA: graze=${proj.grazeAng?.toFixed(2)}°  side=${proj.sideOfTrack}`,
    `Bbox: [${imageBbox[0].toFixed(4)}, ${imageBbox[1].toFixed(4)}, ${imageBbox[2].toFixed(4)}, ${imageBbox[3].toFixed(4)}]`,
    `Overture: ${bFootprint} building rings (${bWithHeight} with height), ${roadRings} road lines`,
  ];
  parts.push(`  <g font-family="ui-monospace, monospace" font-size="${font}" fill="#e2e8f0">`);
  parts.push(`    <rect x="${x0 - 10}" y="${y0 - font - 5}" width="${font * 42}" height="${lineH * meta.length + 10}" fill="#0b0f14" fill-opacity="0.75" stroke="#334155"/>`);
  for (const line of meta) {
    parts.push(`    <text x="${x0}" y="${y0}">${escapeXml(line)}</text>`);
    y0 += lineH;
  }
  parts.push(`  </g>`);

  // Orientation arrows (range down, azimuth right) in bottom-right
  const ax = nC - nC * 0.04 - font * 10;
  const ay = nR - nR * 0.03 - font * 6;
  parts.push(`  <g stroke="#94a3b8" stroke-width="${strokeW * 2}" fill="#94a3b8" font-family="ui-monospace, monospace" font-size="${font}">`);
  parts.push(`    <line x1="${ax}" y1="${ay}" x2="${ax + font * 4}" y2="${ay}" marker-end="url(#arr)"/>`);
  parts.push(`    <text x="${ax + font * 4 + 10}" y="${ay + font / 3}">col (az)</text>`);
  parts.push(`    <line x1="${ax}" y1="${ay}" x2="${ax}" y2="${ay + font * 4}" marker-end="url(#arr)"/>`);
  parts.push(`    <text x="${ax - font * 4}" y="${ay + font * 4 + font}">row (rg)</text>`);
  parts.push(`  </g>`);
  parts.push(`  <defs><marker id="arr" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"/></marker></defs>`);

  parts.push(`</svg>`);
  return parts.join('\n');
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

// ─── Main per-file pipeline ──────────────────────────────────────────────────

async function renderOne(nitfPath) {
  const base = path.basename(nitfPath).replace(/\.(nitf|ntf)$/i, '');
  console.log(`\n── ${base} ──`);
  console.log(`  Reading ${nitfPath}`);
  const buf = readBuffer(nitfPath);
  const { sicd, imageSubheader } = parseNITFMetadataFromBuffer(buf, DOMParser);

  if (!sicd) throw new Error('No SICD XML found in NITF');
  if (!sicd.geometry?.rowUVect) throw new Error('SICD missing Grid.Row.UVectECF');
  if (!sicd.scp?.ecef) throw new Error('SICD missing GeoData.SCP.ECF');
  if (!sicd.scpPixel) throw new Error('SICD missing ImageData.SCPPixel');

  // Fall back to NITF subheader dimensions if SICD didn't populate them
  if (!sicd.nrows) sicd.nrows = imageSubheader.nrows;
  if (!sicd.ncols) sicd.ncols = imageSubheader.ncols;

  const proj = buildSICDProjection(sicd);
  console.log(`  Image: ${proj.nCols} × ${proj.nRows}  SCP: (${proj.scpLat.toFixed(4)}, ${proj.scpLon.toFixed(4)})  graze=${proj.grazeAng?.toFixed(1)}°`);

  const { bbox } = imageBboxFromProjection(proj);
  console.log(`  bbox (from projection, not ICPs): [${bbox.map(v => v.toFixed(4)).join(', ')}]`);

  console.log(`  Fetching Overture buildings...`);
  let buildings = [];
  try {
    buildings = await loadBuildingsInBbox(bbox, { maxTiles: 80 });
  } catch (e) {
    console.warn(`  buildings fetch failed: ${e.message}`);
  }
  console.log(`  → ${buildings.length} buildings`);

  console.log(`  Fetching Overture roads...`);
  let roads = [];
  try {
    roads = await loadRoadsInBbox(bbox, { maxTiles: 60 });
  } catch (e) {
    console.warn(`  roads fetch failed: ${e.message}`);
  }
  console.log(`  → ${roads.length} roads`);

  const svg = buildSVG({ proj, sicd, imageBbox: bbox, buildings, roads, nitfBasename: base });
  const outFile = path.join(outDir, `${base}.svg`);
  fs.writeFileSync(outFile, svg);
  console.log(`  → wrote ${outFile} (${(svg.length / 1024).toFixed(0)} KB)`);
  return { base, buildings: buildings.length, roads: roads.length, outFile };
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const files = listNitfs(inputPath).slice(0, limit);
console.log(`Rendering ${files.length} NITF file(s) → ${outDir}/`);

let ok = 0, fail = 0;
for (const f of files) {
  try {
    await renderOne(f);
    ok++;
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    console.error(e.stack);
    fail++;
  }
}
console.log(`\nDone: ${ok} ok, ${fail} failed.`);
process.exit(fail ? 1 : 0);
