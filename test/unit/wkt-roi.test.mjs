/**
 * wkt-roi.test.mjs — behavioral tests for src/utils/wkt.js and
 * src/utils/roi-subset.js.
 *
 * Covers WKT parse/validate/bbox round-trips and bboxToPixelRange /
 * computeSubsetBounds round-trips on a synthetic file-metadata fixture
 * (both the linear-interpolation path and the coordinate-array path).
 *
 * Run: node test/unit/wkt-roi.test.mjs
 */

import { parseWKT, wktToBbox, bboxToWKT, validateWKT, wktToGeoJSON } from '../../src/utils/wkt.js';
import {
  bboxToPixelRange,
  computeSubsetBounds,
  reprojectBbox,
  roiIntersectsFile,
  scopeBboxToChunkRange,
} from '../../src/utils/roi-subset.js';
import { suite } from './harness.mjs';

const { test, assert, assertClose, run } = suite('wkt + roi-subset');

// ─── WKT parsing ─────────────────────────────────────────────────────────────

test('parseWKT: POINT', () => {
  assert.deepEqual(parseWKT('POINT (-122.5 45.25)'), {
    type: 'Point',
    coordinates: [-122.5, 45.25],
  }, 'point geometry');
});

test('parseWKT: POLYGON with hole', () => {
  const geom = parseWKT('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0), (2 2, 4 2, 4 4, 2 2))');
  assert.equal(geom.type, 'Polygon', 'type');
  assert.equal(geom.coordinates.length, 2, 'outer ring + hole');
  assert.deepEqual(geom.coordinates[0], [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], 'outer ring');
  assert.deepEqual(geom.coordinates[1], [[2, 2], [4, 2], [4, 4], [2, 2]], 'hole ring');
});

test('parseWKT: MULTIPOLYGON', () => {
  const geom = parseWKT('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))');
  assert.equal(geom.type, 'MultiPolygon', 'type');
  assert.equal(geom.coordinates.length, 2, 'two polygons');
  assert.deepEqual(geom.coordinates[1][0], [[5, 5], [6, 5], [6, 6], [5, 5]], 'second polygon ring');
});

test('parseWKT: LINESTRING and MULTILINESTRING', () => {
  assert.deepEqual(parseWKT('LINESTRING (0 0, 1 1, 2 0)').coordinates,
    [[0, 0], [1, 1], [2, 0]], 'linestring coords');
  const ml = parseWKT('MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))');
  assert.equal(ml.type, 'MultiLineString', 'type');
  assert.deepEqual(ml.coordinates, [[[0, 0], [1, 1]], [[2, 2], [3, 3]]], 'coords');
});

test('parseWKT: BBOX shorthand expands to closed polygon', () => {
  const geom = parseWKT('BBOX(-123, 44, -122, 45)');
  assert.equal(geom.type, 'Polygon', 'type');
  assert.deepEqual(geom.coordinates[0],
    [[-123, 44], [-122, 44], [-122, 45], [-123, 45], [-123, 44]], 'ring closed');
});

test('parseWKT: invalid input throws', () => {
  assert.throws(() => parseWKT(''), /non-empty string/, 'empty string');
  assert.throws(() => parseWKT('CIRCLE (0 0, 5)'), /Unsupported WKT/, 'unknown type');
  assert.throws(() => parseWKT(null), /non-empty string/, 'null');
});

// ─── bbox round-trips ────────────────────────────────────────────────────────

test('bboxToWKT → wktToBbox round-trip is exact', () => {
  const bbox = [-10.5, -5.25, 20.75, 15.125];
  assert.deepEqual(wktToBbox(bboxToWKT(bbox)), bbox, 'round-trip bbox');
});

test('wktToBbox: POINT degenerates to zero-area bbox', () => {
  assert.deepEqual(wktToBbox('POINT (3 7)'), [3, 7, 3, 7], 'point bbox');
});

test('wktToBbox: MULTIPOLYGON spans all parts', () => {
  const bbox = wktToBbox('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))');
  assert.deepEqual(bbox, [0, 0, 6, 6], 'union bbox');
});

test('validateWKT: valid input returns bbox + type, invalid returns error', () => {
  const ok = validateWKT('POLYGON ((0 0, 2 0, 2 3, 0 0))');
  assert.equal(ok.valid, true, 'valid');
  assert.equal(ok.type, 'Polygon', 'type');
  assert.deepEqual(ok.bbox, [0, 0, 2, 3], 'bbox');

  const badType = validateWKT('TRIANGLE (0 0, 1 1)');
  assert.equal(badType.valid, false, 'invalid type flagged');

  const badCoords = validateWKT('POLYGON ((a b, c d))');
  assert.equal(badCoords.valid, false, 'non-numeric coords flagged');
});

test('wktToGeoJSON: wraps geometry in a Feature', () => {
  const feature = wktToGeoJSON('POINT (1 2)');
  assert.equal(feature.type, 'Feature', 'Feature type');
  assert.deepEqual(feature.geometry, { type: 'Point', coordinates: [1, 2] }, 'geometry');
  assert.deepEqual(feature.properties, {}, 'empty properties');
});

// ─── roi-subset: synthetic file-metadata fixture ─────────────────────────────

// 100×50 px file covering [0,0]–[100,50] in file CRS, 1 unit/pixel.
const linearMeta = {
  worldBounds: [0, 0, 100, 50],
  width: 100,
  height: 50,
  xCoords: null,
  yCoords: null,
};

// Same grid but with explicit pixel-center coordinate arrays:
// xCoords ascending 0.5..99.5, yCoords descending 49.5..0.5.
const xCoords = Float64Array.from({ length: 100 }, (_, i) => i + 0.5);
const yCoords = Float64Array.from({ length: 50 }, (_, i) => 49.5 - i);
const coordMeta = { ...linearMeta, xCoords, yCoords };

test('bboxToPixelRange (linear path): hand-computed pixel window', () => {
  const range = bboxToPixelRange([10, 20, 30, 40], linearMeta);
  // startCol = floor(10/100*100) = 10; endCol = ceil(30/100*100) = 30 → 21 cols
  // startRow = floor((50-40)/50*50) = 10; endRow = ceil((50-20)/50*50) = 30 → 21 rows
  assert.deepEqual(range, { startRow: 10, startCol: 10, numRows: 21, numCols: 21 }, 'pixel range');
});

test('bboxToPixelRange (coordinate-array path): binary search on pixel centers', () => {
  const range = bboxToPixelRange([10.2, 20.2, 30.2, 40.2], coordMeta);
  // startCol: first xCoord >= 10.2 → 10.5 (i=10); endCol: last <= 30.2 → 29.5 (i=29)
  // startRow: first yCoord <= 40.2 → 39.5 (i=10); endRow: last >= 20.2 → 20.5 (i=29)
  assert.deepEqual(range, { startRow: 10, startCol: 10, numRows: 20, numCols: 20 }, 'pixel range');
});

test('bboxToPixelRange: ROI clamped to file extent', () => {
  const range = bboxToPixelRange([-50, -50, 20, 25], linearMeta);
  // Clamped ROI = [0, 0, 20, 25]: cols 0..20, rows (50-25)/50*50=25 .. 50 → clamped 49
  assert.deepEqual(range, { startRow: 25, startCol: 0, numRows: 25, numCols: 21 }, 'clamped range');
});

test('bboxToPixelRange: disjoint ROI returns null', () => {
  assert.equal(bboxToPixelRange([200, 200, 300, 300], linearMeta), null, 'east of file');
  assert.equal(bboxToPixelRange([-10, -10, 0, 0], linearMeta), null, 'touching edge only');
});

test('computeSubsetBounds (linear path): pixel range → world bounds', () => {
  const range = { startRow: 10, startCol: 10, numRows: 21, numCols: 21 };
  const bounds = computeSubsetBounds(range, linearMeta);
  // minX = 10, maxX = 31 (pixel edges); maxY = 50-10 = 40, minY = 50-31 = 19
  assert.deepEqual(bounds, [10, 19, 31, 40], 'subset bounds');
});

test('computeSubsetBounds (coordinate-array path): bounds from pixel centers', () => {
  const range = { startRow: 10, startCol: 10, numRows: 20, numCols: 20 };
  const bounds = computeSubsetBounds(range, coordMeta);
  // xCoords[10]=10.5 .. xCoords[29]=29.5; yCoords[10]=39.5 .. yCoords[29]=20.5
  assert.deepEqual(bounds, [10.5, 20.5, 29.5, 39.5], 'subset bounds');
});

test('round-trip: bbox → pixel range → bounds stays within two pixels of clamped ROI', () => {
  // The linear path floors/ceils to whole pixels and treats endRow/endCol as
  // inclusive, so max edges can expand by up to 2 px; centers path can shrink
  // by up to 1 px. 2 px is the tight envelope for a 1-unit/px grid.
  const roi = [12.3, 17.8, 66.1, 43.9];
  for (const meta of [linearMeta, coordMeta]) {
    const range = bboxToPixelRange(roi, meta);
    assert.ok(range !== null, 'range found');
    const bounds = computeSubsetBounds(range, meta);
    for (let i = 0; i < 4; i++) {
      assertClose(bounds[i], roi[i], 2.0, `bounds[${i}] within 2 px of ROI`);
    }
    // Subset must actually cover pixels: positive extents
    assert.ok(bounds[2] > bounds[0] && bounds[3] > bounds[1], 'non-degenerate bounds');
  }
});

test('roiIntersectsFile: overlap and disjoint cases', () => {
  assert.equal(roiIntersectsFile([5, 5, 15, 15], [0, 0, 10, 10]), true, 'partial overlap');
  assert.equal(roiIntersectsFile([10, 0, 20, 10], [0, 0, 10, 10]), false, 'edge-touching is disjoint');
  assert.equal(roiIntersectsFile([-5, -5, -1, -1], [0, 0, 10, 10]), false, 'fully outside');
  assert.equal(roiIntersectsFile([2, 2, 3, 3], [0, 0, 10, 10]), true, 'contained');
});

test('reprojectBbox: EPSG:4326 and missing CRS pass through unchanged', () => {
  const bbox = [-123, 44, -122, 45];
  assert.deepEqual(reprojectBbox(bbox, 'EPSG:4326'), bbox, '4326 passthrough');
  assert.deepEqual(reprojectBbox(bbox, null), bbox, 'null CRS passthrough');
  assert.deepEqual(reprojectBbox(bbox, 'not-a-crs'), bbox, 'unparseable CRS passthrough');
});

// ─── scopeBboxToChunkRange: W016 deep-link prefetch scoping ──────────────────

// Same 100×50 px grid, tiled into 16-row × 32-col chunks →
// chunk grid is ceil(50/16)=4 rows × ceil(100/32)=4 cols.
const chunkMeta = { ...linearMeta, chunkH: 16, chunkW: 32, crs: 'EPSG:4326' };

test('scopeBboxToChunkRange: hand-computed chunk subset', () => {
  // bbox [10,20,30,40] → pixel range rows 10..30, cols 10..30 (see above)
  // → chunk rows floor(10/16)=0 .. floor(30/16)=1, cols floor(10/32)=0 .. floor(30/32)=0
  assert.deepEqual(scopeBboxToChunkRange([10, 20, 30, 40], chunkMeta),
    { startCR: 0, endCR: 1, startCC: 0, endCC: 0 }, 'exact chunk subset');
});

test('scopeBboxToChunkRange: small AOI resolves to a single chunk', () => {
  // bbox [65,5,70,12] → cols 65..70 (chunk col 2), rows 38..45 (chunk row 2)
  assert.deepEqual(scopeBboxToChunkRange([65, 5, 70, 12], chunkMeta),
    { startCR: 2, endCR: 2, startCC: 2, endCC: 2 }, 'single chunk');
});

test('scopeBboxToChunkRange: full-scene bbox covers the whole chunk grid', () => {
  assert.deepEqual(scopeBboxToChunkRange([0, 0, 100, 50], chunkMeta),
    { startCR: 0, endCR: 3, startCC: 0, endCC: 3 }, 'full 4×4 grid');
});

test('scopeBboxToChunkRange: oversized bbox clamps to the chunk grid', () => {
  assert.deepEqual(scopeBboxToChunkRange([-500, -500, 500, 500], chunkMeta),
    { startCR: 0, endCR: 3, startCC: 0, endCC: 3 }, 'clamped to grid');
});

test('scopeBboxToChunkRange: disjoint bbox or missing chunk dims → null', () => {
  assert.equal(scopeBboxToChunkRange([200, 200, 300, 300], chunkMeta), null, 'disjoint');
  assert.equal(scopeBboxToChunkRange([10, 20, 30, 40], { ...linearMeta, crs: 'EPSG:4326' }),
    null, 'no chunk dims');
});

test('scopeBboxToChunkRange: coordinate-array path matches bboxToPixelRange', () => {
  const meta = { ...coordMeta, chunkH: 16, chunkW: 32, crs: 'EPSG:4326' };
  // Pixel range (coords path): rows 10..29, cols 10..29 (see bboxToPixelRange test)
  assert.deepEqual(scopeBboxToChunkRange([10.2, 20.2, 30.2, 40.2], meta),
    { startCR: 0, endCR: 1, startCC: 0, endCC: 0 }, 'coordinate-array chunk subset');
});

test('scopeBboxToChunkRange: WGS84 scope is reprojected into a projected file grid', () => {
  const crs = 'EPSG:32610';
  // Synthetic UTM file covering the reprojection of this WGS84 envelope,
  // 400×400 px in 100×100 px chunks → 4×4 chunk grid.
  const fileBounds = reprojectBbox([-123.2, 44.9, -122.8, 45.3], crs);
  const meta = { worldBounds: fileBounds, width: 400, height: 400, chunkH: 100, chunkW: 100, crs };
  // Central quarter of the scene (in lon/lat) must land on interior chunks only.
  const r = scopeBboxToChunkRange([-123.05, 45.05, -122.95, 45.15], meta);
  assert.ok(r !== null, 'intersects');
  assert.ok(r.startCC >= 1 && r.endCC <= 2, `interior cols [${r.startCC}, ${r.endCC}]`);
  assert.ok(r.startCR >= 1 && r.endCR <= 2, `interior rows [${r.startCR}, ${r.endCR}]`);
});

test('reprojectBbox: EPSG:32610 straddles the UTM 10N central meridian', () => {
  // Zone 10N central meridian is -123°E ↔ easting 500000
  const out = reprojectBbox([-123.1, 45.0, -122.9, 45.2], 'EPSG:32610');
  assert.ok(out[0] < 500000 && out[2] > 500000, `central meridian inside [${out[0]}, ${out[2]}]`);
  assert.ok(out[1] > 4_900_000 && out[3] < 5_100_000, 'northing near 45°N (~5,000 km)');
  assert.ok(out[3] > out[1], 'min/max ordered');
});

await run();
