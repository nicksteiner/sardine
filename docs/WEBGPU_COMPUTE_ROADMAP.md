# WebGPU Compute Module — Roadmap

Hybrid architecture: WebGPU compute shaders running alongside the existing
deck.gl 8.9 + WebGL2 rendering pipeline.

## Architecture

```
h5chunk / geotiff.js (CPU)
  ↓ Float32Array
WebGPU storage buffer (mapAsync zero-copy upload)
  ↓
Compute pass: histogram / spatial filter / multilook
  ↓ storage buffer
mapAsync readback → Float32Array
  ↓
WebGL2 R32F texture (existing SARGPULayer)
  ↓
Fragment shader (dB → stretch → colormap → screen)
```

deck.gl stays for viewport management, tile lifecycle, and MapLibre integration.
WebGPU handles the heavy per-pixel compute that WebGL2 fragment shaders can't
do efficiently (neighbor access, reductions, atomics).

## Release 1 — Real-Time GPU Histogram

**Goal:** Replace the CPU histogram path (`stats.js`) with a WebGPU compute
shader that bins an entire tile in <1ms. Histogram updates in real time as
the user pans, zooms, or adjusts parameters.

### Deliverables

1. **`src/gpu/webgpu-device.js`** — Device manager
   - `navigator.gpu` feature detection + device initialization
   - Adapter/device caching (singleton)
   - Graceful fallback flag when WebGPU unavailable
   - Limits query (maxComputeWorkgroupSize, maxStorageBufferBindingSize)

2. **`src/gpu/histogram-compute.js`** — GPU histogram compute pipeline
   - WGSL compute shader: atomic binning of Float32 data
   - Supports dB mode (10·log₂(x)·0.30103 in shader)
   - 256 bins, configurable range or auto min/max
   - Two-pass architecture:
     - Pass 1: parallel min/max reduction (workgroup shared memory)
     - Pass 2: atomic histogram binning into storage buffer
   - Readback: `mapAsync` → Uint32Array → JS stats object
   - Output format matches `computeChannelStats()` return shape

3. **`src/gpu/gpu-stats.js`** — Drop-in replacement for CPU stats
   - `computeChannelStatsGPU(data, useDecibels, numBins)` — same signature
   - Returns `{bins, min, max, mean, binWidth, count, p2, p98}`
   - Falls back to CPU `computeChannelStats()` when WebGPU unavailable
   - Percentile walk (p2/p98) runs on CPU from GPU bin counts (trivial)

4. **Integration into `app/main.jsx`**
   - Replace histogram computation calls with GPU path
   - Remove debounce delay (GPU histogram is fast enough for every frame)
   - Real-time histogram update on viewport change

5. **`src/utils/gpu-detect.js`** update
   - Add `webgpu: boolean` and `computeShaders: boolean` to probe result

### Performance Target

| Metric | CPU (current) | GPU (target) |
|--------|--------------|--------------|
| 512×512 tile histogram | ~15ms | <1ms |
| 4096×4096 full image | ~200ms | <2ms |
| Update latency | 800ms debounce | Every frame |

## Release 2 — GPU Spatial Filters

**Goal:** Lee, boxcar, and Gaussian speckle filters running as compute
shader passes with workgroup shared memory.

### Deliverables

1. **`src/gpu/spatial-filter.js`** — Compute shader spatial filters
   - Boxcar (mean) NxN
   - Lee adaptive filter (local stats from shared memory)
   - Gaussian separable (2-pass horizontal + vertical)
   - NaN/zero masking in kernel
   - Configurable kernel size (3×3 to 15×15)

2. **Filter → WebGL2 bridge**
   - Compute shader writes filtered data to storage buffer
   - Readback → Float32Array → `gl.texImage2D()` into R32F texture
   - SARGPULayer renders filtered texture through existing shader chain

3. **UI controls**
   - Filter type selector
   - Kernel size slider
   - Real-time preview (filter runs on viewport tiles)

4. **Export parity**
   - GPU filters available in export path
   - Match CPU `smoothBand()` output for regression testing

## Release 3 — GPU Multilook & Pipeline Optimization

1. **GPU multilook reduction** — Replace CPU box-filter multilook
2. **Buffer mapping upload** — h5chunk → mapped staging buffer → GPU
3. **Batch compute** — Run histogram + filter in single command encoder submit
4. **RGB channel parallel** — 3-channel histogram in one dispatch

## Release 4 — Advanced Compute

1. **GPU threshold/flood mask** — Interactive threshold with pixel counting
2. **Integral image (prefix sum)** — O(1) box filter at any kernel size
3. **Local contrast enhancement** — Move `tone-mapping.js` to GPU
4. **Change detection** — Multi-temporal difference on GPU

## Non-Goals (For Now)

- Replacing deck.gl with raw WebGPU rendering
- WebGPU fragment shaders (keep WebGL2 render path)
- WGSL ports of existing GLSL colormaps
- Mobile WebGPU (desktop-first, mobile is a stretch goal)

## Browser Requirements

| Browser | Minimum Version |
|---------|----------------|
| Chrome  | 113+ |
| Edge    | 113+ |
| Firefox | 141+ |
| Safari  | 26+ (macOS Tahoe / iOS 26) |

Fallback to CPU `stats.js` when WebGPU is unavailable.
