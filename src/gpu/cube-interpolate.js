/**
 * GPU-accelerated metadata cube interpolation via WebGPU compute shaders.
 *
 * Two-pass approach:
 *   Pass 1: Trilinear interpolation on a coarse grid (every Nth pixel)
 *   Pass 2: Bilinear upscale from coarse to full resolution (striped)
 *
 * CPU fallback: MetadataCube.evaluateOnGrid()
 */

import { getDevice, hasWebGPU } from './webgpu-device.js';

const WORKGROUP_SIZE = 256;

// ── WGSL Shaders ───────────────────────────────────────────────────────────

/**
 * Pass 1: Trilinear interpolation on coarse grid.
 * Each thread evaluates one coarse grid point by doing 3D trilinear
 * interpolation into the metadata cube.
 */
function trilinearShaderCode() {
  return /* wgsl */`
struct CubeParams {
  nx: u32,
  ny: u32,
  nz: u32,
  coarseW: u32,
  coarseH: u32,
  x0: f32,
  invDx: f32,
  y0: f32,
  invDy: f32,
  z0: f32,
  invDz: f32,
  heightVal: f32,
  useHeight: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<storage, read> cubeField: array<f32>;
@group(0) @binding(1) var<uniform> params: CubeParams;
@group(0) @binding(2) var<storage, read> pixelX: array<f32>;
@group(0) @binding(3) var<storage, read> pixelY: array<f32>;
@group(0) @binding(4) var<storage, read_write> output: array<f32>;

const NAN_BITS: u32 = 0x7FC00000u;

fn isValid(v: f32) -> bool {
  return v == v;
}

fn bilinear(k: u32, fi: f32, fj: f32) -> f32 {
  let i0 = u32(max(0.0, min(f32(params.nx - 1u), floor(fi))));
  let j0 = u32(max(0.0, min(f32(params.ny - 1u), floor(fj))));
  let i1 = min(i0 + 1u, params.nx - 1u);
  let j1 = min(j0 + 1u, params.ny - 1u);

  let wx = clamp(fi - f32(i0), 0.0, 1.0);
  let wy = clamp(fj - f32(j0), 0.0, 1.0);

  let base = k * params.ny * params.nx;
  let v00 = cubeField[base + j0 * params.nx + i0];
  let v10 = cubeField[base + j0 * params.nx + i1];
  let v01 = cubeField[base + j1 * params.nx + i0];
  let v11 = cubeField[base + j1 * params.nx + i1];

  var sum = 0.0;
  var wsum = 0.0;
  let w00 = (1.0 - wx) * (1.0 - wy);
  let w10 = wx * (1.0 - wy);
  let w01 = (1.0 - wx) * wy;
  let w11 = wx * wy;

  if (isValid(v00)) { sum += w00 * v00; wsum += w00; }
  if (isValid(v10)) { sum += w10 * v10; wsum += w10; }
  if (isValid(v01)) { sum += w01 * v01; wsum += w01; }
  if (isValid(v11)) { sum += w11 * v11; wsum += w11; }

  if (wsum <= 0.0) { return bitcast<f32>(NAN_BITS); }
  return sum / wsum;
}

@compute @workgroup_size(${WORKGROUP_SIZE}, 1, 1)
fn trilinearMain(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.coarseW * params.coarseH) { return; }

  let col = idx % params.coarseW;
  let row = idx / params.coarseW;

  let easting = pixelX[col];
  let northing = pixelY[row];

  let fi = (easting - params.x0) * params.invDx;
  let fj = (northing - params.y0) * params.invDy;

  // Bounds check (allow slight extrapolation for edge pixels)
  if (fi < -0.5 || fi > f32(params.nx) - 0.5 || fj < -0.5 || fj > f32(params.ny) - 0.5) {
    output[idx] = bitcast<f32>(NAN_BITS);
    return;
  }

  if (params.useHeight == 0u || params.nz <= 1u) {
    output[idx] = bilinear(0u, fi, fj);
    return;
  }

  // 3D: bilinear per layer + linear in height
  let fk = (params.heightVal - params.z0) * params.invDz;
  let fkc = clamp(fk, 0.0, f32(params.nz - 1u));
  let k0 = u32(floor(fkc));
  let k1 = min(k0 + 1u, params.nz - 1u);
  let wz = fkc - f32(k0);

  let v0 = bilinear(k0, fi, fj);
  if (k0 == k1 || wz == 0.0) {
    output[idx] = v0;
    return;
  }

  let v1 = bilinear(k1, fi, fj);

  if (!isValid(v0) && !isValid(v1)) {
    output[idx] = bitcast<f32>(NAN_BITS);
  } else if (!isValid(v0)) {
    output[idx] = v1;
  } else if (!isValid(v1)) {
    output[idx] = v0;
  } else {
    output[idx] = v0 * (1.0 - wz) + v1 * wz;
  }
}
`;
}

/**
 * Pass 2: Bilinear upscale from coarse grid to full-resolution stripe.
 */
function upscaleShaderCode() {
  return /* wgsl */`
struct UpscaleParams {
  coarseW: u32,
  coarseH: u32,
  fullW: u32,
  stripeH: u32,
  stripeStartRow: u32,
  subsample: f32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<storage, read> coarseData: array<f32>;
@group(0) @binding(1) var<uniform> params: UpscaleParams;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE}, 1, 1)
fn upscaleMain(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.fullW * params.stripeH) { return; }

  let col = idx % params.fullW;
  let row = idx / params.fullW;
  let fullRow = row + params.stripeStartRow;

  let cfi = f32(col) / params.subsample;
  let cfj = f32(fullRow) / params.subsample;

  let ci0 = u32(max(0.0, floor(cfi)));
  let ci1 = min(ci0 + 1u, params.coarseW - 1u);
  let cj0 = u32(max(0.0, floor(cfj)));
  let cj1 = min(cj0 + 1u, params.coarseH - 1u);

  let wx = clamp(cfi - f32(ci0), 0.0, 1.0);
  let wy = clamp(cfj - f32(cj0), 0.0, 1.0);

  let v00 = coarseData[cj0 * params.coarseW + ci0];
  let v10 = coarseData[cj0 * params.coarseW + ci1];
  let v01 = coarseData[cj1 * params.coarseW + ci0];
  let v11 = coarseData[cj1 * params.coarseW + ci1];

  output[idx] =
    v00 * (1.0 - wx) * (1.0 - wy) +
    v10 * wx * (1.0 - wy) +
    v01 * (1.0 - wx) * wy +
    v11 * wx * wy;
}
`;
}

// ── Pipeline Cache ─────────────────────────────────────────────────────────

const _pipelineCache = new Map();

async function ensurePipeline(device, type) {
  if (_pipelineCache.has(type)) return _pipelineCache.get(type);

  const shaders = {
    trilinear: { code: trilinearShaderCode(), entry: 'trilinearMain' },
    upscale: { code: upscaleShaderCode(), entry: 'upscaleMain' },
  };

  const s = shaders[type];
  if (!s) throw new Error(`Unknown cube pipeline type: ${type}`);

  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code: s.code }),
      entryPoint: s.entry,
    },
  });

  _pipelineCache.set(type, pipeline);
  return pipeline;
}

// ── GPU Execution ──────────────────────────────────────────────────────────

/**
 * GPU trilinear interpolation on coarse grid (Pass 1).
 * Returns Float32Array[coarseH * coarseW].
 */
async function gpuTrilinear(device, cube, fieldName, coarseXCoords, coarseYCoords, elevationM) {
  const pipeline = await ensurePipeline(device, 'trilinear');
  const field = cube.fields[fieldName];
  const coarseW = coarseXCoords.length;
  const coarseH = coarseYCoords.length;
  const numPixels = coarseW * coarseH;

  // Params: 16 x u32/f32 = 64 bytes (aligned to 16 bytes)
  const paramsData = new ArrayBuffer(64);
  const pu = new Uint32Array(paramsData);
  const pf = new Float32Array(paramsData);
  pu[0] = cube.nx;
  pu[1] = cube.ny;
  pu[2] = cube.nz;
  pu[3] = coarseW;
  pu[4] = coarseH;
  pf[5] = cube.x[0];                                     // x0
  pf[6] = cube.nx > 1 ? 1.0 / cube.dx : 0;              // invDx
  pf[7] = cube.y[0];                                     // y0
  pf[8] = cube.ny > 1 ? 1.0 / cube.dy : 0;              // invDy
  pf[9] = cube.z[0];                                     // z0
  pf[10] = cube.nz > 1 ? 1.0 / cube.dz : 0;             // invDz
  pf[11] = elevationM ?? 0;                               // heightVal
  pu[12] = elevationM != null ? 1 : 0;                   // useHeight
  pu[13] = 0; pu[14] = 0; pu[15] = 0;                   // padding

  // Create buffers
  const fieldBuf = device.createBuffer({ size: field.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const paramsBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const pxBuf = device.createBuffer({ size: coarseW * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const pyBuf = device.createBuffer({ size: coarseH * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const outSize = numPixels * 4;
  const outBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  // Upload data
  device.queue.writeBuffer(fieldBuf, 0, field);
  device.queue.writeBuffer(paramsBuf, 0, paramsData);
  device.queue.writeBuffer(pxBuf, 0, coarseXCoords);
  device.queue.writeBuffer(pyBuf, 0, coarseYCoords);

  // Bind & dispatch
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: fieldBuf } },
      { binding: 1, resource: { buffer: paramsBuf } },
      { binding: 2, resource: { buffer: pxBuf } },
      { binding: 3, resource: { buffer: pyBuf } },
      { binding: 4, resource: { buffer: outBuf } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(numPixels / WORKGROUP_SIZE));
  pass.end();
  encoder.copyBufferToBuffer(outBuf, 0, readBuf, 0, outSize);
  device.queue.submit([encoder.finish()]);

  await readBuf.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();

  // Cleanup
  fieldBuf.destroy();
  paramsBuf.destroy();
  pxBuf.destroy();
  pyBuf.destroy();
  outBuf.destroy();
  readBuf.destroy();

  return result;
}

/**
 * GPU bilinear upscale from coarse grid to full resolution (Pass 2).
 * Processes in horizontal stripes to stay within buffer size limits.
 */
async function gpuUpscale(device, coarseData, coarseW, coarseH, fullW, fullH, subsample) {
  const pipeline = await ensurePipeline(device, 'upscale');

  // Upload coarse data (shared across all stripes)
  const coarseBuf = device.createBuffer({ size: coarseData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(coarseBuf, 0, coarseData);

  // Determine stripe height from device limits
  const maxBufSize = device.limits.maxStorageBufferBindingSize || 128 * 1024 * 1024;
  const maxStripeH = Math.floor(maxBufSize / (fullW * 4));
  const stripeH = Math.min(fullH, Math.max(1, maxStripeH));

  const result = new Float32Array(fullW * fullH);

  for (let startRow = 0; startRow < fullH; startRow += stripeH) {
    const h = Math.min(stripeH, fullH - startRow);
    const stripeSize = fullW * h * 4;

    // Params: 8 x u32/f32 = 32 bytes
    const paramsData = new ArrayBuffer(32);
    const pu = new Uint32Array(paramsData);
    const pf = new Float32Array(paramsData);
    pu[0] = coarseW;
    pu[1] = coarseH;
    pu[2] = fullW;
    pu[3] = h;
    pu[4] = startRow;
    pf[5] = subsample;
    pu[6] = 0; pu[7] = 0;

    const paramsBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const outBuf = device.createBuffer({ size: stripeSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuf = device.createBuffer({ size: stripeSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    device.queue.writeBuffer(paramsBuf, 0, paramsData);

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: coarseBuf } },
        { binding: 1, resource: { buffer: paramsBuf } },
        { binding: 2, resource: { buffer: outBuf } },
      ],
    });

    const numPixels = fullW * h;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(numPixels / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(outBuf, 0, readBuf, 0, stripeSize);
    device.queue.submit([encoder.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const stripe = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();

    result.set(stripe, startRow * fullW);

    paramsBuf.destroy();
    outBuf.destroy();
    readBuf.destroy();
  }

  coarseBuf.destroy();
  return result;
}

/**
 * Full GPU pipeline: trilinear on coarse grid → bilinear upscale to full res.
 */
async function gpuInterpolateCube(cube, fieldName, pixelXCoords, pixelYCoords, width, height, elevationM, subsample) {
  const device = await getDevice();

  // Build coarse coordinate arrays (Float32 for GPU)
  const coarseW = Math.ceil(width / subsample) + 1;
  const coarseH = Math.ceil(height / subsample) + 1;
  const coarseX = new Float32Array(coarseW);
  const coarseY = new Float32Array(coarseH);

  for (let ci = 0; ci < coarseW; ci++) {
    const col = Math.min(ci * subsample, width - 1);
    coarseX[ci] = pixelXCoords[col]; // Float64→Float32 implicit cast
  }
  for (let cj = 0; cj < coarseH; cj++) {
    const row = Math.min(cj * subsample, height - 1);
    coarseY[cj] = pixelYCoords[row];
  }

  // Pass 1: trilinear on coarse grid
  const coarseData = await gpuTrilinear(device, cube, fieldName, coarseX, coarseY, elevationM);

  // If subsample is 1, coarse IS full-res — skip upscale
  if (subsample <= 1) return coarseData;

  // Pass 2: bilinear upscale to full resolution
  return gpuUpscale(device, coarseData, coarseW, coarseH, width, height, subsample);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Interpolate a single metadata cube field onto a pixel grid.
 * Uses GPU when available, falls back to CPU.
 *
 * @param {MetadataCube} cube - Metadata cube instance
 * @param {string} fieldName - e.g. 'incidenceAngle', 'slantRange'
 * @param {Float64Array} pixelXCoords - Easting per column (length=width)
 * @param {Float64Array} pixelYCoords - Northing per row (length=height)
 * @param {number} width - Output width
 * @param {number} height - Output height
 * @param {Object} [opts]
 * @param {number|null} [opts.elevationM=null] - Fixed height (null = ground layer)
 * @param {number} [opts.subsample=0] - 0 = auto-compute from cube spacing
 * @param {string} [opts._forceBackend] - 'cpu' | 'gpu' for benchmarking
 * @returns {Promise<Float32Array>} Interpolated field [height * width]
 */
export async function interpolateCubeOnGrid(
  cube, fieldName, pixelXCoords, pixelYCoords, width, height,
  { elevationM = null, subsample = 0, _forceBackend } = {}
) {
  // Auto-compute subsample from cube spacing
  if (subsample <= 0) {
    subsample = Math.max(1, Math.floor(1000 / (Math.abs(cube.dx) || 30)));
  }

  if (_forceBackend === 'cpu') {
    return cube.evaluateOnGrid(fieldName, pixelXCoords, pixelYCoords, width, height, elevationM, subsample);
  }

  // Use GPU for grids larger than a trivial size
  if (hasWebGPU() && width * height > 4096) {
    try {
      return await gpuInterpolateCube(cube, fieldName, pixelXCoords, pixelYCoords, width, height, elevationM, subsample);
    } catch (err) {
      if (_forceBackend === 'gpu') throw err;
      console.warn('[cube-interpolate] GPU failed, falling back to CPU:', err.message);
    }
  }

  return cube.evaluateOnGrid(fieldName, pixelXCoords, pixelYCoords, width, height, elevationM, subsample);
}

/**
 * Interpolate ALL metadata cube fields onto an export grid.
 * GPU-accelerated replacement for MetadataCube.evaluateAllFields().
 *
 * @param {MetadataCube} cube
 * @param {Float64Array} pixelXCoords - Full-res easting per column
 * @param {Float64Array} pixelYCoords - Full-res northing per row
 * @param {number} width - Export width (after multilook)
 * @param {number} height - Export height (after multilook)
 * @param {number} [ml=1] - Multilook factor
 * @param {Object} [opts] - Same options as interpolateCubeOnGrid
 * @returns {Promise<Object>} { fieldName: Float32Array, ... }
 */
export async function interpolateAllFieldsOnGrid(
  cube, pixelXCoords, pixelYCoords, width, height, ml = 1, opts = {}
) {
  // Build multilook-aligned coordinate arrays
  const exportX = new Float64Array(width);
  const exportY = new Float64Array(height);
  for (let c = 0; c < width; c++) {
    const srcCol = Math.min(Math.round(c * ml + (ml - 1) / 2), pixelXCoords.length - 1);
    exportX[c] = pixelXCoords[srcCol];
  }
  for (let r = 0; r < height; r++) {
    const srcRow = Math.min(Math.round(r * ml + (ml - 1) / 2), pixelYCoords.length - 1);
    exportY[r] = pixelYCoords[srcRow];
  }

  const result = {};
  for (const fieldName of cube.getFieldNames()) {
    result[fieldName] = await interpolateCubeOnGrid(
      cube, fieldName, exportX, exportY, width, height, opts
    );
  }
  return result;
}
