/**
 * GPU histogram computation via WebGPU compute shaders.
 *
 * Two-pass architecture:
 *   Pass 1 (reduce): parallel min/max reduction using workgroup shared memory
 *   Pass 2 (bin):    atomic histogram binning into storage buffer
 *
 * Returns the same shape as computeChannelStats() from stats.js:
 *   { bins, min, max, mean, binWidth, count, p2, p98 }
 */

import { getDevice, hasWebGPU } from './webgpu-device.js';

const NUM_BINS = 256;
const WORKGROUP_SIZE = 256;

// ── WGSL Shaders ────────────────────────────────────────────────────────────

const reduceShader = /* wgsl */ `
// Pass 1: parallel min/max/sum/count reduction.
// Each workgroup reduces WORKGROUP_SIZE elements, writes partial results
// to an output buffer. CPU does the final reduction over workgroup results.

struct Params {
  count: u32,        // number of elements in input
  useDecibels: u32,  // 1 = apply 10*log10
  _pad0: u32,
  _pad1: u32,
};

struct ReduceResult {
  rMin: f32,
  rMax: f32,
  rSum: f32,
  rCount: u32,
};

@group(0) @binding(0) var<storage, read> inputData: array<f32>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read_write> results: array<ReduceResult>;

var<workgroup> sMin: array<f32, ${WORKGROUP_SIZE}>;
var<workgroup> sMax: array<f32, ${WORKGROUP_SIZE}>;
var<workgroup> sSum: array<f32, ${WORKGROUP_SIZE}>;
var<workgroup> sCount: array<u32, ${WORKGROUP_SIZE}>;

fn toValue(raw: f32) -> f32 {
  if (raw <= 0.0 || raw != raw) {  // NaN check: x != x
    return bitcast<f32>(0x7FC00000u);  // NaN sentinel
  }
  if (params.useDecibels == 1u) {
    return 10.0 * log2(max(raw, 1e-10)) * 0.30103;
  }
  return raw;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn reduceMain(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let idx = gid.x;
  let local = lid.x;

  // Initialize shared memory
  sMin[local] = 3.402823e+38;  // FLT_MAX
  sMax[local] = -3.402823e+38;
  sSum[local] = 0.0;
  sCount[local] = 0u;

  if (idx < params.count) {
    let val = toValue(inputData[idx]);
    // Check for NaN (val != val)
    if (val == val) {
      sMin[local] = val;
      sMax[local] = val;
      sSum[local] = val;
      sCount[local] = 1u;
    }
  }

  workgroupBarrier();

  // Tree reduction within workgroup
  for (var stride = ${WORKGROUP_SIZE / 2}u; stride > 0u; stride >>= 1u) {
    if (local < stride) {
      if (sCount[local + stride] > 0u) {
        if (sCount[local] == 0u) {
          sMin[local] = sMin[local + stride];
          sMax[local] = sMax[local + stride];
        } else {
          sMin[local] = min(sMin[local], sMin[local + stride]);
          sMax[local] = max(sMax[local], sMax[local + stride]);
        }
        sSum[local] += sSum[local + stride];
        sCount[local] += sCount[local + stride];
      }
    }
    workgroupBarrier();
  }

  // Thread 0 writes workgroup result
  if (local == 0u) {
    results[wid.x] = ReduceResult(sMin[0], sMax[0], sSum[0], sCount[0]);
  }
}
`;

const histogramShader = /* wgsl */ `
// Pass 2: atomic histogram binning.
// Reads input data, converts to value, bins into NUM_BINS buckets.

struct Params {
  count: u32,
  useDecibels: u32,
  rangeMin: f32,
  rangeMax: f32,
};

@group(0) @binding(0) var<storage, read> inputData: array<f32>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read_write> bins: array<atomic<u32>, ${NUM_BINS}>;

fn toValue(raw: f32) -> f32 {
  if (raw <= 0.0 || raw != raw) {
    return bitcast<f32>(0x7FC00000u);
  }
  if (params.useDecibels == 1u) {
    return 10.0 * log2(max(raw, 1e-10)) * 0.30103;
  }
  return raw;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn histMain(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.count) { return; }

  let val = toValue(inputData[idx]);
  // NaN check
  if (val != val) { return; }

  let range = params.rangeMax - params.rangeMin;
  if (range <= 0.0) { return; }

  var bin = i32(floor((val - params.rangeMin) / range * f32(${NUM_BINS})));
  bin = max(0, min(${NUM_BINS - 1}, bin));

  atomicAdd(&bins[bin], 1u);
}
`;

// ── Pipeline Cache ──────────────────────────────────────────────────────────

let _reducePipeline = null;
let _histPipeline = null;
let _pipelineDevice = null;

async function ensurePipelines(device) {
  if (_pipelineDevice === device && _reducePipeline && _histPipeline) return;

  _reducePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code: reduceShader }),
      entryPoint: 'reduceMain',
    },
  });

  _histPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code: histogramShader }),
      entryPoint: 'histMain',
    },
  });

  _pipelineDevice = device;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute histogram of Float32 SAR data on the GPU.
 *
 * @param {Float32Array} data - Raw SAR amplitude data
 * @param {Object} opts
 * @param {boolean} opts.useDecibels - Apply 10*log10 conversion (default true)
 * @param {number}  opts.numBins - Number of histogram bins (default 256)
 * @returns {Promise<Object>} { bins, min, max, mean, binWidth, count, p2, p98 }
 */
export async function computeHistogramGPU(data, { useDecibels = true, numBins = NUM_BINS } = {}) {
  if (!hasWebGPU()) {
    throw new Error('WebGPU not available');
  }

  const device = await getDevice();
  await ensurePipelines(device);

  const elementCount = data.length;
  const numWorkgroups = Math.ceil(elementCount / WORKGROUP_SIZE);

  // ── Upload input data ─────────────────────────────────────────────────
  const inputBuffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(inputBuffer, 0, data);

  // ── Pass 1: Min/Max/Sum/Count reduction ───────────────────────────────
  const reduceResultSize = numWorkgroups * 16; // 4 floats/uints × 4 bytes
  const reduceResultBuffer = device.createBuffer({
    size: reduceResultSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const reduceReadBuffer = device.createBuffer({
    size: reduceResultSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const reduceParamsData = new ArrayBuffer(16);
  new Uint32Array(reduceParamsData, 0, 1)[0] = elementCount;
  new Uint32Array(reduceParamsData, 4, 1)[0] = useDecibels ? 1 : 0;
  const reduceParamsBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(reduceParamsBuffer, 0, reduceParamsData);

  const reduceBindGroup = device.createBindGroup({
    layout: _reducePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: inputBuffer } },
      { binding: 1, resource: { buffer: reduceParamsBuffer } },
      { binding: 2, resource: { buffer: reduceResultBuffer } },
    ],
  });

  let encoder = device.createCommandEncoder();
  let pass = encoder.beginComputePass();
  pass.setPipeline(_reducePipeline);
  pass.setBindGroup(0, reduceBindGroup);
  pass.dispatchWorkgroups(numWorkgroups);
  pass.end();
  encoder.copyBufferToBuffer(reduceResultBuffer, 0, reduceReadBuffer, 0, reduceResultSize);
  device.queue.submit([encoder.finish()]);

  // Read back reduction results
  await reduceReadBuffer.mapAsync(GPUMapMode.READ);
  const reduceData = new Float32Array(reduceReadBuffer.getMappedRange().slice(0));
  reduceReadBuffer.unmap();

  // Final reduction on CPU (over workgroup partial results)
  let globalMin = Infinity;
  let globalMax = -Infinity;
  let globalSum = 0;
  let globalCount = 0;

  for (let i = 0; i < numWorkgroups; i++) {
    const base = i * 4;
    const rMin = reduceData[base + 0];
    const rMax = reduceData[base + 1];
    const rSum = reduceData[base + 2];
    // count is stored as u32, reinterpret the float bits
    const rCount = new Uint32Array(reduceData.buffer, (base + 3) * 4, 1)[0];

    if (rCount > 0) {
      globalMin = Math.min(globalMin, rMin);
      globalMax = Math.max(globalMax, rMax);
      globalSum += rSum;
      globalCount += rCount;
    }
  }

  if (globalCount === 0) {
    // Clean up
    inputBuffer.destroy();
    reduceResultBuffer.destroy();
    reduceReadBuffer.destroy();
    reduceParamsBuffer.destroy();
    return null;
  }

  const globalMean = globalSum / globalCount;

  // ── Pass 2: Histogram binning ─────────────────────────────────────────
  const histBinBuffer = device.createBuffer({
    size: numBins * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const histReadBuffer = device.createBuffer({
    size: numBins * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // Zero-initialize the bin buffer
  const zeros = new Uint32Array(numBins);
  device.queue.writeBuffer(histBinBuffer, 0, zeros);

  const histParamsData = new ArrayBuffer(16);
  new Uint32Array(histParamsData, 0, 1)[0] = elementCount;
  new Uint32Array(histParamsData, 4, 1)[0] = useDecibels ? 1 : 0;
  new Float32Array(histParamsData, 8, 1)[0] = globalMin;
  new Float32Array(histParamsData, 12, 1)[0] = globalMax;
  const histParamsBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(histParamsBuffer, 0, histParamsData);

  const histBindGroup = device.createBindGroup({
    layout: _histPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: inputBuffer } },
      { binding: 1, resource: { buffer: histParamsBuffer } },
      { binding: 2, resource: { buffer: histBinBuffer } },
    ],
  });

  encoder = device.createCommandEncoder();
  pass = encoder.beginComputePass();
  pass.setPipeline(_histPipeline);
  pass.setBindGroup(0, histBindGroup);
  pass.dispatchWorkgroups(numWorkgroups);
  pass.end();
  encoder.copyBufferToBuffer(histBinBuffer, 0, histReadBuffer, 0, numBins * 4);
  device.queue.submit([encoder.finish()]);

  // Read back histogram
  await histReadBuffer.mapAsync(GPUMapMode.READ);
  const binsU32 = new Uint32Array(histReadBuffer.getMappedRange().slice(0));
  histReadBuffer.unmap();

  // ── Percentile walk (CPU — trivial on 256 bins) ───────────────────────
  const binWidth = (globalMax - globalMin) / numBins;
  const p2Target = Math.floor(0.02 * globalCount);
  const p98Target = Math.min(Math.floor(0.98 * globalCount), globalCount - 1);
  let cumulative = 0;
  let p2 = globalMin;
  let p98 = globalMax;
  let foundP2 = false;

  for (let b = 0; b < numBins; b++) {
    cumulative += binsU32[b];
    if (!foundP2 && cumulative > p2Target) {
      p2 = globalMin + b * binWidth;
      foundP2 = true;
    }
    if (cumulative > p98Target) {
      p98 = globalMin + (b + 1) * binWidth;
      break;
    }
  }

  // Convert bins to regular Array for compatibility with existing Histogram.jsx
  const bins = Array.from(binsU32);

  // ── Cleanup GPU buffers ───────────────────────────────────────────────
  inputBuffer.destroy();
  reduceResultBuffer.destroy();
  reduceReadBuffer.destroy();
  reduceParamsBuffer.destroy();
  histBinBuffer.destroy();
  histReadBuffer.destroy();
  histParamsBuffer.destroy();

  return {
    bins,
    min: globalMin,
    max: globalMax,
    mean: globalMean,
    binWidth,
    count: globalCount,
    p2,
    p98,
  };
}
