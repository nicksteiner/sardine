# D285: Can we add the NISAR Ecosystems notebooks into SARdine?

**Short answer: yes, for three of the four.** The Inundation, Crop Area, and
Disturbance ATBDs are pure numeric algorithms that fit cleanly into SARdine's
existing Float32Array-in / raster-out pipeline. They have been ported in this
session and live under `src/algorithms/`. The Biomass ATBD is a different
shape of problem and is left out of scope until we scope a physical-model
retrieval path (MIMICS-style).

## Notebooks surveyed

All four come from the NASA/JPL NISAR Applied Science ATBD notebook set, Oct 1
2021 release, stored at:

    /media/nsteiner/data1/City College Dropbox/Nicholas Steiner/NISAR/ATBD Jupyter Notebooks/

| Notebook       | Size  | Core algorithm                                   | Ported |
|:---------------|:------|:-------------------------------------------------|:-------|
| Inundation     | 30 MB | Threshold decision tree on HH and HH/HV with a rolling-mean per-scene correction; 6 classes + masked | yes    |
| Crop Area      | 197 MB | Per-pixel temporal coefficient of variation + Youden-optimal threshold against a CDL reference | yes    |
| Disturbance    | 1.1 GB | Mean-residual CUMSUM + bootstrap permutation test on a SAR time-series stack | yes    |
| Biomass        | 19.5 GB | Allometric / physical-model biomass retrieval (details hidden inside notebook + large data) | **deferred** |

## Why three of four port easily

Sardine already provides everything an ATBD needs up to the point of
"I have a stack of co-registered Float32 power rasters":

- Chunk-wise HDF5 + COG streaming (`src/loaders/`)
- Multi-temporal stack loading and multilook (`loadNISARGCOV`)
- Masking, stats, and histogram utilities (`src/utils/stats.js`)
- GeoTIFF export of rasters, including Uint8 classification maps
  (`src/utils/geotiff-writer.js`)

The three ATBDs we ported are each 100–300 lines of pure `Float32Array`
arithmetic with no Python-specific dependency. They were ported verbatim from
the notebooks' algorithm cells. See:

    src/algorithms/inundation.js
    src/algorithms/crop-cv.js
    src/algorithms/disturbance-cusum.js

They run in Node (they power the new test suite), in the browser main thread,
and should drop cleanly into Web Workers for the larger stacks. No GLSL is
needed yet — these are all per-pixel temporal reductions that the CPU handles
at interactive speeds on tiles.

## What's deferred: Biomass

The Biomass ATBD zip is 19.5 GB and wasn't extracted this session. Biomass
retrieval is fundamentally different from the other three — it inverts a
scattering model (MIMICS-style or empirical regression) rather than computing
a temporal statistic. H003 / H018 / H019 in `RESEARCH_ROADMAP.md` are already
active lab work on MIMICS, so Biomass ATBD integration should be scoped
alongside that thread rather than as a one-off port. Spawn a child directive
when there is a clear target (e.g. "wrap the MIMICS Python code into a server-
mode endpoint"; "inspect the Biomass notebook base_code/atbd.pro").

## Integration decisions

### 1. Pure-JS ports, not a Python sidecar

The three algorithms port into <300 lines each. A Python backend would add a
deployment dependency for what amounts to `np.mean`, `np.std`, `np.cumsum`,
and threshold operations. Keeping them pure JS preserves SARdine's "no server
required" property (CLAUDE.md §Tech Stack) and lets them run in the browser
against files the user loaded locally.

### 2. Plain CPU, not GLSL — for now

All three algorithms are temporal reductions across N frames. GLSL can help
later (especially for classify + render loops on big scenes), but the bottle-
neck today is chunk I/O, not classification compute. Stay CPU until profiling
shows otherwise.

### 3. Deterministic, seedable bootstrap

`disturbance-cusum.js` takes an injectable `rng` so the bootstrap is
reproducible in tests and in notebooks. The default is `Math.random`.

### 4. Notebook ↔ ported-code provenance is preserved in comments

Each module's docstring references the source notebook and the algorithm's
intent; no equation numbers were renamed. If JPL publishes v2 of an ATBD we
can diff cell-by-cell.

## What's next (not this session)

1. Wire each algorithm into `app/main.jsx` as a menu action so a user can
   load a stack and compute an inundation / CV / disturbance map without
   leaving the browser.
2. Add a colormap + export path for the 6-class inundation output (reuse
   `geotiff-writer.js` with a Uint8 palette GeoTIFF).
3. Benchmark on a real NISAR L2 GCOV or UAVSAR NISAR-A stack. The inundation
   notebook's validation data is in the zip under `Inundation notebook/SAR_data/`
   — the `.flt` files are raw little-endian Float32 and can be ingested with
   `struct.unpack`-equivalent JS (a tiny shim or `new Float32Array(buf)`).
4. Scope Biomass separately: it needs the MIMICS side of the lab, not
   ecosystem-ATBD porting.
5. Cross-validate ported algorithms against the original notebook outputs.
   The Inundation zip ships reference `class{0..4}.bin` rasters; regression-
   test the JS port against those to catch any pipeline drift.

## File map

```
src/algorithms/
├── index.js                 namespaced re-exports
├── inundation.js            classifyPair, runInundationATBD, default thresholds
├── crop-cv.js               coefficientOfVariation, rocCurve, runCropCvATBD
└── disturbance-cusum.js     subtractMean, cumsumTime, sdiff, runDisturbanceATBD

test/run-tests.js            new suite "NISAR ATBD algorithms" (20 checks)
```
