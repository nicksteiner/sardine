/**
 * mosaic-geometry.test.mjs — regression tests for the zoomed-out swath-edge
 * bug: overview tiles built from strided chunk grids used to be returned as
 * raw mosaics and stretched uniformly over the tile, pushing the data edge
 * outward by up to stride×chunk in blocky spikes that jumped between
 * refinement levels. buildMosaicTile must place chunks at their true pixel
 * positions and hold the valid-data footprint at the ~50% coverage contour.
 *
 * Both interpolation modes are covered: 'bilinear' (entry + ladder levels)
 * and 'lanczos' (fine refinement).
 *
 * Synthetic image: 512×512 px, 8×8 chunks of 64×64. A diagonal swath fills
 * the upper-left triangle (gy + gx < 512) with power 5.0; the rest is nodata.
 * Chunks that are entirely nodata are absent from the grid map, mirroring
 * unallocated HDF5 chunks.
 *
 * Run: node test/unit/mosaic-geometry.test.mjs
 */

import { buildMosaicTile } from '../../src/loaders/nisar-loader.js';
import { suite } from './harness.mjs';

const { test, assert, run } = suite('mosaic-geometry');

const CHUNK = 64;
const IMG = 512;          // 8×8 chunk grid
const TILE = 128;         // output tile resolution
const STEP = IMG / TILE;  // 4 source px per output px
const VAL = 5.0;

const validPx = (gy, gx) => gy + gx < IMG;

function makeChunk(cr, cc, fill = validPx) {
  let any = false;
  const data = new Float32Array(CHUNK * CHUNK);
  for (let y = 0; y < CHUNK; y++) {
    for (let x = 0; x < CHUNK; x++) {
      if (fill(cr * CHUNK + y, cc * CHUNK + x)) {
        data[y * CHUNK + x] = VAL;
        any = true;
      }
    }
  }
  return any ? data : null; // fully-nodata chunks are unallocated in HDF5
}

function makeGrid(rows, cols, fill = validPx) {
  const grid = new Map();
  for (const cr of rows) {
    for (const cc of cols) {
      const c = makeChunk(cr, cc, fill);
      if (c) grid.set(`${cr},${cc}`, c);
    }
  }
  return grid;
}

const range = (n, stride = 1) => {
  const out = [];
  for (let i = 0; i < n; i += stride) out.push(i);
  return out;
};

// Source-pixel center of output pixel (ty, tx)
const srcY = ty => (ty + 0.5) * STEP;
const srcX = tx => (tx + 0.5) * STEP;

for (const interp of ['bilinear', 'lanczos']) {

  test(`[${interp}] full grid: edge stays within one cell of the true diagonal`, () => {
    const rows = range(8), cols = range(8);
    const out = buildMosaicTile(makeGrid(rows, cols), rows, cols,
      0, 0, IMG, IMG, TILE, CHUNK, CHUNK, interp, IMG, IMG);

    // subN = ceil(128/8) = 16 → 4 px cells; allow 4× that for interpolation
    const MARGIN = 16;
    let inChecked = 0, outChecked = 0;
    for (let ty = 0; ty < TILE; ty++) {
      for (let tx = 0; tx < TILE; tx++) {
        const d = srcY(ty) + srcX(tx) - IMG; // signed distance past the edge
        const v = out[ty * TILE + tx];
        if (d < -MARGIN) {
          assert.ok(v > 0, `interior pixel (${ty},${tx}) d=${d} should be valid`);
          assert.ok(Math.abs(v - VAL) < 1e-3, `interior value ${v} ≠ ${VAL}`);
          inChecked++;
        } else if (d > MARGIN) {
          assert.equal(v, 0, `pixel (${ty},${tx}) d=${d} px past the edge must be nodata`);
          outChecked++;
        }
      }
    }
    assert.ok(inChecked > 1000 && outChecked > 1000, 'both regions exercised');
  });

  test(`[${interp}] strided grid (ladder entry): no spikes past edge + one stride`, () => {
    const stride = 2;
    const sampledRows = range(8, stride), sampledCols = range(8, stride);
    // The loader fetches only the strided subset — build the grid from it
    const out = buildMosaicTile(makeGrid(sampledRows, sampledCols),
      sampledRows, sampledCols,
      0, 0, IMG, IMG, TILE, CHUNK, CHUNK, interp, IMG, IMG);

    // Unsampled gaps are stride×chunk wide, so the footprint is only known to
    // within one stride — but it must NEVER extend past that (the old code
    // stretched the last sampled row/col over the remainder of the tile).
    const MARGIN = stride * CHUNK + 4;
    let outChecked = 0, inChecked = 0;
    for (let ty = 0; ty < TILE; ty++) {
      for (let tx = 0; tx < TILE; tx++) {
        const d = srcY(ty) + srcX(tx) - IMG;
        const v = out[ty * TILE + tx];
        if (d > MARGIN) {
          assert.equal(v, 0, `strided overview leaks data ${d} px past the edge at (${ty},${tx})`);
          outChecked++;
        } else if (d < -MARGIN) {
          assert.ok(v > 0, `strided overview lost interior pixel (${ty},${tx}) d=${d}`);
          inChecked++;
        }
      }
    }
    assert.ok(inChecked > 500 && outChecked > 500, 'both regions exercised');
  });

  test(`[${interp}] registration: a single valid chunk renders at its true position`, () => {
    // Only chunk (0,0) holds data (src rows/cols 0–63); everything else nodata.
    const onlyCorner = (gy, gx) => gy < CHUNK && gx < CHUNK;

    for (const stride of [1, 2]) {
      const rows = range(8, stride), cols = range(8, stride);
      const out = buildMosaicTile(makeGrid(rows, cols, onlyCorner), rows, cols,
        0, 0, IMG, IMG, TILE, CHUNK, CHUNK, interp, IMG, IMG);

      // Valid data must stay near src 0–64: allow out to the coverage midpoint
      // between the last valid cell (≤64) and the first invalid sampled cell
      // (≥ stride·64), plus interpolation slack. The old uniform stretch put
      // chunk 0 over 1/stride of the whole tile extent instead.
      const limit = (CHUNK + stride * CHUNK) / 2 + 8;
      for (let ty = 0; ty < TILE; ty++) {
        for (let tx = 0; tx < TILE; tx++) {
          const v = out[ty * TILE + tx];
          if (v > 0) {
            assert.ok(srcY(ty) < limit && srcX(tx) < limit,
              `stride ${stride}: valid pixel at src (${srcY(ty)},${srcX(tx)}) beyond ${limit}`);
          }
        }
      }
      // And the chunk's interior must actually render
      assert.ok(out[2 * TILE + 2] > 0, `stride ${stride}: chunk interior missing`);
    }
  });

}

await run();
