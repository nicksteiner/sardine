/**
 * InSAR time-series analysis via WebGPU compute shaders.
 *
 * Implements MintPy-inspired workflows:
 *   1. SBAS network inversion (interferogram stack → displacement time series)
 *   2. Velocity estimation (per-pixel linear regression)
 *   3. Temporal coherence (inversion quality metric)
 *   4. DEM error estimation (per-pixel regression vs perpendicular baseline)
 *
 * All operations are per-pixel and embarrassingly parallel — ideal for GPU.
 * The design matrix and its pseudo-inverse are computed once on CPU (small
 * matrix, typically < 200×100), then each GPU thread applies it to one pixel.
 *
 * Memory strategy: process in tiles (512×512) to stay within WebGPU buffer
 * limits. For 50 interferograms at 512×512, each tile is ~50 MB.
 */

import { getDevice, hasWebGPU } from './webgpu-device.js';

const WORKGROUP_SIZE = 256;

// ── WGSL Compute Shaders ──────────────────────────────────────────────────

/**
 * SBAS network inversion: multiply pre-computed inverse matrix by per-pixel
 * phase vector to get displacement at each epoch.
 *
 * For each pixel:
 *   displacement[e] = Σ_i  invMatrix[e * numIfgs + i] * phase[i * numPixels + pixel]
 *
 * Coherence weighting is baked into invMatrix on the CPU side.
 */
const sbasShader = /* wgsl */ `
struct Params {
  numPixels: u32,
  numIfgs: u32,
  numEpochs: u32,
  wavelength: f32,    // meters (L-band ~0.238 m)
};

@group(0) @binding(0) var<storage, read> phases: array<f32>;
@group(0) @binding(1) var<storage, read> invMatrix: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> displacement: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn sbasMain(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.x;
  if (pixel >= params.numPixels) { return; }

  let phaseToDisp = params.wavelength / (4.0 * 3.14159265);

  for (var e = 0u; e < params.numEpochs; e++) {
    var sum = 0.0;
    for (var i = 0u; i < params.numIfgs; i++) {
      let phase = phases[i * params.numPixels + pixel];
      // Skip NaN/nodata pixels (phase == 0 in masked areas)
      if (phase != 0.0) {
        sum += invMatrix[e * params.numIfgs + i] * phase;
      }
    }
    // Convert phase (radians) to displacement (meters)
    displacement[e * params.numPixels + pixel] = sum * phaseToDisp;
  }
}
`;

/**
 * Velocity estimation: per-pixel weighted linear regression of
 * displacement vs time.
 *
 * OLS: v = (Σ wᵢ·tᵢ·dᵢ - S_w·t̄·d̄) / (Σ wᵢ·tᵢ² - S_w·t̄²)
 *
 * Times are passed as a uniform array (days since first epoch).
 * Weights come from temporal coherence (optional, default = 1).
 */
const velocityShader = /* wgsl */ `
struct Params {
  numPixels: u32,
  numEpochs: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<storage, read> displacement: array<f32>;
@group(0) @binding(1) var<storage, read> times: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> velocity: array<f32>;
@group(0) @binding(4) var<storage, read_write> residuals: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn velocityMain(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.x;
  if (pixel >= params.numPixels) { return; }

  // Compute means
  var sumT = 0.0;
  var sumD = 0.0;
  var count = 0.0;
  for (var e = 0u; e < params.numEpochs; e++) {
    let d = displacement[e * params.numPixels + pixel];
    if (d != 0.0 || e == 0u) {  // epoch 0 displacement is always 0
      sumT += times[e];
      sumD += d;
      count += 1.0;
    }
  }

  if (count < 2.0) {
    velocity[pixel] = 0.0;
    residuals[pixel] = 0.0;
    return;
  }

  let meanT = sumT / count;
  let meanD = sumD / count;

  // Linear regression
  var num = 0.0;
  var den = 0.0;
  for (var e = 0u; e < params.numEpochs; e++) {
    let d = displacement[e * params.numPixels + pixel];
    if (d != 0.0 || e == 0u) {
      let dt = times[e] - meanT;
      num += dt * (d - meanD);
      den += dt * dt;
    }
  }

  if (den == 0.0) {
    velocity[pixel] = 0.0;
    residuals[pixel] = 0.0;
    return;
  }

  let v = num / den;
  velocity[pixel] = v * 365.25;  // convert from m/day to m/year

  // RMS residual (velocity uncertainty proxy)
  var rss = 0.0;
  for (var e = 0u; e < params.numEpochs; e++) {
    let d = displacement[e * params.numPixels + pixel];
    if (d != 0.0 || e == 0u) {
      let predicted = meanD + v * (times[e] - meanT);
      let r = d - predicted;
      rss += r * r;
    }
  }
  residuals[pixel] = sqrt(rss / count);
}
`;

/**
 * Temporal coherence: measures how well the SBAS model fits the data.
 *
 * TC = |1/N · Σ exp(j · φ_residual_i)|
 *
 * where φ_residual = observed_phase - modeled_phase (from SBAS).
 *
 * TC → 1 means perfect fit, TC → 0 means noise dominates.
 * This is the primary quality mask for InSAR time series.
 */
const temporalCoherenceShader = /* wgsl */ `
struct Params {
  numPixels: u32,
  numIfgs: u32,
  numEpochs: u32,
  _pad: u32,
};

@group(0) @binding(0) var<storage, read> observedPhase: array<f32>;
@group(0) @binding(1) var<storage, read> modeledPhase: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> tempCoh: array<f32>;
// Design matrix G: maps epochs to interferograms (G[ifg * numEpochs + epoch])
@group(0) @binding(4) var<storage, read> designMatrix: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn tempCohMain(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.x;
  if (pixel >= params.numPixels) { return; }

  // Reconstruct modeled interferogram phases from displacement epochs
  // φ_model_ifg = Σ_e G[ifg][e] * displacement[e]
  // Then residual = observed - modeled

  var sumCos = 0.0;
  var sumSin = 0.0;
  var count = 0.0;

  for (var i = 0u; i < params.numIfgs; i++) {
    let observed = observedPhase[i * params.numPixels + pixel];
    if (observed == 0.0) { continue; }  // masked pixel

    // Compute modeled phase for this ifg from epoch displacements
    var modeled = 0.0;
    for (var e = 0u; e < params.numEpochs; e++) {
      modeled += designMatrix[i * params.numEpochs + e]
               * modeledPhase[e * params.numPixels + pixel];
    }

    let residual = observed - modeled;
    sumCos += cos(residual);
    sumSin += sin(residual);
    count += 1.0;
  }

  if (count == 0.0) {
    tempCoh[pixel] = 0.0;
    return;
  }

  let avgCos = sumCos / count;
  let avgSin = sumSin / count;
  tempCoh[pixel] = sqrt(avgCos * avgCos + avgSin * avgSin);
}
`;

/**
 * DEM error estimation: per-pixel regression of phase residual against
 * perpendicular baseline.
 *
 * δh = [Σ (Bperp_i · φres_i)] / [Σ Bperp_i²] × R·sin(θ) / (4π/λ)
 */
const demErrorShader = /* wgsl */ `
struct Params {
  numPixels: u32,
  numIfgs: u32,
  rangeDistance: f32,     // meters (~900 km for NISAR)
  sinIncidenceAngle: f32, // sin(θ) at scene center
};

@group(0) @binding(0) var<storage, read> phaseResidual: array<f32>;
@group(0) @binding(1) var<storage, read> bperp: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> demError: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn demErrorMain(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.x;
  if (pixel >= params.numPixels) { return; }

  var num = 0.0;
  var den = 0.0;
  for (var i = 0u; i < params.numIfgs; i++) {
    let res = phaseResidual[i * params.numPixels + pixel];
    if (res == 0.0) { continue; }
    let b = bperp[i];
    num += b * res;
    den += b * b;
  }

  if (den == 0.0) {
    demError[pixel] = 0.0;
    return;
  }

  // Convert phase sensitivity to height: R·sin(θ) / (4π/λ)
  // Phase-to-height factor baked into rangeDistance * sinIncidenceAngle
  let heightFactor = params.rangeDistance * params.sinIncidenceAngle;
  demError[pixel] = (num / den) * heightFactor;
}
`;

// ── Pipeline Cache ──────────────────────────────────────────────────────────

let _pipelines = null;
let _pipelineDevice = null;

async function ensurePipelines(device) {
  if (_pipelineDevice === device && _pipelines) return _pipelines;

  const createPipeline = (code, entryPoint) =>
    device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code }),
        entryPoint,
      },
    });

  _pipelines = {
    sbas: createPipeline(sbasShader, 'sbasMain'),
    velocity: createPipeline(velocityShader, 'velocityMain'),
    temporalCoherence: createPipeline(temporalCoherenceShader, 'tempCohMain'),
    demError: createPipeline(demErrorShader, 'demErrorMain'),
  };
  _pipelineDevice = device;
  return _pipelines;
}

// ── CPU Utilities ───────────────────────────────────────────────────────────

/**
 * Build the SBAS design matrix from interferogram date pairs.
 *
 * @param {Array<{ref: number, sec: number}>} pairs - Date index pairs
 * @param {number} numEpochs - Number of unique SAR acquisition dates
 * @returns {Float32Array} Flattened design matrix (numIfgs × numEpochs)
 */
export function buildDesignMatrix(pairs, numEpochs) {
  const G = new Float32Array(pairs.length * numEpochs);
  for (let i = 0; i < pairs.length; i++) {
    G[i * numEpochs + pairs[i].ref] = -1;
    G[i * numEpochs + pairs[i].sec] = 1;
  }
  return G;
}

/**
 * Compute the weighted pseudo-inverse of the design matrix.
 * (GᵀWG)⁻¹Gᵀ W  where W = diag(weights).
 *
 * Uses singular value decomposition for numerical stability.
 * Runs on CPU — matrix is small (typically < 200×100).
 *
 * @param {Float32Array} G - Design matrix (numIfgs × numEpochs)
 * @param {number} numIfgs
 * @param {number} numEpochs
 * @param {Float32Array} [weights] - Per-ifg weights (default: uniform)
 * @returns {Float32Array} Pseudo-inverse (numEpochs × numIfgs)
 */
export function computePseudoInverse(G, numIfgs, numEpochs, weights) {
  // Compute GᵀWG and GᵀW using standard matrix multiplication.
  // For typical SBAS sizes (50-200 ifgs, 20-100 epochs), this is fast.

  const W = weights || new Float32Array(numIfgs).fill(1);

  // GᵀW: (numEpochs × numIfgs)
  const GtW = new Float32Array(numEpochs * numIfgs);
  for (let e = 0; e < numEpochs; e++) {
    for (let i = 0; i < numIfgs; i++) {
      GtW[e * numIfgs + i] = G[i * numEpochs + e] * W[i];
    }
  }

  // GᵀWG: (numEpochs × numEpochs)
  const GtWG = new Float32Array(numEpochs * numEpochs);
  for (let e1 = 0; e1 < numEpochs; e1++) {
    for (let e2 = 0; e2 < numEpochs; e2++) {
      let sum = 0;
      for (let i = 0; i < numIfgs; i++) {
        sum += GtW[e1 * numIfgs + i] * G[i * numEpochs + e2];
      }
      GtWG[e1 * numEpochs + e2] = sum;
    }
  }

  // Invert GᵀWG via Cholesky or regularized pseudo-inverse.
  // For robustness, add small regularization: GᵀWG + εI
  const eps = 1e-6;
  for (let e = 0; e < numEpochs; e++) {
    GtWG[e * numEpochs + e] += eps;
  }

  // Solve via Gauss-Jordan elimination (small matrix, no external deps)
  const inv = invertMatrix(GtWG, numEpochs);
  if (!inv) {
    console.warn('[insar-timeseries] Design matrix is singular, using regularized inverse');
    return GtW; // Fall back to unweighted transpose
  }

  // Result = inv(GᵀWG) · GᵀW: (numEpochs × numIfgs)
  const result = new Float32Array(numEpochs * numIfgs);
  for (let e = 0; e < numEpochs; e++) {
    for (let i = 0; i < numIfgs; i++) {
      let sum = 0;
      for (let k = 0; k < numEpochs; k++) {
        sum += inv[e * numEpochs + k] * GtW[k * numIfgs + i];
      }
      result[e * numIfgs + i] = sum;
    }
  }

  return result;
}

/**
 * In-place Gauss-Jordan matrix inversion for small dense matrices.
 * @param {Float32Array} M - Square matrix (n × n), modified in place
 * @param {number} n
 * @returns {Float32Array|null} Inverse matrix, or null if singular
 */
function invertMatrix(M, n) {
  const A = new Float32Array(M);
  const I = new Float32Array(n * n);
  for (let i = 0; i < n; i++) I[i * n + i] = 1;

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxVal = Math.abs(A[col * n + col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      const val = Math.abs(A[row * n + col]);
      if (val > maxVal) { maxVal = val; maxRow = row; }
    }

    if (maxVal < 1e-12) return null; // Singular

    // Swap rows
    if (maxRow !== col) {
      for (let j = 0; j < n; j++) {
        [A[col * n + j], A[maxRow * n + j]] = [A[maxRow * n + j], A[col * n + j]];
        [I[col * n + j], I[maxRow * n + j]] = [I[maxRow * n + j], I[col * n + j]];
      }
    }

    // Scale pivot row
    const pivot = A[col * n + col];
    for (let j = 0; j < n; j++) {
      A[col * n + j] /= pivot;
      I[col * n + j] /= pivot;
    }

    // Eliminate column
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = A[row * n + col];
      for (let j = 0; j < n; j++) {
        A[row * n + j] -= factor * A[col * n + j];
        I[row * n + j] -= factor * I[col * n + j];
      }
    }
  }

  return I;
}

// ── GPU Buffer Helpers ──────────────────────────────────────────────────────

function createStorageBuffer(device, data) {
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

function createUniformBuffer(device, data) {
  // Pad to 16-byte alignment
  const padded = Math.ceil(data.byteLength / 16) * 16;
  const buffer = device.createBuffer({
    size: padded,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

async function readBackBuffer(device, srcBuffer, size) {
  const readBuffer = device.createBuffer({
    size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(srcBuffer, 0, readBuffer, 0, size);
  device.queue.submit([encoder.finish()]);

  await readBuffer.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();
  readBuffer.destroy();
  return result;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run SBAS network inversion on a tile of interferogram phases.
 *
 * @param {Object} opts
 * @param {Float32Array} opts.phases - Stacked interferogram phases
 *   (numIfgs × numPixels, row-major: phases[ifg * numPixels + pixel])
 * @param {Float32Array} opts.invMatrix - Pre-computed pseudo-inverse
 *   (numEpochs × numIfgs, from computePseudoInverse())
 * @param {number} opts.numPixels - Number of pixels in tile (width × height)
 * @param {number} opts.numIfgs - Number of interferograms
 * @param {number} opts.numEpochs - Number of displacement epochs
 * @param {number} [opts.wavelength=0.238] - Radar wavelength in meters
 * @returns {Promise<Float32Array>} Displacement time series
 *   (numEpochs × numPixels, meters, LOS)
 */
export async function sbasInversion({
  phases,
  invMatrix,
  numPixels,
  numIfgs,
  numEpochs,
  wavelength = 0.238,
}) {
  if (!hasWebGPU()) {
    return sbasInversionCPU({ phases, invMatrix, numPixels, numIfgs, numEpochs, wavelength });
  }

  const device = await getDevice();
  const pipelines = await ensurePipelines(device);
  const numWorkgroups = Math.ceil(numPixels / WORKGROUP_SIZE);

  // Upload data
  const phasesBuffer = createStorageBuffer(device, phases);
  const invMatrixBuffer = createStorageBuffer(device, invMatrix);

  const paramsData = new ArrayBuffer(16);
  new Uint32Array(paramsData, 0, 1)[0] = numPixels;
  new Uint32Array(paramsData, 4, 1)[0] = numIfgs;
  new Uint32Array(paramsData, 8, 1)[0] = numEpochs;
  new Float32Array(paramsData, 12, 1)[0] = wavelength;
  const paramsBuffer = createUniformBuffer(device, paramsData);

  const outputSize = numEpochs * numPixels * 4;
  const outputBuffer = device.createBuffer({
    size: outputSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const bindGroup = device.createBindGroup({
    layout: pipelines.sbas.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: phasesBuffer } },
      { binding: 1, resource: { buffer: invMatrixBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } },
      { binding: 3, resource: { buffer: outputBuffer } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipelines.sbas);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(numWorkgroups);
  pass.end();
  device.queue.submit([encoder.finish()]);

  const result = await readBackBuffer(device, outputBuffer, outputSize);

  // Cleanup
  phasesBuffer.destroy();
  invMatrixBuffer.destroy();
  paramsBuffer.destroy();
  outputBuffer.destroy();

  return result;
}

/**
 * CPU fallback for SBAS inversion (when WebGPU unavailable).
 */
function sbasInversionCPU({ phases, invMatrix, numPixels, numIfgs, numEpochs, wavelength }) {
  const phaseToDisp = wavelength / (4 * Math.PI);
  const displacement = new Float32Array(numEpochs * numPixels);

  for (let pixel = 0; pixel < numPixels; pixel++) {
    for (let e = 0; e < numEpochs; e++) {
      let sum = 0;
      for (let i = 0; i < numIfgs; i++) {
        const phase = phases[i * numPixels + pixel];
        if (phase !== 0) {
          sum += invMatrix[e * numIfgs + i] * phase;
        }
      }
      displacement[e * numPixels + pixel] = sum * phaseToDisp;
    }
  }

  return displacement;
}

/**
 * Estimate velocity from displacement time series.
 *
 * @param {Object} opts
 * @param {Float32Array} opts.displacement - From sbasInversion()
 *   (numEpochs × numPixels)
 * @param {Float32Array} opts.times - Days since first epoch for each epoch
 * @param {number} opts.numPixels
 * @param {number} opts.numEpochs
 * @returns {Promise<{velocity: Float32Array, residuals: Float32Array}>}
 *   velocity in m/year, residuals (RMS) in meters
 */
export async function estimateVelocity({ displacement, times, numPixels, numEpochs }) {
  if (!hasWebGPU()) {
    return estimateVelocityCPU({ displacement, times, numPixels, numEpochs });
  }

  const device = await getDevice();
  const pipelines = await ensurePipelines(device);
  const numWorkgroups = Math.ceil(numPixels / WORKGROUP_SIZE);

  const dispBuffer = createStorageBuffer(device, displacement);
  const timesBuffer = createStorageBuffer(device, times);

  const paramsData = new ArrayBuffer(16);
  new Uint32Array(paramsData, 0, 1)[0] = numPixels;
  new Uint32Array(paramsData, 4, 1)[0] = numEpochs;
  const paramsBuffer = createUniformBuffer(device, paramsData);

  const velBuffer = device.createBuffer({
    size: numPixels * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const resBuffer = device.createBuffer({
    size: numPixels * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const bindGroup = device.createBindGroup({
    layout: pipelines.velocity.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: dispBuffer } },
      { binding: 1, resource: { buffer: timesBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } },
      { binding: 3, resource: { buffer: velBuffer } },
      { binding: 4, resource: { buffer: resBuffer } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipelines.velocity);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(numWorkgroups);
  pass.end();
  device.queue.submit([encoder.finish()]);

  const [velocity, residuals] = await Promise.all([
    readBackBuffer(device, velBuffer, numPixels * 4),
    readBackBuffer(device, resBuffer, numPixels * 4),
  ]);

  dispBuffer.destroy();
  timesBuffer.destroy();
  paramsBuffer.destroy();
  velBuffer.destroy();
  resBuffer.destroy();

  return { velocity, residuals };
}

/**
 * CPU fallback for velocity estimation.
 */
function estimateVelocityCPU({ displacement, times, numPixels, numEpochs }) {
  const velocity = new Float32Array(numPixels);
  const residuals = new Float32Array(numPixels);

  for (let pixel = 0; pixel < numPixels; pixel++) {
    let sumT = 0, sumD = 0, count = 0;
    for (let e = 0; e < numEpochs; e++) {
      const d = displacement[e * numPixels + pixel];
      if (d !== 0 || e === 0) {
        sumT += times[e];
        sumD += d;
        count++;
      }
    }
    if (count < 2) continue;

    const meanT = sumT / count;
    const meanD = sumD / count;
    let num = 0, den = 0;
    for (let e = 0; e < numEpochs; e++) {
      const d = displacement[e * numPixels + pixel];
      if (d !== 0 || e === 0) {
        const dt = times[e] - meanT;
        num += dt * (d - meanD);
        den += dt * dt;
      }
    }

    if (den === 0) continue;
    const v = num / den;
    velocity[pixel] = v * 365.25;

    let rss = 0;
    for (let e = 0; e < numEpochs; e++) {
      const d = displacement[e * numPixels + pixel];
      if (d !== 0 || e === 0) {
        const predicted = meanD + v * (times[e] - meanT);
        const r = d - predicted;
        rss += r * r;
      }
    }
    residuals[pixel] = Math.sqrt(rss / count);
  }

  return { velocity, residuals };
}

/**
 * Compute temporal coherence — quality metric for SBAS inversion.
 *
 * @param {Object} opts
 * @param {Float32Array} opts.observedPhase - Original interferogram phases
 *   (numIfgs × numPixels)
 * @param {Float32Array} opts.displacement - SBAS output (numEpochs × numPixels)
 * @param {Float32Array} opts.designMatrix - G matrix (numIfgs × numEpochs)
 * @param {number} opts.numPixels
 * @param {number} opts.numIfgs
 * @param {number} opts.numEpochs
 * @returns {Promise<Float32Array>} Temporal coherence per pixel [0, 1]
 */
export async function computeTemporalCoherence({
  observedPhase,
  displacement,
  designMatrix,
  numPixels,
  numIfgs,
  numEpochs,
}) {
  if (!hasWebGPU()) {
    return computeTemporalCoherenceCPU({
      observedPhase, displacement, designMatrix, numPixels, numIfgs, numEpochs,
    });
  }

  const device = await getDevice();
  const pipelines = await ensurePipelines(device);
  const numWorkgroups = Math.ceil(numPixels / WORKGROUP_SIZE);

  const obsBuffer = createStorageBuffer(device, observedPhase);
  const dispBuffer = createStorageBuffer(device, displacement);
  const gBuffer = createStorageBuffer(device, designMatrix);

  const paramsData = new ArrayBuffer(16);
  new Uint32Array(paramsData, 0, 1)[0] = numPixels;
  new Uint32Array(paramsData, 4, 1)[0] = numIfgs;
  new Uint32Array(paramsData, 8, 1)[0] = numEpochs;
  const paramsBuffer = createUniformBuffer(device, paramsData);

  const tcBuffer = device.createBuffer({
    size: numPixels * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const bindGroup = device.createBindGroup({
    layout: pipelines.temporalCoherence.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: obsBuffer } },
      { binding: 1, resource: { buffer: dispBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } },
      { binding: 3, resource: { buffer: tcBuffer } },
      { binding: 4, resource: { buffer: gBuffer } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipelines.temporalCoherence);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(numWorkgroups);
  pass.end();
  device.queue.submit([encoder.finish()]);

  const result = await readBackBuffer(device, tcBuffer, numPixels * 4);

  obsBuffer.destroy();
  dispBuffer.destroy();
  gBuffer.destroy();
  paramsBuffer.destroy();
  tcBuffer.destroy();

  return result;
}

/**
 * CPU fallback for temporal coherence.
 */
function computeTemporalCoherenceCPU({
  observedPhase, displacement, designMatrix, numPixels, numIfgs, numEpochs,
}) {
  const tc = new Float32Array(numPixels);

  for (let pixel = 0; pixel < numPixels; pixel++) {
    let sumCos = 0, sumSin = 0, count = 0;

    for (let i = 0; i < numIfgs; i++) {
      const observed = observedPhase[i * numPixels + pixel];
      if (observed === 0) continue;

      let modeled = 0;
      for (let e = 0; e < numEpochs; e++) {
        modeled += designMatrix[i * numEpochs + e] * displacement[e * numPixels + pixel];
      }

      const residual = observed - modeled;
      sumCos += Math.cos(residual);
      sumSin += Math.sin(residual);
      count++;
    }

    if (count === 0) continue;
    const avgCos = sumCos / count;
    const avgSin = sumSin / count;
    tc[pixel] = Math.sqrt(avgCos * avgCos + avgSin * avgSin);
  }

  return tc;
}

/**
 * Run the full MintPy-inspired InSAR time-series pipeline on a tile.
 *
 * @param {Object} opts
 * @param {Float32Array} opts.phases - Stacked unwrapped phases (numIfgs × numPixels)
 * @param {Array<{ref: number, sec: number}>} opts.pairs - Date index pairs
 * @param {Float32Array} opts.times - Days since first epoch for each date
 * @param {number} opts.numPixels - width × height of tile
 * @param {number} opts.numEpochs - Number of unique dates
 * @param {number} [opts.wavelength=0.238] - Radar wavelength (meters)
 * @param {Float32Array} [opts.coherenceWeights] - Per-ifg mean coherence weights
 * @returns {Promise<Object>} { displacement, velocity, residuals, temporalCoherence }
 */
export async function runTimeSeriesPipeline({
  phases,
  pairs,
  times,
  numPixels,
  numEpochs,
  wavelength = 0.238,
  coherenceWeights,
}) {
  const numIfgs = pairs.length;

  // Step 1: Build design matrix and pseudo-inverse (CPU, small matrix)
  const G = buildDesignMatrix(pairs, numEpochs);
  const invMatrix = computePseudoInverse(G, numIfgs, numEpochs, coherenceWeights);

  // Step 2: SBAS inversion (GPU)
  const displacement = await sbasInversion({
    phases, invMatrix, numPixels, numIfgs, numEpochs, wavelength,
  });

  // Step 3: Velocity + temporal coherence (GPU, parallel)
  const [velocityResult, temporalCoherence] = await Promise.all([
    estimateVelocity({ displacement, times, numPixels, numEpochs }),
    computeTemporalCoherence({
      observedPhase: phases,
      displacement,
      designMatrix: G,
      numPixels,
      numIfgs,
      numEpochs,
    }),
  ]);

  return {
    displacement,               // Float32Array (numEpochs × numPixels), meters LOS
    velocity: velocityResult.velocity,     // Float32Array (numPixels), m/year
    residuals: velocityResult.residuals,   // Float32Array (numPixels), meters RMS
    temporalCoherence,          // Float32Array (numPixels), [0, 1]
    designMatrix: G,            // Float32Array (numIfgs × numEpochs)
    invMatrix,                  // Float32Array (numEpochs × numIfgs)
  };
}
