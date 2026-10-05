#!/usr/bin/env node
/**
 * bench_cog_reader.mjs — W032: geotiff.js windows vs cog-tile-reader on the
 * README hero COGs (Hugging Face, ~500 MB each, CORS + Range).
 *
 * Replays what the viewer does for the hero deep link: open both bands, take
 * the per-band stats sample, fetch the first screen of 256² tiles at the
 * link's zoom, then pan one screen east. Reports wall time, HTTP requests and
 * bytes for each backend. Node has no HTTP cache, so every run is cold; the
 * two backends alternate order across repeats to average out network drift.
 *
 * Run: node test/benchmarks/bench_cog_reader.mjs [--repeats N] [--url A,B]
 */

import '../helpers/dom-parser-shim.mjs';
import { fromUrl } from 'geotiff';
import { openCOGReader } from '../../src/loaders/cog-tile-reader.js';

const HF = 'https://huggingface.co/datasets/nicksteiner/sardine-demo-data/resolve/main/';
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const URLS = argOf('--url', `${HF}pacaya_full_hh.tif,${HF}pacaya_full_hv.tif`).split(',');
const REPEATS = Number(argOf('--repeats', '2'));

// Hero link: c=12233,7038 (pixel-world centre), z=-1.5, 256² tiles.
const ZOOM = -1.5;
const CENTER = [12233, 7038];
const SCREEN = [1400, 900]; // CSS px
const TILE = 256;

// ─── fetch instrumentation ───────────────────────────────────────────────────
const realFetch = globalThis.fetch;
const counters = { requests: 0, bytes: 0 };
globalThis.fetch = async (input, init) => {
  counters.requests++;
  const res = await realFetch(input, init);
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len)) counters.bytes += len;
  return res;
};
const resetCounters = () => { counters.requests = 0; counters.bytes = 0; };

// ─── viewport → base-pixel windows ───────────────────────────────────────────
function screenTiles(center, width, height) {
  const scale = Math.pow(2, ZOOM); // screen px per world (base) px
  const worldW = SCREEN[0] / scale;
  const worldH = SCREEN[1] / scale;
  const tileWorld = TILE / scale;
  const left = center[0] - worldW / 2;
  const top = height - (center[1] + worldH / 2); // world Y up → pixel rows down
  const wins = [];
  for (let ty = Math.floor(top / tileWorld); ty * tileWorld < top + worldH; ty++) {
    for (let tx = Math.floor(left / tileWorld); tx * tileWorld < left + worldW; tx++) {
      const l = Math.max(0, Math.floor(tx * tileWorld));
      const t = Math.max(0, Math.floor(ty * tileWorld));
      const r = Math.min(width, Math.ceil((tx + 1) * tileWorld));
      const b = Math.min(height, Math.ceil((ty + 1) * tileWorld));
      if (r > l && b > t) wins.push([l, t, r, b]);
    }
  }
  return wins;
}

// ─── backends ────────────────────────────────────────────────────────────────
const backends = {
  async 'geotiff.js'(url) {
    const tiff = await fromUrl(url);
    const image = await tiff.getImage();
    const imageCount = await tiff.getImageCount();
    const width = image.getWidth();
    const height = image.getHeight();
    async function readTile([l, t, r, b]) {
      const neededRes = Math.max(r - l, b - t) / TILE;
      let best = 0;
      for (let i = 0; i < imageCount; i++) {
        const ov = await tiff.getImage(i);
        if (width / ov.getWidth() <= neededRes * 1.5) best = i;
      }
      const ov = await tiff.getImage(best);
      const sx = ov.getWidth() / width, sy = ov.getHeight() / height;
      const win = [Math.floor(l * sx), Math.floor(t * sy), Math.min(ov.getWidth(), Math.ceil(r * sx)), Math.min(ov.getHeight(), Math.ceil(b * sy))];
      const rasters = await ov.readRasters({ window: win, width: TILE, height: TILE, resampleMethod: 'bilinear' });
      return rasters[0];
    }
    return { width, height, readTile };
  },
  async 'cog-tile-reader'(url) {
    const reader = await openCOGReader(url);
    return { width: reader.width, height: reader.height, readTile: (w) => reader.readTile(w, TILE, 'bilinear') };
  },
};

// ─── scenario ────────────────────────────────────────────────────────────────
async function scenario(open) {
  const marks = {};
  const t0 = performance.now();
  const bands = await Promise.all(URLS.map(open));
  marks.open = performance.now() - t0;
  const { width, height } = bands[0];

  // Stats sample: one full-extent tile per band (coarsest overview).
  await Promise.all(bands.map((b) => b.readTile([0, 0, width, height])));
  marks.stats = performance.now() - t0;

  const first = screenTiles(CENTER, width, height);
  await Promise.all(first.flatMap((w) => bands.map((b) => b.readTile(w))));
  marks.firstScreen = performance.now() - t0;
  const firstReq = counters.requests, firstBytes = counters.bytes;

  const panned = screenTiles([CENTER[0] + SCREEN[0] / Math.pow(2, ZOOM), CENTER[1]], width, height);
  await Promise.all(panned.flatMap((w) => bands.map((b) => b.readTile(w))));
  marks.pan = performance.now() - t0;

  return { marks, tiles: first.length, firstReq, firstBytes, requests: counters.requests, bytes: counters.bytes };
}

// ─── run ─────────────────────────────────────────────────────────────────────
const names = Object.keys(backends);
const results = Object.fromEntries(names.map((n) => [n, []]));
for (let rep = 0; rep < REPEATS; rep++) {
  const order = rep % 2 ? [...names].reverse() : names;
  for (const name of order) {
    resetCounters();
    try {
      results[name].push(await scenario(backends[name]));
    } catch (e) {
      console.error(`${name}: ${e.message}`);
      results[name].push(null);
    }
  }
}

const fmtMs = (v) => `${(v / 1000).toFixed(2)} s`;
const fmtMB = (v) => `${(v / 1e6).toFixed(1)} MB`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

console.log(`\nHero COG pair, ${REPEATS} cold run(s) each, screen ${SCREEN.join('×')} @ z=${ZOOM}\n`);
console.log('backend            open     stats    first screen  (req / bytes)      pan      total req / bytes');
for (const name of names) {
  const ok = results[name].filter(Boolean);
  if (!ok.length) { console.log(`${name.padEnd(18)} failed`); continue; }
  const m = (k) => median(ok.map((r) => r.marks[k]));
  console.log(
    `${name.padEnd(18)} ${fmtMs(m('open')).padEnd(8)} ${fmtMs(m('stats')).padEnd(8)} ${fmtMs(m('firstScreen')).padEnd(13)} ` +
    `(${median(ok.map((r) => r.firstReq))} / ${fmtMB(median(ok.map((r) => r.firstBytes)))})`.padEnd(19) +
    `${fmtMs(m('pan')).padEnd(8)} ${median(ok.map((r) => r.requests))} / ${fmtMB(median(ok.map((r) => r.bytes)))}`,
  );
}
console.log(`\n(${results[names[0]][0]?.tiles ?? '?'} viewport tiles × ${URLS.length} bands per screen; decode on the main thread in Node — the browser adds the worker pool for the new reader only)`);
