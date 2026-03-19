/**
 * WebGPU compute shader for Cloude-Pottier H/Alpha/Entropy decomposition.
 *
 * Performs eigenanalysis of the 3×3 coherency matrix T3 entirely on the GPU.
 * Input: 9 covariance matrix element arrays (3 real diagonal + 3 complex off-diagonal)
 * Output: 3 arrays — H (entropy), α (alpha angle in degrees), A (anisotropy)
 *
 * Falls back to CPU when WebGPU is unavailable.
 *
 * Reference: Cloude & Pottier 1997, IEEE TGRS 35(1).
 */

import { getDevice, hasWebGPU } from './webgpu-device.js';

const WORKGROUP_SIZE = 256;

// ── WGSL Compute Shader ────────────────────────────────────────────────────

const hAlphaShader = /* wgsl */ `

struct Params {
  count: u32,    // total number of pixels
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

// 9 input covariance elements packed sequentially in one buffer:
//   [C11 ... | C12_re ... | C12_im ... | C13_re ... | C13_im ... | C22 ... | C23_re ... | C23_im ... | C33 ...]
// Each sub-array has \`count\` elements.
@group(0) @binding(0) var<storage, read> inputData: array<f32>;
@group(0) @binding(1) var<uniform> params: Params;
// 3 output arrays packed sequentially: [H ... | alpha ... | A ...]
@group(0) @binding(2) var<storage, read_write> outputData: array<f32>;

const PI: f32 = 3.14159265358979;
const SQRT2: f32 = 1.41421356237310;
const LOG3: f32 = 1.09861228866811;  // ln(3)
const RAD2DEG: f32 = 57.2957795130823;
const TWO_PI_OVER_3: f32 = 2.09439510239320;  // 2π/3

@compute @workgroup_size(${WORKGROUP_SIZE})
fn hAlphaMain(
  @builtin(global_invocation_id) gid: vec3u,
) {
  let idx = gid.x;
  if (idx >= params.count) { return; }

  let n = params.count;

  // Read 9 covariance matrix elements
  let c11    = inputData[idx];              // HHHH
  let c12re  = inputData[n + idx];          // Re(HHHV)
  let c12im  = inputData[2u * n + idx];     // Im(HHHV)
  let c13re  = inputData[3u * n + idx];     // Re(HHVV)
  let c13im  = inputData[4u * n + idx];     // Im(HHVV)
  let c22    = inputData[5u * n + idx];     // HVHV
  let c23re  = inputData[6u * n + idx];     // Re(HVVV)
  let c23im  = inputData[7u * n + idx];     // Im(HVVV)
  let c33    = inputData[8u * n + idx];     // VVVV

  // Nodata check
  if (c11 <= 0.0 && c22 <= 0.0 && c33 <= 0.0) {
    outputData[idx]         = 0.0;  // H
    outputData[n + idx]     = 0.0;  // α
    outputData[2u * n + idx] = 0.0; // A
    return;
  }

  // ── Build coherency matrix T3 from covariance C3 ─────────────
  // T = U · C · U†,  U = (1/√2) [[1,0,1],[1,0,-1],[0,√2,0]]
  let t11 = (c11 + c33 + 2.0 * c13re) / 2.0;
  let t12re = (c11 - c33) / 2.0;
  let t12im = -c13im;
  let t13re = (c12re + c23re) / SQRT2;
  let t13im = (c12im - c23im) / SQRT2;
  let t22 = (c11 + c33 - 2.0 * c13re) / 2.0;
  let t23re = (c12re - c23re) / SQRT2;
  let t23im = (c12im + c23im) / SQRT2;
  let t33 = c22;

  let trace = t11 + t22 + t33;
  if (trace <= 1e-20) {
    outputData[idx]         = 0.0;
    outputData[n + idx]     = 0.0;
    outputData[2u * n + idx] = 0.0;
    return;
  }

  // ── Eigenvalues via Cardano's trigonometric method ────────────
  let absT12sq = t12re * t12re + t12im * t12im;
  let absT13sq = t13re * t13re + t13im * t13im;
  let absT23sq = t23re * t23re + t23im * t23im;

  let m = trace / 3.0;
  let d11 = t11 - m;
  let d22 = t22 - m;
  let d33 = t33 - m;

  // p = tr((T - mI)²) / 6
  let p = (d11 * d11 + d22 * d22 + d33 * d33 + 2.0 * (absT12sq + absT13sq + absT23sq)) / 6.0;

  var l1: f32;
  var l2: f32;
  var l3: f32;

  if (p <= 1e-30) {
    // Degenerate: all eigenvalues equal
    l1 = m; l2 = m; l3 = m;
  } else {
    // q = det(T - mI) / 2
    let reT12T23T13conj = (t12re * t23re - t12im * t23im) * t13re
                        + (t12re * t23im + t12im * t23re) * t13im;
    let detShifted = d11 * (d22 * d33 - absT23sq)
                   - absT12sq * d33 - absT13sq * d22
                   + 2.0 * reT12T23T13conj;
    let q = detShifted / 2.0;

    let p32 = p * sqrt(p);
    let r = clamp(q / p32, -1.0, 1.0);
    let phi = acos(r) / 3.0;
    let sqrtP = sqrt(p);

    l1 = m + 2.0 * sqrtP * cos(phi);
    l2 = m + 2.0 * sqrtP * cos(phi - TWO_PI_OVER_3);
    l3 = m + 2.0 * sqrtP * cos(phi + TWO_PI_OVER_3);
  }

  // Sort descending
  if (l1 < l2) { let tmp = l1; l1 = l2; l2 = tmp; }
  if (l1 < l3) { let tmp = l1; l1 = l3; l3 = tmp; }
  if (l2 < l3) { let tmp = l2; l2 = l3; l3 = tmp; }

  // Clamp negative eigenvalues
  l1 = max(l1, 0.0);
  l2 = max(l2, 0.0);
  l3 = max(l3, 0.0);

  let span = l1 + l2 + l3;
  if (span <= 1e-20) {
    outputData[idx]         = 0.0;
    outputData[n + idx]     = 0.0;
    outputData[2u * n + idx] = 0.0;
    return;
  }

  // ── Eigenvectors via cofactor method ──────────────────────────
  // For each λ, first column of adj(T - λI):
  //   v0 = (t22-λ)(t33-λ) - |t23|²  [real]
  //   v1 = conj(t13)·t23 - conj(t12)·(t33-λ)  [complex]
  //   v2 = conj(t12)·conj(t23) - conj(t13)·(t22-λ)  [complex]
  //   α = acos(|v0| / ||v||)

  var alphas = array<f32, 3>(45.0, 45.0, 45.0);
  var lambdas = array<f32, 3>(l1, l2, l3);

  for (var k = 0u; k < 3u; k++) {
    let lam = lambdas[k];

    let v0 = (t22 - lam) * (t33 - lam) - absT23sq;

    // v1 = conj(t13)·t23 - conj(t12)·(t33-λ)
    let v1re = (t13re * t23re + t13im * t23im) - t12re * (t33 - lam);
    let v1im = (t13re * t23im - t13im * t23re) + t12im * (t33 - lam);

    // v2 = conj(t12)·conj(t23) - conj(t13)·(t22-λ)
    let v2re = (t12re * t23re - t12im * t23im) - t13re * (t22 - lam);  // wait...
    // conj(t12)·conj(t23) = (t12re - i·t12im)(t23re - i·t23im)
    //   re: t12re·t23re + t12im·t23im ... no
    //   (a-bi)(c-di) = (ac-bd) - i(ad+bc)  ... wait:
    //   (a-bi)(c-di) = ac - adi - bci + bdi² = (ac - bd) - i(ad + bc)
    // So re = t12re*t23re - t12im*t23im  ... hmm that's wrong for conjugate
    // Actually: conj(z1)·conj(z2) = conj(z1·z2)
    // z1·z2 = (t12re + i·t12im)(t23re + i·t23im)
    //       = (t12re·t23re - t12im·t23im) + i·(t12re·t23im + t12im·t23re)
    // conj(z1·z2) = (t12re·t23re - t12im·t23im) - i·(t12re·t23im + t12im·t23re)
    let v2re_val = (t12re * t23re - t12im * t23im) - t13re * (t22 - lam);
    let v2im_val = -(t12re * t23im + t12im * t23re) + t13im * (t22 - lam);

    let normSq = v0 * v0 + v1re * v1re + v1im * v1im + v2re_val * v2re_val + v2im_val * v2im_val;

    if (normSq > 1e-30) {
      let cosAlpha = abs(v0) / sqrt(normSq);
      alphas[k] = acos(min(cosAlpha, 1.0)) * RAD2DEG;
    }
    // else: keep default 45°
  }

  // ── Derived parameters ────────────────────────────────────────
  let p1 = l1 / span;
  let p2 = l2 / span;
  let p3 = l3 / span;

  // Entropy H = -Σ pi·log₃(pi)
  var H: f32 = 0.0;
  if (p1 > 1e-10) { H -= p1 * log(p1) / LOG3; }
  if (p2 > 1e-10) { H -= p2 * log(p2) / LOG3; }
  if (p3 > 1e-10) { H -= p3 * log(p3) / LOG3; }

  // Mean alpha ᾱ = Σ pi·αi
  let alpha = p1 * alphas[0] + p2 * alphas[1] + p3 * alphas[2];

  // Anisotropy A = (λ2 - λ3) / (λ2 + λ3)
  var A: f32 = 0.0;
  if (l2 + l3 > 1e-20) { A = (l2 - l3) / (l2 + l3); }

  outputData[idx]         = H;
  outputData[n + idx]     = alpha;
  outputData[2u * n + idx] = A;
}
`;

// ── Pipeline Cache ─────────────────────────────────────────────────────────

let _pipeline = null;

async function ensurePipeline(device) {
  if (_pipeline) return _pipeline;

  const module = device.createShaderModule({ code: hAlphaShader });
  _pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'hAlphaMain' },
  });
  return _pipeline;
}

// ── GPU Execution ──────────────────────────────────────────────────────────

/**
 * Run H/Alpha/Entropy decomposition on the GPU via WebGPU compute.
 *
 * @param {Object} bands - {HHHH, HVHV, VVVV, HHHV_re, HHHV_im, HHVV_re, HHVV_im, HVVV_re, HVVV_im}
 * @param {number} pixelCount - Total number of pixels
 * @returns {Promise<{R: Float32Array, G: Float32Array, B: Float32Array}>}
 */
async function gpuHAlpha(bands, pixelCount) {
  const device = await getDevice();
  const pipeline = await ensurePipeline(device);

  const n = pixelCount;

  // Pack 9 input arrays sequentially into one buffer
  const inputSize = n * 9 * 4;
  const inputArray = new Float32Array(n * 9);
  const names = ['HHHH', 'HHHV_re', 'HHHV_im', 'HHVV_re', 'HHVV_im', 'HVHV', 'HVVV_re', 'HVVV_im', 'VVVV'];
  for (let i = 0; i < 9; i++) {
    const src = bands[names[i]];
    if (src) {
      inputArray.set(src, i * n);
    }
    // Missing bands remain zero-filled
  }

  const inputBuffer = device.createBuffer({
    size: inputSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(inputBuffer, 0, inputArray);

  // Output buffer: 3 arrays (H, α, A)
  const outputSize = n * 3 * 4;
  const outputBuffer = device.createBuffer({
    size: outputSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const readBuffer = device.createBuffer({
    size: outputSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // Params: count + 3 padding
  const paramsData = new Uint32Array([n, 0, 0, 0]);
  const paramsBuffer = device.createBuffer({
    size: 16,
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
  const numWorkgroups = Math.ceil(n / WORKGROUP_SIZE);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(numWorkgroups);
  pass.end();
  encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, outputSize);
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

  // Split into 3 output arrays
  return {
    R: result.subarray(0, n),       // H (entropy)
    G: result.subarray(n, 2 * n),   // α (alpha angle)
    B: result.subarray(2 * n, 3 * n), // A (anisotropy)
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute H/Alpha/Entropy decomposition, using WebGPU when available.
 *
 * @param {Object} bands - Covariance matrix bands (same format as computeHAlphaEntropyRGB)
 * @param {number} pixelCount - Total pixel count
 * @param {Object} [options]
 * @param {string} [options._forceBackend] - 'cpu' | 'gpu' for benchmarking
 * @returns {Promise<{R: Float32Array, G: Float32Array, B: Float32Array}>}
 */
export async function computeHAlphaGPU(bands, pixelCount, { _forceBackend } = {}) {
  if (_forceBackend === 'cpu') {
    return null; // caller should use CPU fallback
  }

  if ((_forceBackend === 'gpu' || !_forceBackend) && hasWebGPU() && pixelCount > 256) {
    try {
      return await gpuHAlpha(bands, pixelCount);
    } catch (err) {
      if (_forceBackend === 'gpu') throw err;
      console.warn('[polsar-compute] GPU H/Alpha failed, falling back to CPU:', err.message);
    }
  }

  return null; // signal caller to use CPU path
}

/**
 * Check if GPU H/Alpha compute is available.
 */
export function canUseGPUHAlpha() {
  return hasWebGPU();
}
