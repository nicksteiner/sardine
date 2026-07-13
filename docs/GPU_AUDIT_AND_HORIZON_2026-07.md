# GPU Audit & Technology Horizon — July 2026

Synthesis of three research tracks (2026-07-13): an audit of SARdine's GPU code, a
survey of WebGPU capabilities shipped/flagged/proposed, and a survey of comparable
browser-native scientific viewers. Complements docs/PLATFORM_REVIEW.md and
docs/WEBGPU_COMPUTE_ROADMAP.md.

---

## 1. Where SARdine's GPU usage stands today

### Working and wired
- **WebGL2 rendering** (SARGPULayer + shaders.js): R32F textures, in-shader dB
  conversion, 6 stretch modes, 18 colormaps (polynomial/piecewise GLSL), per-channel
  RGB contrast, CVD matrices, NISAR mask/coherence/incidence handling, 4 GUNW phase
  correction layers. ~4–8 ms/tile. This is the most complete Float32 science-raster
  shader pipeline found anywhere in the survey.
- **WebGPU compute** (src/gpu/): 3-pass histogram (256-thread tree reduction →
  workgroup-local atomic binning → per-bin reduce) and five WGSL speckle filters
  (boxcar/Lee/enhanced Lee/Frost/Gamma-MAP) with 16×16 workgroups + halo tiles and
  CPU fallbacks. `computeChannelStatsAuto`/`sampleViewportStatsAuto` **are wired**
  into app/main.jsx (histogram panel, RGB stats, overview stats) — W007 landed.
- **Decode worker pool** (W006) is integrated into h5chunk (`useWorkerPool = true`),
  so pako inflate/unshuffle no longer blocks the main thread. IndexedDB L2 chunk
  cache (W009) shipped.
- **WebGL2 FBO speckle filtering** (webgl-spatial-filter.js) for interactive preview
  without readback.

### Genuine remaining CPU gaps
| Gap | Where | Cost | Fix |
|---|---|---|---|
| **Export re-renders on CPU** — `createRGBTexture` per-pixel JS loop duplicates the shader's dB/stretch/colormap logic | app/main.jsx:4410, 4669; sar-composites.js:391–479 | 26–40 ms/tile + a second implementation to keep in sync | Render export tiles through the existing WebGL2 pipeline into an FBO + one `readPixels` per tile. Guarantees export parity by construction. |
| **Composite band math on CPU** — ratio formulas, Freeman–Durden decomposition | sar-composites.js | cached per composite, acceptable today | Move to shader modules when decompositions un-park (see §3, deck.gl-raster pattern). |
| **Multilook box filter** | export path | ~1.5 ms, fine | Optional WGSL kernel (roadmap Release 3). |
| **GeoTIFF DEFLATE compression** | geotiff-writer.js (pako) | codec-bound | Keep on CPU; optionally swap pako → libdeflate-WASM (~2×). GPU decompression for DEFLATE does not exist on the web and is not coming (bit-serial format). |

### Architecture seams (unchanged, and still correct)
- WebGL2 (deck.gl) and WebGPU (singleton device) are separate contexts; data crosses
  only via CPU Float32Arrays. No zero-copy exists in the platform yet
  (gpuweb#2388); `mappedAtCreation` + decode-into-`getMappedRange` is the one-copy
  floor. Chrome 145's experimental worker `mapSync()` is the thing to track — it
  maps directly onto the decode-pool (decode straight into a mapped GPU buffer).
- `hasWebGPU()` probes only `navigator.gpu` — it never requests an adapter, so it
  can't see feature bits (subgroups, float32-filterable) or compat-mode adapters.
  Needs an async capability probe once optional features are used.

**Verdict:** the WebGL2-primary-render + WebGPU-compute split is validated
externally — deck.gl 9.3's WebGPU backend still can't render bitmap layers, picking,
or basemap interleaving ("not production ready" per its own docs); vtk.js/Cesium/
Cornerstone3D/MapLibre have all *not* shipped production WebGPU rendering. Nobody
credible is WebGPU-render-only in 2026.

---

## 2. WebGPU platform: what to adopt, when

### Adoption reality (mid-2026)
All four engines ship WebGPU: Chrome 113+ (Linux: 144+ Intel, 147+ NVIDIA/Wayland;
AMD still flagged), Firefox 141+ (Windows; macOS AS 145–147; **Linux/Android still
Nightly, expected 2026**), Safari 26 (Sept 2025, macOS/iOS/iPadOS/visionOS).
~83–85% global reach (caniuse). Compat mode (GLES 3.1-class) shipped Chrome 146 —
recommendation: **require core WebGPU, fall back to WebGL2**; don't maintain a
compat-mode compute variant. Firefox-on-Linux is the one gap that matters for a
geoscience audience — the CPU fallbacks must stay.

### Shipped features worth adopting now (all need `adapter.features` checks)
1. **`subgroups`** (Chrome 134+): subgroup tree reductions in the histogram/stats
   and filter kernels; Google measured 2.3–2.9× on reductions. Keep the
   workgroup-memory path as fallback (subgroup size is non-uniform, 4–128; not yet
   confirmed in Safari/Firefox).
2. **`float32-filterable`** (Chrome 119+, near-universal desktop): hardware bilinear
   on r32float — free resampling of SAR tiles.
3. **`float32-blendable`** (Chrome 132+): blend/accumulate into r32float render
   targets — multilook averaging via ROPs, density splats.
4. **Read-write storage textures on r32float** (Chrome 124+, expanded by
   texture-formats-tier1/2 in 142): in-place iterative speckle filters without
   ping-pong buffers.
5. **`timestamp-query`** (Chrome 121+, 100 µs quantized): per-pass profiling of
   decode → histogram → filter; wire into the benchmark suite.
6. **`shader-f16`** (Chrome 120+): use for filter weights/LUTs and ML inference
   only. **Never accumulate SAR power in f16** — max 65504 clips the dynamic range.
7. **WGSL niceties**: `unrestricted_pointer_parameters` (cleaner shared filter
   kernels), DP4a packed-int8 dot ops (quantized on-device classification).

### High-value kernels no one has written yet (all buildable today)
- **WGSL compute pyramid** for overviews: mean-power/min/max/valid-count per texel
  with NaN/zero masking, SPD-style 4-levels-per-dispatch. Bilinear mips are
  statistically wrong for dB data — this is a *correctness* feature, not just perf,
  and it feeds auto-stretch. WebGPU has no built-in generateMipmap anyway.
- **Batched small-tile WGSL FFT** (~300 lines, storage-texture ping-pong butterfly;
  proven pattern in FFT-ocean demos at 512² @ 60 fps). No production WebGPU FFT
  library exists (VkFFT has no WebGPU backend). Unlocks Goldstein phase filtering,
  spectral filtering, patch co-registration — the friendliest FFT case (32–256 px
  batches).
- **DCT least-squares phase unwrap** (a Poisson solve = 4 DCTs, rides on the FFT;
  129 fps/MP demonstrated in CUDA). Fine for interactive *browse* unwrap (L2
  smooths residues); pair with **WASM-compiled SNAPHU in a worker** for ROI-scale
  rigorous unwrap. Zero browser implementations of either exist — both would be
  firsts.

### 12–24 month horizon (plan, don't build on)
| Item | Status | Impact when it lands |
|---|---|---|
| Bindless / sized binding arrays | proposal; Chrome shipped WGSL groundwork (`texture_and_sampler_let`, 146); ~2027 | all loaded chunks bound at once; kills per-tile bind-group churn |
| Subgroup matrix (cooperative matmul) | draft + Chromium experimental flag | tensor-core matmul in WGSL → fast CNN inference without ORT |
| Texture atomics / 64-bit atomics | proposals | one-pass scatter histogram (current 3-pass design remains correct today) |
| Texel buffers | proposal | formatted access to buffers beyond max texture dims (long SAR stripes) |
| Worker `mapSync()` / UMA mapping | Chrome 145 experiment | true zero-copy decode→GPU on unified memory (Apple Silicon laptops) |
| WebNN | W3C CR Jan 2026; Chrome OT; not production | NPU offload for inference, ~2027; don't build on it |
| deck.gl v9 migration | v9.3.6 current; WebGPU layers still preview | migrate for WebGL2 modernization value only (UBOs, GLSL 3.00, Device API — kepler.gl took until 2026); luma.gl `Computation` could consolidate the compute harness. Keep at P7. |

---

## 3. What comparable projects do (and what to steal)

Nobody else does client-side SAR compute. The two structural bets — serverless
chunk-level streaming and GPU-first Float32 rendering — are being *converged upon*
by others (NASA GIBS moving toward LERC client-side rendering; NASA's
zarr-visualization-report endorsing the dynamic-client approach carbonplan uses).

| Project | Stack | Technique worth stealing |
|---|---|---|
| **carbonplan/zarr-layer** (v0.6, active) | zarrita + MapLibre custom layer, user GLSL hooks | **GPU mesh reprojection** (`@developmentseed/raster-reproject`) — arbitrary-CRS display of UTM OPERA/RTC COGs on web-mercator basemaps. The one rendering capability where a comparable is clearly ahead. |
| **Sentinel Hub / Copernicus Browser** | server-side V8 evalscripts → 8-bit tiles | the **evalscript UX** + curated community script gallery — but compiled client-side to GLSL/WGSL instead of a server |
| **OpenLayers WebGL GeoTIFF** | JSON style expressions compiled to shaders | serializable expression→shader compilation (pairs with W010 RenderConfig + deep links) |
| **deck.gl-raster** (DevSeed) | composable WebGL shader modules | shader-module chain (dB → despeckle → stretch → colormap) instead of monolithic shaders.js — makes W011 threshold and future indices insertable |
| **Viv/Avivator** (bioimaging) | deck.gl, client-side OME-TIFF/Zarr | **N-channel additive compositor with per-channel LUTs** (generalizes Pauli/dual-pol AND multi-date change composites); the **lens** — in-viewport circular A/B comparator (raw vs despeckled, date vs date) |
| **Neuroglancer** (Google) | worker chunk engine, sharded format | visibility-prioritized chunk scheduling with cancellation; in-UI GLSL editor precedent; **full session state in URL** |
| **Cornerstone3D** (medical) | single shared WebGL context, offscreen composite | shared-context rendering for CompareGrid (4 panels currently = 4 contexts); mature GPU segmentation brush/threshold tools as W011 model |
| **ASF Displacement Portal / EGMS** | server precompute + charts | point-click time-series chart UX (linear fit, shift-to-zero, CSV) — the bar for SARdine time series |
| **H5Web/h5wasm** | WASM HDF5, needs full file or server | confirms **h5chunk's client-side chunk-index range streaming is genuinely unique** |
| **Zarr ecosystem** (zarrita, VirtualiZarr/Icechunk) | v3 sharding = h5chunk's access pattern, standardized | **emit/consume kerchunk-style chunk manifests** (instant reopen, shareable indexes) and add zarrita-based Zarr v3 as a sibling backend — positions h5chunk as "kerchunk for the browser" (W012) |

### ML in the browser (W011 fuel)
- **onnxruntime-web WebGPU EP is production-grade** (ORT 1.17+, hardened through
  1.27): GPU-buffer IO binding (`Tensor.fromGpuBuffer()` — feed the WebGPU-side
  tile buffer directly), graph capture for static-shape tile models, fp16.
  transformers.js v3/v4 wraps it (SAM/SlimSAM/SAM2/SAM3 pipelines built in).
  TF.js is maintenance-mode — don't build on it.
- **SAM2 fully client-side is proven** (webgpu-sam2; Labelbox ships hybrid in
  production). Recipe: encode rendered viewport once (~1–5 s tiny encoder, cache
  embedding in OPFS), decode per click prompt (~10–100 ms). SAM needs the
  *rendered* (dB-stretched, ideally despeckled) RGB as encoder input — which
  SARdine uniquely already computes on GPU.
- **Nobody has shipped browser-native SAR flood segmentation or ML despeckling.**
  SAR2SAR/Sen1Floods11-class UNets (5–50M params) export to ONNX cleanly; a 512²
  Float32 tile runs in ~30–200 ms on WebGPU with graph capture; q8 weights are
  5–50 MB (cacheable like chunks). Open first-mover lane.

---

## 4. Ranked recommendations

### Now (weeks — close audit gaps, adopt shipped features)
1. **GPU export parity**: render export tiles through the existing WebGL2 shader
   pipeline via FBO + readPixels; delete the duplicated CPU dB/stretch/colormap in
   `createRGBTexture`. Perf and correctness-by-construction.
2. **Async WebGPU capability probe** (adapter features + limits, compat detection)
   replacing the `navigator.gpu` boolean; then request `float32-filterable`,
   `float32-blendable`, `timestamp-query`.
3. **Subgroup-accelerated histogram/stats** behind the feature check.
4. **WGSL compute pyramid** (nodata-aware mean/min/max overviews).

### Next (1–2 quarters — the differentiators)
5. **W011 with SAM2-in-browser** (ORT-web WebGPU, encoder-once/decode-per-click,
   accept/reject → GPU mask texture → STAC-labeled export). Highest
   novelty-to-effort in the entire survey; no geospatial viewer has shipped it
   client-side.
6. **Client-side evalscripts**: user-editable per-pixel script/expression panel
   compiled to shader modules (refactor shaders.js into a module chain first);
   serializes into W010 RenderConfig and deep links. Turns SARdine from
   preset-viewer into programmable instrument with zero server.
7. **Client-side InSAR phase toolkit**: proper wrapped-phase shader (cyclic
   colormap + GPU re-referencing/rewrap), GUNW/OPERA-DISP date differencing in
   shader; then batched WGSL FFT → Goldstein filter → DCT browse-unwrap; WASM
   SNAPHU for ROI unwrap. Every existing InSAR portal is precompute-and-chart —
   this lane is empty.
8. **ML despeckle toggle** (SAR2SAR-class ONNX UNet) beside the WGSL Lee/Frost
   filters — headline feature, no prior art anywhere.

### Strategic (with W012)
9. **Chunk-manifest interop**: h5chunk exports/imports kerchunk-JSON-style
   manifests; add zarrita Zarr v3(+sharding) as a second array backend.
10. **GPU mesh reprojection** (adopt/port `@developmentseed/raster-reproject`) for
    arbitrary-CRS display.
11. **Viv-style N-channel compositor + lens**; **Neuroglancer-grade chunk
    prioritization** and fuller state-in-URL as ongoing polish.

### Explicitly do NOT do
- WebGPU rendering migration (deck.gl WebGPU can't do bitmap/picking/basemaps; no
  one has shipped it; revisit 2027 with bindless).
- GPU chunk decompression (DEFLATE is bit-serial; no web implementation exists;
  worker pool is the ceiling — optional libdeflate-WASM swap only).
- Building on WebNN or TF.js.
- f16 accumulation of SAR power (dynamic-range clipping).
