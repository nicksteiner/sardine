/**
 * manifest.js — model plugin manifest schema + validation (W025, schema v2).
 *
 * One manifest shape for every model type — heuristic rules, classical
 * learned heads, ONNX networks, remote endpoints — so they are peers behind
 * a type tag (MONAI Label pattern: GraphCut and DL tasks share one
 * interface). Field names align with STAC MLM v1.5.x (`mlm:*`) so artifacts
 * interoperate with the wider ecosystem (Wherobots BYOM consumes MLM JSON as
 * a runtime descriptor) and with the planned sardine-tuner desktop app,
 * rather than inventing a house format. Execution-specific fields live under
 * `sardine:*`.
 *
 * NAMING: `{file}.sardine.json` is TAKEN (sardine-agent NITF sidecar).
 * Model manifests use the `.sardine-model.json` suffix.
 *
 * Schema v2 (v1 was the pre-research draft — never shipped).
 */

export const SARDINE_MODEL_SCHEMA_VERSION = 2;
export const MODEL_FILE_SUFFIX = '.sardine-model.json';

/** Task taxonomy — Deepness's five types + explicit pixel-classifier and
 *  embedding (the foundation-encoder slot). */
export const TASKS = [
  'pixel-classifier', // per-pixel discrete classes (thresholds, learned heads)
  'segmentation',     // mask proposals (SAM-class; W011 consumes)
  'detection',        // bounding boxes (reserved)
  'regression',       // continuous per-pixel (indices, biophysical retrievals)
  'enhancement',      // raster → raster (despeckle, super-resolution)
  'embedding',        // tile → feature vector (foundation-model encoders)
];

/** Backends are peers — the tag says where/how it runs, not what it is. */
export const BACKENDS = [
  'builtin-heuristic', // declarative rules, in-page, no weights
  'builtin-classical', // parameter-carrying heads (logistic v1), in-page
  'onnx',              // ONNX Runtime Web, lazy-loaded, webgpu→wasm
  'remote',            // sardine-agent / sardine-tuner HTTP endpoint
];

export const STRATEGIES = ['whole', 'tiled'];
export const INTERACTIONS = ['none', 'roi', 'click']; // 'click' reserved for W011

/** Machine-readable input transforms. The runner applies these — backends
 *  receive exactly what the manifest declares. Explicit because silent
 *  preprocessing mismatch is the #1 cross-tool model failure mode. */
export const TRANSFORMS = ['none', 'dB', 'power'];

/**
 * Validate a manifest. Returns {valid, errors[], warnings[]}. Unknown extra
 * fields are preserved and non-fatal (forward compatibility — same policy
 * as annotation-io). Newer schema versions load best-effort with a warning.
 */
export function validateManifest(m) {
  const errors = [];
  const warnings = [];
  const fail = (msg) => errors.push(msg);

  if (!m || typeof m !== 'object') return { valid: false, errors: ['not an object'], warnings };

  const v = m['sardine:model'];
  if (v !== SARDINE_MODEL_SCHEMA_VERSION) {
    if (Number.isFinite(v) && v > SARDINE_MODEL_SCHEMA_VERSION) {
      warnings.push(`schema v${v} is newer than supported v${SARDINE_MODEL_SCHEMA_VERSION}; best-effort load`);
    } else {
      fail(`missing or unsupported "sardine:model" version (want ${SARDINE_MODEL_SCHEMA_VERSION})`);
    }
  }
  if (!m.id || typeof m.id !== 'string') fail('missing id');
  if (!m['mlm:name'] || typeof m['mlm:name'] !== 'string') fail('missing mlm:name');
  if (!Array.isArray(m['mlm:tasks']) || !m['mlm:tasks'].length) fail('mlm:tasks[] required');
  else for (const t of m['mlm:tasks']) if (!TASKS.includes(t)) fail(`unknown task "${t}"`);

  const backend = m['sardine:backend'];
  if (!BACKENDS.includes(backend)) fail(`sardine:backend must be one of ${BACKENDS.join(', ')}`);

  const strategy = m['sardine:strategy'] ?? 'whole';
  if (!STRATEGIES.includes(strategy)) fail(`sardine:strategy must be one of ${STRATEGIES.join(', ')}`);
  const interaction = m['sardine:interaction'] ?? 'none';
  if (!INTERACTIONS.includes(interaction)) fail(`sardine:interaction must be one of ${INTERACTIONS.join(', ')}`);

  // Input spec — at least one input with bands + explicit transform
  const inputs = m['mlm:input'];
  if (!Array.isArray(inputs) || !inputs.length) {
    fail('mlm:input[] required');
  } else {
    const inp = inputs[0];
    if (!Array.isArray(inp.bands) || !inp.bands.length) fail('mlm:input[0].bands[] required');
    const expr = inp.pre_processing_function?.expression ?? 'none';
    if (inp.pre_processing_function && inp.pre_processing_function.format !== 'sardine-transform') {
      warnings.push(`unrecognized pre_processing_function.format "${inp.pre_processing_function.format}" — treated as opaque; transform falls back to "none"`);
    } else if (!TRANSFORMS.includes(expr)) {
      fail(`pre_processing_function.expression must be one of ${TRANSFORMS.join(', ')}`);
    }
  }

  // Output spec — pixel-classifier outputs need a class table
  const outputs = m['mlm:output'];
  if (!Array.isArray(outputs) || !outputs.length) {
    fail('mlm:output[] required');
  } else if (m['mlm:tasks']?.includes('pixel-classifier')) {
    const classes = outputs[0]['classification:classes'];
    if (!Array.isArray(classes) || classes.length < 2) {
      fail('pixel-classifier output requires classification:classes (≥2)');
    }
  }

  // Backend-specific requirements
  if (backend === 'builtin-heuristic') {
    const rules = m['sardine:params']?.rules;
    if (!Array.isArray(rules) || !rules.length) fail('builtin-heuristic requires sardine:params.rules[]');
    else for (const r of rules) {
      if (!Number.isInteger(r.band)) fail('heuristic rule missing integer band index');
      if (!['<', '<=', '>', '>=', 'between'].includes(r.op)) fail(`heuristic rule op "${r.op}" unknown`);
      if (r.op === 'between'
        ? !(Array.isArray(r.value) && r.value.length === 2 && r.value.every(Number.isFinite))
        : !Number.isFinite(r.value)) fail('heuristic rule value invalid');
      if (!Number.isInteger(r.class)) fail('heuristic rule missing integer class');
    }
  }
  if (backend === 'builtin-classical') {
    const p = m['sardine:params'];
    if (!p || !Array.isArray(p.weights) || !Array.isArray(p.mean) || !Array.isArray(p.std)) {
      fail('builtin-classical requires sardine:params.{weights,mean,std}');
    } else {
      const C = outputs?.[0]?.['classification:classes']?.length ?? 0;
      const f = inputs?.[0]?.bands?.length ?? 0;
      if (C >= 2 && f >= 1 && p.weights.length !== C * (f + 1)) {
        fail(`weights length ${p.weights.length} ≠ classes×(bands+1) = ${C * (f + 1)}`);
      }
    }
  }
  if (backend === 'onnx') {
    const arts = m['mlm:artifacts'];
    const hasHref = Array.isArray(arts) && arts.some(a => a?.href);
    const hasInline = typeof m['sardine:params']?.modelBase64 === 'string';
    if (!hasHref && !hasInline) fail('onnx backend requires mlm:artifacts[].href or sardine:params.modelBase64');
    if ((m['sardine:strategy'] ?? 'whole') === 'tiled') {
      const t = m['sardine:tile'];
      if (!t || !Number.isInteger(t.size) || t.size < 32) fail('tiled strategy requires sardine:tile.size ≥ 32');
    }
  }
  if (backend === 'remote' && !m['sardine:endpoint']) fail('remote backend requires sardine:endpoint URL');

  if (!m.license) warnings.push('no license field — required before redistribution');

  return { valid: errors.length === 0, errors, warnings };
}

/** Convenience accessors that apply schema defaults. */
export function manifestDefaults(m) {
  return {
    strategy: m['sardine:strategy'] ?? 'whole',
    interaction: m['sardine:interaction'] ?? 'none',
    transform: (m['mlm:input']?.[0]?.pre_processing_function?.format === 'sardine-transform'
      ? m['mlm:input'][0].pre_processing_function.expression : null) ?? 'none',
    bands: m['mlm:input']?.[0]?.bands ?? [],
    classes: m['mlm:output']?.[0]?.['classification:classes'] ?? null,
    tile: m['sardine:tile'] ?? { size: 256, overlap: 16 },
  };
}

export function serializeManifest(m) {
  return JSON.stringify(m, null, 2);
}

export function deserializeManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch (e) { throw new Error(`not JSON: ${e.message}`); }
  const v = validateManifest(m);
  if (!v.valid) throw new Error(`invalid model manifest: ${v.errors.join('; ')}`);
  return { manifest: m, warnings: v.warnings };
}

/**
 * Import Deepness-style ONNX metadata_props into a manifest skeleton.
 * The Deepness convention embeds JSON-encoded execution metadata in the
 * ONNX file itself (model_type, class_names, tiles_size, tiles_overlap,
 * standardization mean/std). We accept it as an import source; the
 * `.sardine-model.json` manifest remains the source of truth.
 *
 * @param {Object} props — {key: stringValue} from ONNX metadata_props
 * @param {Object} base — partial manifest to merge onto (id, name, artifacts)
 */
export function manifestFromOnnxMetadata(props, base = {}) {
  const parse = (k) => {
    if (props[k] == null) return undefined;
    try { return JSON.parse(props[k]); } catch { return props[k]; }
  };
  const typeMap = {
    Segmentor: 'pixel-classifier', Detector: 'detection', Regressor: 'regression',
    Recognition: 'embedding', Superresolution: 'enhancement',
  };
  const modelType = parse('model_type');
  const classNames = parse('class_names');
  const tilesSize = parse('tiles_size');
  const tilesOverlap = parse('tiles_overlap');
  const task = typeMap[modelType] || 'enhancement';

  const manifest = {
    'sardine:model': SARDINE_MODEL_SCHEMA_VERSION,
    id: base.id || 'imported-onnx-model',
    'mlm:name': base.name || String(modelType || 'Imported ONNX model'),
    'mlm:architecture': 'unknown (imported)',
    'mlm:framework': 'onnx',
    'mlm:tasks': [task],
    'mlm:input': [{
      name: 'bands',
      bands: base.bands || ['UNKNOWN'],
      pre_processing_function: { format: 'sardine-transform', expression: base.transform || 'none' },
    }],
    'mlm:output': [{
      name: 'output',
      tasks: [task],
      ...(task === 'pixel-classifier' && Array.isArray(classNames) ? {
        'classification:classes': classNames.map((name, value) => ({ value, name })),
      } : {}),
    }],
    'mlm:artifacts': base.artifacts || [],
    'sardine:backend': 'onnx',
    'sardine:strategy': Number.isInteger(tilesSize) ? 'tiled' : 'whole',
    ...(Number.isInteger(tilesSize) ? {
      'sardine:tile': { size: tilesSize, overlap: Number.isInteger(tilesOverlap) ? tilesOverlap : 16 },
    } : {}),
    'sardine:interaction': 'none',
    provenance: { imported_from: 'onnx metadata_props (Deepness convention)' },
  };
  return manifest;
}
