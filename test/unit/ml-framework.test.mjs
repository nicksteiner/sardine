/**
 * W025 — model plugin framework tests: manifest validation, heuristic and
 * classical backends through the registry runner, trained-head manifest
 * round-trip, transform application, Deepness metadata_props import.
 *
 * Run with:  node test/unit/ml-framework.test.mjs
 *      or:  node --test test/unit/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateManifest, deserializeManifest, serializeManifest,
  manifestFromOnnxMetadata, SARDINE_MODEL_SCHEMA_VERSION,
} from '../../src/ml/manifest.js';
import {
  runModel, applyTransform, createModelRegistry, buildHeadManifest, builtinManifests,
} from '../../src/ml/registry.js';
import { trainLogistic, evaluateModel, mulberry32, predictLogistic as predictLogisticImport } from '../../src/ml/trainer.js';
import { datasetFromClassRegions, stratifiedSplit } from '../../src/ml/dataset.js';

// ── fixtures ────────────────────────────────────────────────────────

const WATER = builtinManifests().find(m => m.id === 'water-threshold-db');

/** Two-band synthetic scene: left half "water" (low power), right half
 *  "land" (high power), in LINEAR POWER as the loaders provide. */
function syntheticScene(w = 32, h = 16) {
  const b0 = new Float32Array(w * h);
  const b1 = new Float32Array(w * h);
  const rand = mulberry32(42);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const water = x < w / 2;
      // water ~ -22 dB, land ~ -8 dB, ±1.5 dB noise
      const db0 = (water ? -22 : -8) + (rand() - 0.5) * 3;
      const db1 = (water ? -25 : -12) + (rand() - 0.5) * 3;
      b0[i] = Math.pow(10, db0 / 10);
      b1[i] = Math.pow(10, db1 / 10);
    }
  }
  return { b0, b1, w, h };
}

// ── manifest validation ─────────────────────────────────────────────

test('builtin manifests validate cleanly', () => {
  for (const m of builtinManifests()) {
    const v = validateManifest(m);
    assert.deepEqual(v.errors, [], `${m.id}: ${v.errors}`);
    assert.equal(v.valid, true);
  }
});

test('validation rejects broken manifests with specific errors', () => {
  assert.equal(validateManifest(null).valid, false);
  assert.equal(validateManifest({}).valid, false);

  const bad = JSON.parse(JSON.stringify(WATER));
  bad['mlm:tasks'] = ['sorcery'];
  assert.match(validateManifest(bad).errors.join(' '), /unknown task/);

  const bad2 = JSON.parse(JSON.stringify(WATER));
  bad2['sardine:params'].rules[0].op = '~=';
  assert.match(validateManifest(bad2).errors.join(' '), /op "~=" unknown/);

  const bad3 = JSON.parse(JSON.stringify(WATER));
  bad3['mlm:output'][0]['classification:classes'] = [{ value: 0, name: 'only-one' }];
  assert.match(validateManifest(bad3).errors.join(' '), /classification:classes/);
});

test('newer schema version loads best-effort with a warning', () => {
  const future = JSON.parse(JSON.stringify(WATER));
  future['sardine:model'] = SARDINE_MODEL_SCHEMA_VERSION + 1;
  const v = validateManifest(future);
  assert.equal(v.valid, true);
  assert.match(v.warnings.join(' '), /newer than supported/);
});

test('serialize → deserialize round-trip preserves the manifest', () => {
  const { manifest } = deserializeManifest(serializeManifest(WATER));
  assert.deepEqual(manifest, WATER);
});

// ── transforms ──────────────────────────────────────────────────────

test('applyTransform dB: power→dB with non-positive masked to NaN', () => {
  const [out] = applyTransform([Float32Array.from([1, 0.1, 0, -5])], 'dB');
  assert.equal(out[0], 0);
  assert.ok(Math.abs(out[1] - -10) < 1e-5);
  assert.ok(Number.isNaN(out[2]));
  assert.ok(Number.isNaN(out[3]));
});

// ── heuristic backend via runModel ──────────────────────────────────

test('water threshold heuristic classifies the synthetic scene', async () => {
  const { b0, w, h } = syntheticScene();
  const result = await runModel(WATER, { bands: [b0], width: w, height: h });
  assert.equal(result.kind, 'classmap');
  assert.equal(result.data.length, w * h);
  // Left half water (1), right half not (0) — noise margin is generous
  let wrong = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const expect = x < w / 2 ? 1 : 0;
      if (result.data[y * w + x] !== expect) wrong++;
    }
  }
  assert.equal(wrong, 0, `${wrong} misclassified pixels`);
});

test('heuristic marks invalid (zero-power) pixels as 255', async () => {
  const { b0, w, h } = syntheticScene();
  b0[3] = 0; // nodata
  const result = await runModel(WATER, { bands: [b0], width: w, height: h });
  assert.equal(result.data[3], 255);
});

test('runModel rejects band-count mismatch', async () => {
  const { b0, b1, w, h } = syntheticScene();
  await assert.rejects(
    () => runModel(WATER, { bands: [b0, b1], width: w, height: h }),
    /needs 1 band/,
  );
});

// ── train → head manifest → classical backend round-trip ───────────

test('trained head round-trips through manifest and matches direct predictions', async () => {
  const { b0, b1, w, h } = syntheticScene(64, 32);
  // labels: left = class 1 (water), right = class 0
  const classifierData = {
    x: applyTransform([b0], 'dB')[0],
    y: applyTransform([b1], 'dB')[0],
    valid: new Uint8Array(w * h).fill(1),
    w, h,
  };
  const regions = [
    { name: 'land', color: '#8a6d3b', xMin: -14, xMax: 0, yMin: -18, yMax: 0 },
    { name: 'water', color: '#4ec9d4', xMin: -30, xMax: -16, yMin: -32, yMax: -19 },
  ];
  const ds = datasetFromClassRegions(classifierData, regions, { seed: 7 });
  const { train, test: testSet } = stratifiedSplit(
    { ...ds, numFeatures: 2, numClasses: 2 }, { testFraction: 0.25, seed: 7 });

  const model = trainLogistic({
    X: train.X, y: train.y, numClasses: 2, numFeatures: 2, seed: 7, epochs: 40,
  });
  const metrics = evaluateModel(model, testSet.X, testSet.y, testSet.n);
  assert.ok(metrics.accuracy >= 0.95, `test accuracy ${metrics.accuracy} < 0.95`);

  const manifest = buildHeadManifest({
    name: 'test flood head', model,
    bands: ['HHHH', 'HVHV'], transform: 'dB',
    classes: regions.map(r => ({ name: r.name, color: r.color })),
    metrics,
  });
  const v = validateManifest(manifest);
  assert.deepEqual(v.errors, []);

  // Run through the registry (raw power in, manifest declares dB)
  const result = await runModel(manifest, { bands: [b0, b1], width: w, height: h });
  assert.equal(result.kind, 'classmap');
  assert.ok(result.confidence instanceof Float32Array);

  // Determinism: same seed → identical weights
  const model2 = trainLogistic({
    X: train.X, y: train.y, numClasses: 2, numFeatures: 2, seed: 7, epochs: 40,
  });
  assert.deepEqual(model.weights, model2.weights);

  // Serialize → reload → identical predictions
  const { manifest: reloaded } = deserializeManifest(serializeManifest(manifest));
  const result2 = await runModel(reloaded, { bands: [b0, b1], width: w, height: h });
  assert.deepEqual(Array.from(result2.data), Array.from(result.data));
});

// ── registry ────────────────────────────────────────────────────────

test('registry registers builtins lazily and accepts new manifests', () => {
  const reg = createModelRegistry();
  const ids = reg.list().map(m => m.id);
  assert.ok(ids.includes('water-threshold-db'));
  assert.ok(ids.includes('speckle-smooth-demo'));

  assert.throws(() => reg.register({ id: 'nope' }), /mlm:name|sardine:model/);
  const clone = { ...WATER, id: 'water-2' };
  reg.register(clone);
  assert.equal(reg.get('water-2').id, 'water-2');
  reg.remove('water-2');
  assert.equal(reg.get('water-2'), null);
});

test('remote backend fails with actionable guidance', async () => {
  const remote = {
    ...JSON.parse(JSON.stringify(WATER)),
    id: 'remote-test',
    'sardine:backend': 'remote',
    'sardine:endpoint': 'http://localhost:8642/models/flood',
  };
  delete remote['sardine:params'];
  const { b0, w, h } = syntheticScene();
  await assert.rejects(
    () => runModel(remote, { bands: [b0], width: w, height: h }),
    /sardine-tuner\/agent/,
  );
});

// ── NaN-poisoning defenses (W025 bug report, 2026-07-13) ────────────

test('training on data with one non-finite sample fails loudly', () => {
  const X = Float32Array.from([1, 2, 3, NaN, 5, 6, 7, 8]); // 4 samples × 2f
  const y = Uint8Array.from([0, 1, 0, 1]);
  assert.throws(
    () => trainLogistic({ X, y, numClasses: 2, numFeatures: 2 }),
    /non-finite feature \(sample 1, feature 1/,
  );
  const Xinf = Float32Array.from([1, 2, Infinity, 4]);
  assert.throws(
    () => trainLogistic({ X: Xinf, y: Uint8Array.from([0, 1]), numClasses: 2, numFeatures: 2 }),
    /non-finite feature/,
  );
});

test('predict refuses a NaN-poisoned model', () => {
  const model = {
    weights: [0.5, -0.5, 0, 0.1, 0.2, 0], mean: [NaN, 0], std: [1, 1],
    numClasses: 2, numFeatures: 2,
  };
  assert.throws(
    () => predictLogisticImport(model, Float32Array.from([1, 2]), 1),
    /non-finite mean\[0\].*NaN-poisoned/,
  );
});

test('validateManifest refuses non-finite classical params (incl. JSON null)', () => {
  const { b0, b1, w, h } = syntheticScene(64, 32);
  void b1; void w; void h; void b0;
  const good = builtinManifests().find(m => m.id === 'water-threshold-db');
  const m = JSON.parse(JSON.stringify(good));
  m.id = 'poisoned';
  m['sardine:backend'] = 'builtin-classical';
  delete m['sardine:params'];
  m['sardine:params'] = { weights: [0, 0, 0, 0], mean: [null, 0], std: [1, 1] }; // NaN → null via JSON
  const v = validateManifest(m);
  assert.equal(v.valid, false);
  assert.match(v.errors.join(' '), /non-finite params\.mean\[0\].*NaN-poisoned/);
});

test('buildHeadManifest refuses to persist non-finite params', () => {
  const model = {
    weights: [0.1, 0.2, 0.3, 0.4, 0.5, NaN], mean: [0, 0], std: [1, 1],
    numClasses: 2, numFeatures: 2, seed: 1,
  };
  assert.throws(
    () => buildHeadManifest({
      name: 'bad', model, bands: ['A', 'B'],
      classes: [{ name: 'x' }, { name: 'y' }],
    }),
    /non-finite weights\[5\]/,
  );
});

// ── Deepness metadata_props import ──────────────────────────────────

test('manifestFromOnnxMetadata maps Deepness conventions', () => {
  const m = manifestFromOnnxMetadata({
    model_type: '"Segmentor"',
    class_names: '["background", "water"]',
    tiles_size: '512',
    tiles_overlap: '32',
  }, { id: 'imported', bands: ['HHHH'], transform: 'dB' });
  assert.deepEqual(m['mlm:tasks'], ['pixel-classifier']);
  assert.equal(m['sardine:strategy'], 'tiled');
  assert.deepEqual(m['sardine:tile'], { size: 512, overlap: 32 });
  assert.equal(m['mlm:output'][0]['classification:classes'].length, 2);
  // Import produces a skeleton needing artifacts — invalid until href added
  assert.equal(validateManifest(m).valid, false);
  m['mlm:artifacts'] = [{ href: 'https://example.com/model.onnx' }];
  assert.equal(validateManifest(m).valid, true);
});
