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

/** Apply the manifest's declared per-band transform. Input bands from the
 *  loaders are linear power; dB = 10·log10(power), non-positive → NaN. */
export function applyTransform(bands, transform) {
  if (transform === 'none' || transform === 'power') return bands;
  if (transform === 'dB') {
    return bands.map((b) => {
      const out = new Float32Array(b.length);
      for (let i = 0; i < b.length; i++) {
        const v = b[i];
        out[i] = v > 0 ? 10 * Math.log10(v) : NaN;
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
  ];
}
