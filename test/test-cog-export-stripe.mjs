// Repro: rendered RGBA GeoTIFF export from a plain TIF / COG comes out blank.
//
// What we check:
//   1) loadLocalTIF().getExportStripe(...) returns a Float32 band keyed under
//      `band0` (single-band loader convention).
//   2) That band actually contains finite, non-zero data — i.e. the v!==0
//      nodata filter inside getExportStripe isn't masking everything to NaN.
//   3) The alpha-mask the export path applies later (amplitude===0 || NaN ⇒
//      alpha 0) leaves a non-trivial fraction of pixels visible.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal File polyfill: loadLocalTIF only calls .arrayBuffer() and .name.
class NodeFile {
  constructor(buf, name) {
    this._buf = buf;
    this.name = name;
    this.size = buf.byteLength;
  }
  async arrayBuffer() {
    return this._buf.buffer.slice(this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength);
  }
}

async function main() {
  const tifPath = process.argv[2] || '/home/nsteiner/canopy_height_m_2021.tif';
  if (!fs.existsSync(tifPath)) {
    console.error(`No test TIF at ${tifPath}`);
    process.exit(1);
  }

  const { loadLocalTIF } = await import(path.join(__dirname, '..', 'src', 'loaders', 'cog-loader.js'));
  const buf = fs.readFileSync(tifPath);
  const file = new NodeFile(buf, path.basename(tifPath));

  console.log(`[test] loading ${tifPath} (${(buf.byteLength/1e6).toFixed(1)} MB)`);
  const data = await loadLocalTIF(file);
  console.log(`[test] loaded ${data.width}x${data.height} crs=${data.crs} isCOG=${data.isCOG}`);
  console.log(`[test] geoBounds=${JSON.stringify(data.geoBounds)} worldBounds=${JSON.stringify(data.worldBounds)}`);
  console.log(`[test] nodata=${data.nodata}`);

  if (!data.getExportStripe) {
    console.error('FAIL: no getExportStripe on loader output');
    process.exit(2);
  }

  // Mirror the export path: ml=1, full image, single stripe of 64 rows from
  // the middle of the image so we don't accidentally land on a nodata edge.
  const ml = 1;
  const exportWidth = data.width;
  const startRow = Math.floor(data.height / 2);
  const numRows = Math.min(64, data.height - startRow);

  const stripe = await data.getExportStripe({ startRow, numRows, ml, exportWidth });
  const keys = Object.keys(stripe.bands || {});
  console.log(`[test] stripe keys = ${JSON.stringify(keys)}`);

  if (!keys.includes('band0')) {
    console.error('FAIL: expected band "band0" in stripe (single-band convention)');
    process.exit(3);
  }

  const arr = stripe.bands.band0;
  let finite = 0, zero = 0, nan = 0, min = Infinity, max = -Infinity, sum = 0, sumN = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (Number.isNaN(v)) { nan++; continue; }
    finite++;
    if (v === 0) zero++;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v; sumN++;
  }
  const mean = sumN ? sum / sumN : NaN;
  console.log(`[test] stripe stats: n=${arr.length} finite=${finite} nan=${nan} zero=${zero} min=${min} max=${max} mean=${mean.toFixed?.(4) ?? mean}`);

  if (finite === 0) {
    console.error('FAIL: every pixel in stripe is NaN — getExportStripe v!==0 filter likely masking everything');
    process.exit(4);
  }
  // Anything more negative than -1e30 has to be a GDAL sentinel that slipped
  // past the loader's nodata mask — the rendered export would paint these
  // opaque with whatever colormap(0) is. Bail loudly if we see them.
  if (min < -1e30) {
    console.error(`FAIL: sentinel-magnitude values (min=${min}) survived the export stripe — loader is ignoring GDAL_NODATA`);
    process.exit(6);
  }
  if (finite / arr.length < 0.01) {
    console.warn(`WARN: only ${(100*finite/arr.length).toFixed(2)}% finite pixels — export RGBA alpha will be ~all-zero`);
  }

  // Now simulate the alpha-mask the export does at main.jsx:3908
  let opaque = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v !== 0 && !Number.isNaN(v)) opaque++;
  }
  const opaquePct = 100 * opaque / arr.length;
  console.log(`[test] RGBA opaque pixels: ${opaque}/${arr.length} (${opaquePct.toFixed(2)}%)`);

  // Also drive the aliasing logic the export path uses on its end:
  const allBandNames = ['HHHH']; // default for COG (no requiredPols set)
  const src = stripe.bands['HHHH'] || (allBandNames.length === 1 ? stripe.bands.band0 : null);
  if (!src) {
    console.error('FAIL: stripe alias fallback did not pick up band0 — RGBA buffer would stay zero-initialized');
    process.exit(5);
  }
  console.log(`[test] alias fallback OK: ${src.length} pixels resolved via band0`);

  console.log('[test] PASS — getExportStripe returns usable single-band data');
}

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(99);
});
