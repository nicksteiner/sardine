/**
 * registry.js — lazy declarative model registry + backend dispatch (W025).
 *
 * npe2 lesson: registration indexes capability without executing model
 * code — a manifest in the registry costs nothing until run. Weights load
 * on first run, never at discovery.
 *
 * The registry dispatches on `sardine:backend`; the runner applies the
 * manifest's declared input transform centrally so every backend receives
 * exactly what the manifest promises (explicit normalization is the #1
 * defense against silent cross-tool preprocessing mismatch).
 */

import { validateManifest, manifestDefaults, SARDINE_MODEL_SCHEMA_VERSION } from './manifest.js';
import { assertModelFinite } from './trainer.js';
import { runHeuristic } from './backends/heuristic.js';
import { runClassical } from './backends/classical.js';
import { runOnnx } from './backends/onnx.js';
import { SPECKLE_SMOOTH_DEMO_ONNX_B64 } from './demo/speckle-smooth-demo.onnx.b64.js';
import { toDb } from '../utils/stats.js';

/** Apply the manifest's declared per-band transform. Input bands from the
 *  loaders are linear power; dB = 10·log10(power), non-positive → NaN. */
export function applyTransform(bands, transform) {
  if (transform === 'none' || transform === 'power') return bands;
  if (transform === 'dB') {
    return bands.map((b) => {
      const out = new Float32Array(b.length);
      for (let i = 0; i < b.length; i++) {
        const v = b[i];
        out[i] = v > 0 ? toDb(v, 0) : NaN;
      }
      return out;
    });
  }
  throw new Error(`unknown transform "${transform}"`);
}

/**
 * Execute a model manifest over raw band data.
 *
 * @param {Object} manifest — validated manifest
 * @param {{bands: Float32Array[], width: number, height: number}} input
 *        Raw linear-power bands in manifest band order.
 * @param {Object} [opts] — {signal, onProgress(phase, done, total)}
 * @returns {Promise<{kind, data, width, height, ...}>}
 */
export async function runModel(manifest, input, opts = {}) {
  const v = validateManifest(manifest);
  if (!v.valid) throw new Error(`invalid manifest: ${v.errors.join('; ')}`);
  const d = manifestDefaults(manifest);
  if (input.bands.length !== d.bands.length) {
    throw new Error(`model "${manifest['mlm:name']}" needs ${d.bands.length} band(s) [${d.bands.join(', ')}], got ${input.bands.length}`);
  }

  const transformed = { ...input, bands: applyTransform(input.bands, d.transform) };
  const backend = manifest['sardine:backend'];
  const t0 = performance.now();
  let result;
  switch (backend) {
    case 'builtin-heuristic': result = await runHeuristic(manifest, transformed, opts); break;
    case 'builtin-classical': result = await runClassical(manifest, transformed, opts); break;
    case 'onnx': result = await runOnnx(manifest, transformed, opts); break;
    case 'remote':
      throw new Error(`remote backend not yet available — "${manifest['mlm:name']}" declares endpoint ${manifest['sardine:endpoint']}; sardine-tuner/agent integration is a follow-up work order`);
    default:
      throw new Error(`unknown backend "${backend}"`);
  }
  result.elapsedMs = performance.now() - t0;
  result.manifestId = manifest.id;
  return result;
}

/** Session-scoped registry; persistence is the .sardine-model.json file. */
export function createModelRegistry() {
  const models = new Map();
  const api = {
    register(manifest) {
      const v = validateManifest(manifest);
      if (!v.valid) throw new Error(v.errors.join('; '));
      models.set(manifest.id, manifest);
      return v.warnings;
    },
    get: (id) => models.get(id) || null,
    list: () => Array.from(models.values()),
    remove: (id) => models.delete(id),
  };
  for (const m of builtinManifests()) api.register(m);
  return api;
}

/**
 * Build a `.sardine-model.json` manifest from a trained head
 * (trainer.js output) — schema v2, STAC-MLM-aligned.
 */
export function buildHeadManifest({ name, model, bands, transform = 'dB', classes, metrics, provenance = {}, software = 'SARdine' }) {
  if (bands.length !== model.numFeatures) throw new Error('bands[] must match model.numFeatures');
  if (classes.length !== model.numClasses) throw new Error('classes[] must match model.numClasses');
  assertModelFinite(model, 'buildHeadManifest'); // a manifest must never persist NaN params
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'head';
  return {
    'sardine:model': SARDINE_MODEL_SCHEMA_VERSION,
    id: `${slug}-${model.seed.toString(16)}`,
    'mlm:name': name,
    'mlm:architecture': 'multinomial logistic regression',
    'mlm:framework': 'sardine-builtin',
    'mlm:tasks': ['pixel-classifier'],
    'mlm:input': [{
      name: 'bands',
      bands,
      input: { shape: [-1, bands.length, -1, -1], dim_order: ['batch', 'channel', 'height', 'width'], data_type: 'float32' },
      pre_processing_function: { format: 'sardine-transform', expression: transform },
    }],
    'mlm:output': [{
      name: 'classification',
      tasks: ['pixel-classifier'],
      result: { shape: [-1, 1, -1, -1], data_type: 'uint8' },
      'classification:classes': classes.map((c, i) => ({ value: i, name: c.name, color_hint: (c.color || '#4ec9d4').replace('#', '') })),
    }],
    'mlm:artifacts': [],
    license: 'CC0-1.0',
    created: new Date().toISOString(),
    software,
    'sardine:backend': 'builtin-classical',
    'sardine:strategy': 'whole',
    'sardine:interaction': 'roi',
    'sardine:params': { weights: model.weights, mean: model.mean, std: model.std },
    metrics: metrics ? {
      accuracy: metrics.accuracy, macroF1: metrics.macroF1, meanIoU: metrics.meanIoU,
      perClass: metrics.perClass, confusion: metrics.confusion, nTest: metrics.n,
    } : undefined,
    provenance: { labels: 'scatter-regions', seed: model.seed, ...provenance },
  };
}

/** Built-in demo plugins — one per backend tier. */
export function builtinManifests() {
  return [
    {
      'sardine:model': SARDINE_MODEL_SCHEMA_VERSION,
      id: 'water-threshold-db',
      'mlm:name': 'Water threshold (dB)',
      'mlm:architecture': 'threshold rule',
      'mlm:framework': 'sardine-builtin',
      'mlm:tasks': ['pixel-classifier'],
      'mlm:input': [{
        name: 'bands', bands: ['ACTIVE'],
        pre_processing_function: { format: 'sardine-transform', expression: 'dB' },
      }],
      'mlm:output': [{
        name: 'classification', tasks: ['pixel-classifier'],
        result: { shape: [-1, 1, -1, -1], data_type: 'uint8' },
        'classification:classes': [
          { value: 0, name: 'not water', color_hint: '00000000' },
          { value: 1, name: 'water', color_hint: '4ec9d4' },
        ],
      }],
      'mlm:artifacts': [],
      license: 'CC0-1.0',
      software: 'SARdine',
      'sardine:backend': 'builtin-heuristic',
      'sardine:strategy': 'whole',
      'sardine:interaction': 'roi',
      // Smooth open water is a specular reflector: low backscatter. The
      // -17.5 dB default is the classic HH open-water starting point —
      // adjustable per scene in the UI (wind/incidence dependent).
      'sardine:params': { rules: [{ band: 0, op: '<', value: -17.5, class: 1 }], default: 0 },
      provenance: { method: 'literature default threshold; tune per scene' },
    },
    {
      'sardine:model': SARDINE_MODEL_SCHEMA_VERSION,
      id: 'speckle-smooth-demo',
      'mlm:name': 'Speckle smooth (ONNX demo)',
      'mlm:architecture': '5×5 Gaussian conv (generated demo network)',
      'mlm:framework': 'onnx',
      'mlm:tasks': ['enhancement'],
      'mlm:input': [{
        name: 'bands', bands: ['ACTIVE'],
        input: { shape: [1, 1, -1, -1], dim_order: ['batch', 'channel', 'height', 'width'], data_type: 'float32' },
        pre_processing_function: { format: 'sardine-transform', expression: 'power' },
      }],
      'mlm:output': [{
        name: 'output', tasks: ['enhancement'],
        result: { shape: [1, 1, -1, -1], data_type: 'float32' },
      }],
      'mlm:artifacts': [],
      license: 'CC0-1.0',
      software: 'SARdine (tools/make-demo-onnx.py)',
      'sardine:backend': 'onnx',
      'sardine:strategy': 'tiled',
      'sardine:tile': { size: 256, overlap: 16 },
      'sardine:interaction': 'roi',
      'sardine:params': { modelBase64: SPECKLE_SMOOTH_DEMO_ONNX_B64 },
      provenance: {
        method: 'proof-of-concept: proves lazy ORT load, EP negotiation (webgpu→wasm), tiled execution. Not a trained despeckler — W024 lands that.',
      },
    },
    {
      'sardine:model': SARDINE_MODEL_SCHEMA_VERSION,
      id: 'river-ice-unet-l',
      'mlm:name': 'River ice / open water (L-band U-Net)',
      'mlm:architecture': '4-level U-Net, widths (32,64,128,256), 7.77M params',
      'mlm:framework': 'onnx',
      'mlm:tasks': ['pixel-classifier'],
      'mlm:input': [{
        name: 'bands',
        // Co-pol + cross-pol, in this order. HV carries the ice/water
        // separation (rough ice depolarizes, smooth water does not).
        bands: ['HHHH', 'HVHV'],
        input: { shape: [1, 2, -1, -1], dim_order: ['batch', 'channel', 'height', 'width'], data_type: 'float32' },
        pre_processing_function: { format: 'sardine-transform', expression: 'dB' },
      }],
      'mlm:output': [{
        name: 'logits', tasks: ['pixel-classifier'],
        result: { shape: [1, 3, -1, -1], data_type: 'float32' },
        // Channel order is fixed by training (f_water, f_ice, f_mixed).
        'classification:classes': [
          { value: 0, name: 'open water', color_hint: '2b6cb0' },
          { value: 1, name: 'ice', color_hint: 'e8f4f8' },
          { value: 2, name: 'mixed', color_hint: 'd69e2e' },
        ],
      }],
      'mlm:artifacts': [{ href: '/models/river-ice-unet-l.onnx', type: 'application/octet-stream' }],
      license: 'CC-BY-4.0',
      software: 'SARdine (tools/export_unet_onnx.py)',
      'sardine:backend': 'onnx',
      'sardine:strategy': 'tiled',
      // size MUST stay a multiple of 16: four pooling levels floor-divide
      // the tile, and an odd size makes a skip-connection concat fail
      // ("Non concat axis dimensions must match"). 128 is the training tile.
      'sardine:tile': { size: 128, overlap: 16 },
      'sardine:interaction': 'roi',
      provenance: {
        method: 'Trained on PlanetScope-derived dense ice/water labels over Alaska rivers, 2026 breakup; soft 3-class cross-entropy weighted by river-surface validity. Spatial-block split (~25 km) so val/test never share a block with train.',
        trained_on: 'NISAR L2 GCOV HH/HV, 10 m, Alaska breakup 2026',
        checkpoint: 'planet_training/models/unet (30 epochs)',
        metrics: { pixel_acc_confident: 0.923, tile_ice_vs_open_auc: 0.986, tile_ice_mae: 0.059, photo_auc_test_blocks: 0.819 },
        // Standardization (dB mean/std), the finite-data mask channel and
        // the NaN fill are COMPILED INTO the graph, not carried as manifest
        // numbers — the manifest transform vocabulary stops at 'dB', and a
        // silent normalization mismatch is an unreadable failure. Feed the
        // graph two dB bands; it builds its own third channel.
        preprocessing: 'mean/std + validity mask baked into the ONNX graph (see tools/export_unet_onnx.py)',
        caveat: 'L-band HH/HV at 10-30 m. Does not transfer to C-band or X-band (Capella/ICEYE) imagery.',
      },
    },
  ];
}
