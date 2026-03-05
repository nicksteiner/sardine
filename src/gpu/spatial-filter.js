/**
 * GPU speckle filters via WebGPU compute shaders.
 *
 * Supported filter types:
 *   - boxcar:     NxN mean filter in power domain
 *   - lee:        Lee adaptive filter (local mean + variance)
 *   - enhanced-lee: Lee with Cv thresholding (3 regimes)
 *   - frost:      Exponentially distance-weighted adaptive filter
 *   - gamma-map:  Gamma Maximum A Posteriori (Gamma-distributed intensity)
 *
 * All filters operate on linear power values (not dB).
 * NaN and zero are treated as no-data and excluded from kernels.
 *
 * Usage:
 *   import { applySpeckleFilter } from './gpu/spatial-filter.js';
 *   const filtered = await applySpeckleFilter(data, width, height, {
 *     type: 'lee',
 *     kernelSize: 7,
 *     enl: 4,
 *   });
 */

import { getDevice, hasWebGPU } from './webgpu-device.js';

const WORKGROUP_X = 16;
const WORKGROUP_Y = 16;

// ── WGSL Shaders ────────────────────────────────────────────────────────────

/**
 * Generate the shared WGSL preamble with tiled loading.
 * Each workgroup loads a (WG + 2*halfK) × (WG + 2*halfK) tile into shared memory,
 * including halo pixels needed for the kernel window.
 */
function shaderPreamble(halfK) {
  const tileW = WORKGROUP_X + 2 * halfK;
  const tileH = WORKGROUP_Y + 2 * halfK;
  const tileSize = tileW * tileH;
  return /* wgsl */ `

struct Params {
  width: u32,
  height: u32,
  halfK: u32,
  enl: f32,          // equivalent number of looks
  damping: f32,      // Frost damping factor
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<storage, read> inputData: array<f32>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read_write> outputData: array<f32>;

const TILE_W: u32 = ${tileW}u;
const TILE_H: u32 = ${tileH}u;
const TILE_SIZE: u32 = ${tileSize}u;
const WG_X: u32 = ${WORKGROUP_X}u;
const WG_Y: u32 = ${WORKGROUP_Y}u;
const HALF_K: u32 = ${halfK}u;
const NAN_BITS: u32 = 0x7FC00000u;

var<workgroup> tile: array<f32, ${tileSize}>;

// Load the tile including halo into shared memory.
// Each thread may need to load multiple pixels since tile > workgroup.
fn loadTile(wgBase: vec2u, lid: vec2u) {
  let threadsPerWg = WG_X * WG_Y;
  let linearId = lid.y * WG_X + lid.x;

  for (var i = linearId; i < TILE_SIZE; i += threadsPerWg) {
    let ty = i / TILE_W;
    let tx = i % TILE_W;
    // Map tile coords to global image coords (with halo offset)
    let gx = i32(wgBase.x) + i32(tx) - i32(HALF_K);
    let gy = i32(wgBase.y) + i32(ty) - i32(HALF_K);

    var val = bitcast<f32>(NAN_BITS); // default: NaN (out of bounds / nodata)
    if (gx >= 0 && gx < i32(params.width) && gy >= 0 && gy < i32(params.height)) {
      val = inputData[u32(gy) * params.width + u32(gx)];
      // Treat zero as nodata
      if (val == 0.0) {
        val = bitcast<f32>(NAN_BITS);
      }
    }
    tile[i] = val;
  }
  workgroupBarrier();
}

// Read from shared tile at (tx, ty) in tile coordinates
fn tileAt(tx: u32, ty: u32) -> f32 {
  return tile[ty * TILE_W + tx];
}

// Check if value is valid (not NaN)
fn isValid(v: f32) -> bool {
  return v == v;  // NaN != NaN
}
`;
}

// ── Boxcar (Mean) Filter ─────────────────────────────────────────────────────

function boxcarShader(halfK) {
  return shaderPreamble(halfK) + /* wgsl */ `

@compute @workgroup_size(${WORKGROUP_X}, ${WORKGROUP_Y})
fn filterMain(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let wgBase = vec2u(wid.x * WG_X, wid.y * WG_Y);
  loadTile(wgBase, lid.xy);

  let px = gid.x;
  let py = gid.y;
  if (px >= params.width || py >= params.height) { return; }

  // Center pixel in tile coords
  let cx = lid.x + HALF_K;
  let cy = lid.y + HALF_K;

  let center = tileAt(cx, cy);
  if (!isValid(center)) {
    outputData[py * params.width + px] = 0.0;
    return;
  }

  var sum = 0.0;
  var count = 0.0;
  for (var dy = 0u; dy <= 2u * HALF_K; dy++) {
    for (var dx = 0u; dx <= 2u * HALF_K; dx++) {
      let v = tileAt(cx - HALF_K + dx, cy - HALF_K + dy);
      if (isValid(v)) {
        sum += v;
        count += 1.0;
      }
    }
  }

  outputData[py * params.width + px] = select(center, sum / count, count > 0.0);
}
`;
}

// ── Lee Adaptive Filter ──────────────────────────────────────────────────────

function leeShader(halfK) {
  return shaderPreamble(halfK) + /* wgsl */ `

@compute @workgroup_size(${WORKGROUP_X}, ${WORKGROUP_Y})
fn filterMain(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let wgBase = vec2u(wid.x * WG_X, wid.y * WG_Y);
  loadTile(wgBase, lid.xy);

  let px = gid.x;
  let py = gid.y;
  if (px >= params.width || py >= params.height) { return; }

  let cx = lid.x + HALF_K;
  let cy = lid.y + HALF_K;

  let center = tileAt(cx, cy);
  if (!isValid(center)) {
    outputData[py * params.width + px] = 0.0;
    return;
  }

  // Compute local mean and variance
  var sum = 0.0;
  var sumSq = 0.0;
  var count = 0.0;
  for (var dy = 0u; dy <= 2u * HALF_K; dy++) {
    for (var dx = 0u; dx <= 2u * HALF_K; dx++) {
      let v = tileAt(cx - HALF_K + dx, cy - HALF_K + dy);
      if (isValid(v)) {
        sum += v;
        sumSq += v * v;
        count += 1.0;
      }
    }
  }

  if (count < 2.0) {
    outputData[py * params.width + px] = center;
    return;
  }

  let localMean = sum / count;
  let localVar = max(sumSq / count - localMean * localMean, 0.0);

  // Noise variance from ENL: σ²_noise = mean² / ENL
  let noiseVar = (localMean * localMean) / max(params.enl, 1.0);

  // Lee weight: K = var / (var + noiseVar)
  // When var >> noiseVar: K→1 (keep pixel, likely edge/target)
  // When var ≈ noiseVar: K→0.5 (partial filtering)
  // When var << noiseVar: K→0 (pure mean, homogeneous area)
  let K = select(localVar / (localVar + noiseVar), 0.0, localVar + noiseVar == 0.0);

  // filtered = mean + K * (center - mean)
  let filtered = localMean + K * (center - localMean);
  outputData[py * params.width + px] = max(filtered, 0.0);
}
`;
}

// ── Enhanced Lee Filter ──────────────────────────────────────────────────────

function enhancedLeeShader(halfK) {
  return shaderPreamble(halfK) + /* wgsl */ `

@compute @workgroup_size(${WORKGROUP_X}, ${WORKGROUP_Y})
fn filterMain(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let wgBase = vec2u(wid.x * WG_X, wid.y * WG_Y);
  loadTile(wgBase, lid.xy);

  let px = gid.x;
  let py = gid.y;
  if (px >= params.width || py >= params.height) { return; }

  let cx = lid.x + HALF_K;
  let cy = lid.y + HALF_K;

  let center = tileAt(cx, cy);
  if (!isValid(center)) {
    outputData[py * params.width + px] = 0.0;
    return;
  }

  var sum = 0.0;
  var sumSq = 0.0;
  var count = 0.0;
  for (var dy = 0u; dy <= 2u * HALF_K; dy++) {
    for (var dx = 0u; dx <= 2u * HALF_K; dx++) {
      let v = tileAt(cx - HALF_K + dx, cy - HALF_K + dy);
      if (isValid(v)) {
        sum += v;
        sumSq += v * v;
        count += 1.0;
      }
    }
  }

  if (count < 2.0) {
    outputData[py * params.width + px] = center;
    return;
  }

  let localMean = sum / count;
  let localVar = max(sumSq / count - localMean * localMean, 0.0);

  // Coefficient of variation
  let Cv = select(sqrt(localVar) / localMean, 0.0, localMean <= 0.0);

  // Thresholds from ENL
  let Cu = 1.0 / sqrt(max(params.enl, 1.0));  // noise Cv
  let Cmax = sqrt(2.0) * Cu;                   // max Cv for filtering

  var filtered: f32;
  if (Cv <= Cu) {
    // Homogeneous region: pure mean
    filtered = localMean;
  } else if (Cv >= Cmax) {
    // Heterogeneous / point target: no filtering
    filtered = center;
  } else {
    // Intermediate: standard Lee weighting
    let noiseVar = (localMean * localMean) / max(params.enl, 1.0);
    let K = select(localVar / (localVar + noiseVar), 0.0, localVar + noiseVar == 0.0);
    filtered = localMean + K * (center - localMean);
  }

  outputData[py * params.width + px] = max(filtered, 0.0);
}
`;
}

// ── Frost Filter ─────────────────────────────────────────────────────────────

function frostShader(halfK) {
  return shaderPreamble(halfK) + /* wgsl */ `

@compute @workgroup_size(${WORKGROUP_X}, ${WORKGROUP_Y})
fn filterMain(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let wgBase = vec2u(wid.x * WG_X, wid.y * WG_Y);
  loadTile(wgBase, lid.xy);

  let px = gid.x;
  let py = gid.y;
  if (px >= params.width || py >= params.height) { return; }

  let cx = lid.x + HALF_K;
  let cy = lid.y + HALF_K;

  let center = tileAt(cx, cy);
  if (!isValid(center)) {
    outputData[py * params.width + px] = 0.0;
    return;
  }

  // First pass: local mean and variance for Cv
  var sum = 0.0;
  var sumSq = 0.0;
  var count = 0.0;
  for (var dy = 0u; dy <= 2u * HALF_K; dy++) {
    for (var dx = 0u; dx <= 2u * HALF_K; dx++) {
      let v = tileAt(cx - HALF_K + dx, cy - HALF_K + dy);
      if (isValid(v)) {
        sum += v;
        sumSq += v * v;
        count += 1.0;
      }
    }
  }

  if (count < 2.0) {
    outputData[py * params.width + px] = center;
    return;
  }

  let localMean = sum / count;
  let localVar = max(sumSq / count - localMean * localMean, 0.0);
  let CvSq = select(localVar / (localMean * localMean), 0.0, localMean <= 0.0);

  // Frost: exponentially weighted by distance × Cv²
  // w(r) = exp(-damping × Cv² × r)
  let alpha = params.damping * CvSq;

  var weightedSum = 0.0;
  var weightSum = 0.0;
  for (var dy = 0u; dy <= 2u * HALF_K; dy++) {
    for (var dx = 0u; dx <= 2u * HALF_K; dx++) {
      let v = tileAt(cx - HALF_K + dx, cy - HALF_K + dy);
      if (isValid(v)) {
        let distX = f32(dx) - f32(HALF_K);
        let distY = f32(dy) - f32(HALF_K);
        let dist = sqrt(distX * distX + distY * distY);
        let w = exp(-alpha * dist);
        weightedSum += w * v;
        weightSum += w;
      }
    }
  }

  outputData[py * params.width + px] = select(center, weightedSum / weightSum, weightSum > 0.0);
}
`;
}

// ── Gamma-MAP Filter ─────────────────────────────────────────────────────────
// Maximum A Posteriori filter assuming Gamma-distributed SAR intensity.
// Better theoretical basis than Lee for multi-look data.
// Reference: Lopes et al., "Adaptive Speckle Filters and Scene Heterogeneity" (1990)

function gammaMapShader(halfK) {
  return shaderPreamble(halfK) + /* wgsl */ `

@compute @workgroup_size(${WORKGROUP_X}, ${WORKGROUP_Y})
fn filterMain(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let wgBase = vec2u(wid.x * WG_X, wid.y * WG_Y);
  loadTile(wgBase, lid.xy);

  let px = gid.x;
  let py = gid.y;
  if (px >= params.width || py >= params.height) { return; }

  let cx = lid.x + HALF_K;
  let cy = lid.y + HALF_K;

  let center = tileAt(cx, cy);
  if (!isValid(center)) {
    outputData[py * params.width + px] = 0.0;
    return;
  }

  var sum = 0.0;
  var sumSq = 0.0;
  var count = 0.0;
  for (var dy = 0u; dy <= 2u * HALF_K; dy++) {
    for (var dx = 0u; dx <= 2u * HALF_K; dx++) {
      let v = tileAt(cx - HALF_K + dx, cy - HALF_K + dy);
      if (isValid(v)) {
        sum += v;
        sumSq += v * v;
        count += 1.0;
      }
    }
  }

  if (count < 2.0) {
    outputData[py * params.width + px] = center;
    return;
  }

  let localMean = sum / count;
  let localVar = max(sumSq / count - localMean * localMean, 0.0);

  // Coefficient of variation
  let Cv = select(sqrt(localVar) / localMean, 0.0, localMean <= 0.0);

  // Noise Cv from ENL (for Gamma distribution: Cu = sqrt(1/ENL))
  let ENL = max(params.enl, 1.0);
  let Cu = 1.0 / sqrt(ENL);
  // Maximum Cv threshold: sqrt((2 + 1/ENL) / ENL)
  let Cmax = sqrt((2.0 + 1.0 / ENL) / ENL);

  var filtered: f32;
  if (Cv <= Cu) {
    // Homogeneous: pure mean (speckle dominates)
    filtered = localMean;
  } else if (Cv >= Cmax) {
    // Point target / strong heterogeneity: preserve original
    filtered = center;
  } else {
    // Gamma-MAP solution:
    // filtered = (α - ENL - 1) * mean + sqrt(D) / (2 * α)
    // where α = (1 + Cu²) / (Cv² - Cu²)
    //   and D = mean² * (α - ENL - 1)² + 4 * α * ENL * center * mean
    let CvSq = Cv * Cv;
    let CuSq = Cu * Cu;
    let alpha = (1.0 + CuSq) / max(CvSq - CuSq, 1e-10);

    let A = alpha - ENL - 1.0;
    let discriminant = localMean * localMean * A * A + 4.0 * alpha * ENL * center * localMean;

    if (discriminant < 0.0) {
      // Fallback: use Lee filter when discriminant is negative
      let noiseVar = (localMean * localMean) / ENL;
      let K = select(localVar / (localVar + noiseVar), 0.0, localVar + noiseVar == 0.0);
      filtered = localMean + K * (center - localMean);
    } else {
      filtered = (A * localMean + sqrt(discriminant)) / (2.0 * alpha);
    }
  }

  outputData[py * params.width + px] = max(filtered, 0.0);
}
`;
}

// ── Pipeline Cache ──────────────────────────────────────────────────────────

const _pipelineCache = new Map();  // key: `${filterType}_${halfK}` → pipeline

async function ensurePipeline(device, filterType, halfK) {
  const key = `${filterType}_${halfK}`;
  if (_pipelineCache.has(key)) return _pipelineCache.get(key);

  const shaderGenerators = {
    boxcar: boxcarShader,
    lee: leeShader,
    'enhanced-lee': enhancedLeeShader,
    frost: frostShader,
    'gamma-map': gammaMapShader,
  };

  const gen = shaderGenerators[filterType];
  if (!gen) throw new Error(`Unknown filter type: ${filterType}`);

  const code = gen(halfK);
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code }),
      entryPoint: 'filterMain',
    },
  });

  _pipelineCache.set(key, pipeline);
  return pipeline;
}

// ── CPU Fallback ────────────────────────────────────────────────────────────

function cpuBoxcar(data, width, height, halfK) {
  const out = new Float32Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const center = data[idx];
      if (center === 0 || isNaN(center)) { out[idx] = 0; continue; }
      let sum = 0, count = 0;
      for (let dy = -halfK; dy <= halfK; dy++) {
        for (let dx = -halfK; dx <= halfK; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            const v = data[ny * width + nx];
            if (v > 0 && !isNaN(v)) { sum += v; count++; }
          }
        }
      }
      out[idx] = count > 0 ? sum / count : center;
    }
  }
  return out;
}

function cpuLee(data, width, height, halfK, enl) {
  const out = new Float32Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const center = data[idx];
      if (center === 0 || isNaN(center)) { out[idx] = 0; continue; }
      let sum = 0, sumSq = 0, count = 0;
      for (let dy = -halfK; dy <= halfK; dy++) {
        for (let dx = -halfK; dx <= halfK; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            const v = data[ny * width + nx];
            if (v > 0 && !isNaN(v)) { sum += v; sumSq += v * v; count++; }
          }
        }
      }
      if (count < 2) { out[idx] = center; continue; }
      const mean = sum / count;
      const variance = Math.max(sumSq / count - mean * mean, 0);
      const noiseVar = (mean * mean) / Math.max(enl, 1);
      const denom = variance + noiseVar;
      const K = denom > 0 ? variance / denom : 0;
      out[idx] = Math.max(mean + K * (center - mean), 0);
    }
  }
  return out;
}

function cpuEnhancedLee(data, width, height, halfK, enl) {
  const out = new Float32Array(data.length);
  const Cu = 1 / Math.sqrt(Math.max(enl, 1));
  const Cmax = Math.sqrt(2) * Cu;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const center = data[idx];
      if (center === 0 || isNaN(center)) { out[idx] = 0; continue; }
      let sum = 0, sumSq = 0, count = 0;
      for (let dy = -halfK; dy <= halfK; dy++) {
        for (let dx = -halfK; dx <= halfK; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            const v = data[ny * width + nx];
            if (v > 0 && !isNaN(v)) { sum += v; sumSq += v * v; count++; }
          }
        }
      }
      if (count < 2) { out[idx] = center; continue; }
      const mean = sum / count;
      const variance = Math.max(sumSq / count - mean * mean, 0);
      const Cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
      if (Cv <= Cu) {
        out[idx] = mean;
      } else if (Cv >= Cmax) {
        out[idx] = center;
      } else {
        const noiseVar = (mean * mean) / Math.max(enl, 1);
        const denom = variance + noiseVar;
        const K = denom > 0 ? variance / denom : 0;
        out[idx] = Math.max(mean + K * (center - mean), 0);
      }
    }
  }
  return out;
}

function cpuFrost(data, width, height, halfK, enl, damping) {
  const out = new Float32Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const center = data[idx];
      if (center === 0 || isNaN(center)) { out[idx] = 0; continue; }
      let sum = 0, sumSq = 0, count = 0;
      for (let dy = -halfK; dy <= halfK; dy++) {
        for (let dx = -halfK; dx <= halfK; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            const v = data[ny * width + nx];
            if (v > 0 && !isNaN(v)) { sum += v; sumSq += v * v; count++; }
          }
        }
      }
      if (count < 2) { out[idx] = center; continue; }
      const mean = sum / count;
      const variance = Math.max(sumSq / count - mean * mean, 0);
      const CvSq = mean > 0 ? variance / (mean * mean) : 0;
      const alpha = damping * CvSq;
      let wSum = 0, wTotal = 0;
      for (let dy = -halfK; dy <= halfK; dy++) {
        for (let dx = -halfK; dx <= halfK; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            const v = data[ny * width + nx];
            if (v > 0 && !isNaN(v)) {
              const dist = Math.sqrt(dx * dx + dy * dy);
              const w = Math.exp(-alpha * dist);
              wSum += w * v;
              wTotal += w;
            }
          }
        }
      }
      out[idx] = wTotal > 0 ? wSum / wTotal : center;
    }
  }
  return out;
}

function cpuGammaMap(data, width, height, halfK, enl) {
  const out = new Float32Array(data.length);
  const ENL = Math.max(enl, 1);
  const Cu = 1 / Math.sqrt(ENL);
  const CuSq = Cu * Cu;
  const Cmax = Math.sqrt((2 + 1 / ENL) / ENL);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const center = data[idx];
      if (center === 0 || isNaN(center)) { out[idx] = 0; continue; }
      let sum = 0, sumSq = 0, count = 0;
      for (let dy = -halfK; dy <= halfK; dy++) {
        for (let dx = -halfK; dx <= halfK; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            const v = data[ny * width + nx];
            if (v > 0 && !isNaN(v)) { sum += v; sumSq += v * v; count++; }
          }
        }
      }
      if (count < 2) { out[idx] = center; continue; }
      const mean = sum / count;
      const variance = Math.max(sumSq / count - mean * mean, 0);
      const Cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
      if (Cv <= Cu) {
        out[idx] = mean;
      } else if (Cv >= Cmax) {
        out[idx] = center;
      } else {
        const CvSq = Cv * Cv;
        const alpha = (1 + CuSq) / Math.max(CvSq - CuSq, 1e-10);
        const A = alpha - ENL - 1;
        const discriminant = mean * mean * A * A + 4 * alpha * ENL * center * mean;
        if (discriminant < 0) {
          const noiseVar = (mean * mean) / ENL;
          const denom = variance + noiseVar;
          const K = denom > 0 ? variance / denom : 0;
          out[idx] = Math.max(mean + K * (center - mean), 0);
        } else {
          out[idx] = Math.max((A * mean + Math.sqrt(discriminant)) / (2 * alpha), 0);
        }
      }
    }
  }
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Apply a speckle filter to SAR power data.
 *
 * @param {Float32Array} data   - Input SAR data (linear power, not dB)
 * @param {number} width        - Image width in pixels
 * @param {number} height       - Image height in pixels
 * @param {Object} opts
 * @param {string} opts.type    - Filter type: 'boxcar'|'lee'|'enhanced-lee'|'frost'|'gamma-map'
 * @param {number} opts.kernelSize - Odd integer 3–15 (default 7)
 * @param {number} opts.enl     - Equivalent number of looks (default 4, auto-estimate if 0)
 * @param {number} opts.damping - Frost damping factor (default 1.0)
 * @returns {Promise<Float32Array>} Filtered data (same dimensions)
 */
export async function applySpeckleFilter(data, width, height, {
  type = 'lee',
  kernelSize = 7,
  enl = 4,
  damping = 1.0,
  _forceBackend,  // 'cpu' | 'gpu' — for benchmarking; omit for normal auto-detection
} = {}) {
  // Validate
  const validTypes = ['boxcar', 'lee', 'enhanced-lee', 'frost', 'gamma-map'];
  if (!validTypes.includes(type)) {
    throw new Error(`Unknown filter type '${type}'. Valid: ${validTypes.join(', ')}`);
  }

  // Ensure odd kernel size, clamp to 3–15
  kernelSize = Math.max(3, Math.min(15, kernelSize));
  if (kernelSize % 2 === 0) kernelSize++;
  const halfK = (kernelSize - 1) / 2;

  // Auto-estimate ENL from data if requested
  if (enl <= 0) {
    enl = estimateENL(data, width, height);
  }

  // Ensure Float32Array
  const f32 = data instanceof Float32Array ? data : new Float32Array(data);

  // Force CPU path for benchmarking
  if (_forceBackend === 'cpu') {
    return cpuFallback(f32, width, height, type, halfK, enl, damping);
  }

  // Try GPU path
  if ((_forceBackend === 'gpu' || !_forceBackend) && hasWebGPU() && f32.length > 256) {
    try {
      return await gpuFilter(f32, width, height, type, halfK, enl, damping);
    } catch (err) {
      if (_forceBackend === 'gpu') throw err;  // Don't silently fall back when explicitly requesting GPU
      console.warn('[spatial-filter] GPU filter failed, falling back to CPU:', err.message);
    }
  }

  // CPU fallback
  return cpuFallback(f32, width, height, type, halfK, enl, damping);
}

/**
 * List available filter types with descriptions.
 */
export function getFilterTypes() {
  return [
    { id: 'boxcar', name: 'Boxcar (Mean)', description: 'Simple NxN mean filter. Maximum noise reduction, lowest detail preservation.' },
    { id: 'lee', name: 'Lee', description: 'Adaptive filter using local statistics. Good balance of noise reduction and edge preservation.' },
    { id: 'enhanced-lee', name: 'Enhanced Lee', description: 'Lee with Cv thresholding. Better preservation of point targets and strong scatterers.' },
    { id: 'frost', name: 'Frost', description: 'Exponentially distance-weighted adaptive filter. Smooth interiors with edge preservation.' },
    { id: 'gamma-map', name: 'Gamma-MAP', description: 'Maximum a posteriori with Gamma statistics. Best theoretical basis for multi-look SAR.' },
  ];
}

/**
 * Estimate equivalent number of looks (ENL) from a homogeneous region.
 * ENL = mean² / variance (for a homogeneous area)
 * Uses the central 25% of the image as a rough estimate.
 */
export function estimateENL(data, width, height) {
  const x0 = Math.floor(width * 0.375);
  const x1 = Math.ceil(width * 0.625);
  const y0 = Math.floor(height * 0.375);
  const y1 = Math.ceil(height * 0.625);

  let sum = 0, sumSq = 0, count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = data[y * width + x];
      if (v > 0 && !isNaN(v)) {
        sum += v;
        sumSq += v * v;
        count++;
      }
    }
  }

  if (count < 10) return 4; // fallback default
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  if (variance <= 0 || mean <= 0) return 4;

  // Clamp to reasonable range
  return Math.max(1, Math.min(100, (mean * mean) / variance));
}

// ── GPU Execution ───────────────────────────────────────────────────────────

async function gpuFilter(data, width, height, filterType, halfK, enl, damping) {
  const device = await getDevice();
  const pipeline = await ensurePipeline(device, filterType, halfK);

  // Input buffer
  const inputBuffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(inputBuffer, 0, data);

  // Output buffer
  const outputBuffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // Readback buffer
  const readBuffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // Params: width, height, halfK, enl, damping, pad×3
  const paramsData = new ArrayBuffer(32);
  const paramsU32 = new Uint32Array(paramsData);
  const paramsF32 = new Float32Array(paramsData);
  paramsU32[0] = width;
  paramsU32[1] = height;
  paramsU32[2] = halfK;
  paramsF32[3] = enl;
  paramsF32[4] = damping;
  paramsU32[5] = 0;
  paramsU32[6] = 0;
  paramsU32[7] = 0;

  const paramsBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(paramsBuffer, 0, paramsData);

  // Bind group
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: inputBuffer } },
      { binding: 1, resource: { buffer: paramsBuffer } },
      { binding: 2, resource: { buffer: outputBuffer } },
    ],
  });

  // Dispatch
  const numWgX = Math.ceil(width / WORKGROUP_X);
  const numWgY = Math.ceil(height / WORKGROUP_Y);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(numWgX, numWgY);
  pass.end();
  encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, data.byteLength);
  device.queue.submit([encoder.finish()]);

  // Readback
  await readBuffer.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();

  // Cleanup
  inputBuffer.destroy();
  outputBuffer.destroy();
  readBuffer.destroy();
  paramsBuffer.destroy();

  return result;
}

// ── CPU Dispatch ────────────────────────────────────────────────────────────

function cpuFallback(data, width, height, filterType, halfK, enl, damping) {
  switch (filterType) {
    case 'boxcar':       return cpuBoxcar(data, width, height, halfK);
    case 'lee':          return cpuLee(data, width, height, halfK, enl);
    case 'enhanced-lee': return cpuEnhancedLee(data, width, height, halfK, enl);
    case 'frost':        return cpuFrost(data, width, height, halfK, enl, damping);
    case 'gamma-map':    return cpuGammaMap(data, width, height, halfK, enl);
    default:             return cpuLee(data, width, height, halfK, enl);
  }
}
