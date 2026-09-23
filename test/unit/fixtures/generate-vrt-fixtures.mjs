/**
 * Regenerate the VRT fixtures in test/unit/fixtures/vrt/.
 *
 * Source GeoTIFFs are written with SARdine's own writer; every VRT is then
 * built by real GDAL (gdalbuildvrt / gdal_translate -of VRT), and GDAL's own
 * rendering of each VRT is saved as <name>_expected.tif. vrt-loader.test.mjs
 * asserts the JS loader reproduces GDAL pixel-for-pixel.
 *
 * Requires GDAL CLI tools on PATH (tested with 3.8). The outputs are
 * committed, so `npm test` does not need GDAL.
 *
 * Run: node test/unit/fixtures/generate-vrt-fixtures.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFloat32GeoTIFF } from '../../../src/utils/geotiff-writer.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'vrt');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const gdal = (cmd, ...args) => execFileSync(cmd, args, { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });

async function writeTif(name, w, h, bounds, fill) {
  const band = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) band[r * w + c] = fill(r, c);
  const buf = await writeFloat32GeoTIFF({ b: band }, ['b'], w, h, bounds, 32610);
  writeFileSync(join(dir, name), Buffer.from(buf));
}

// Three tiles on a 1 m UTM grid (EPSG:32610): a, b overlapping a's east
// edge, and c at 2 m below a (exercises DstRect scaling).
const X0 = 500000, Y0 = 4000000;
await writeTif('a.tif', 40, 30, [X0, Y0, X0 + 40, Y0 + 30], (r, c) => 100 + r * 40 + c);
await writeTif('a2.tif', 40, 30, [X0, Y0, X0 + 40, Y0 + 30], (r, c) => 2 * (100 + r * 40 + c));
// b has a zero block where it overlaps a — nodata-aware VRTs let a show through
await writeTif('b.tif', 40, 30, [X0 + 30, Y0 - 10, X0 + 70, Y0 + 20],
  (r, c) => (r >= 10 && r < 20 && c < 10 ? 0 : 5000 + r * 40 + c));
await writeTif('c.tif', 20, 15, [X0, Y0 - 30, X0 + 40, Y0], (r, c) => 9000 + r * 20 + c);
// 128×96 source converted to a COG with AVERAGE overviews: the overview
// values (block means) differ from any single full-res pixel, so a test can
// tell which level a read came from.
await writeTif('d_raw.tif', 128, 96, [X0, Y0, X0 + 128, Y0 + 96], (r, c) => c + 1000 * (r % 2));

gdal('gdal_translate', '-q', '-of', 'COG', '-co', 'BLOCKSIZE=16', '-co', 'OVERVIEW_RESAMPLING=AVERAGE',
  '-co', 'COMPRESS=DEFLATE', 'd_raw.tif', 'd_cog.tif');
rmSync(join(dir, 'd_raw.tif'));

// VRTs, each built by GDAL
gdal('gdalbuildvrt', '-q', '-resolution', 'highest', 'plain.vrt', 'a.tif', 'b.tif');
gdal('gdalbuildvrt', '-q', '-resolution', 'highest', '-srcnodata', '0', 'mosaic.vrt', 'a.tif', 'b.tif', 'c.tif');
gdal('gdalbuildvrt', '-q', '-separate', 'separate.vrt', 'a.tif', 'a2.tif');
gdal('gdal_translate', '-q', '-of', 'VRT', '-ot', 'Float32', '-srcwin', '5', '4', '20', '15',
  '-scale', '100', '1300', '0', '1', 'a.tif', 'subset_scaled.vrt');
gdal('gdalbuildvrt', '-q', 'cog.vrt', 'd_cog.tif');

// GDAL's rendering of each VRT = ground truth
for (const name of ['plain', 'mosaic', 'subset_scaled']) {
  gdal('gdal_translate', '-q', '-of', 'GTiff', `${name}.vrt`, `${name}_expected.tif`);
}
gdal('gdal_translate', '-q', '-of', 'GTiff', '-b', '2', 'separate.vrt', 'separate_b2_expected.tif');

console.log(`VRT fixtures written to ${dir}`);
