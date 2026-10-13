# River ice U-Net — in-browser inference demo

A trained L-band SAR segmentation model that runs **entirely in the
browser**: no inference server, no egress, no round-trip per tile. Compute,
processing and product ship together as one bundle.

## What it is

A 4-level U-Net (7.77 M params) that classifies NISAR GCOV pixels as
**open water / ice / mixed**. Trained on PlanetScope-derived dense labels
over Alaska rivers during the 2026 breakup, judged against independent
River Watch observer photos.

| | |
|:--|:--|
| Input | NISAR GCOV `HHHH` + `HVHV`, linear power (the viewer converts to dB) |
| Output | 3-class map — 0 open water, 1 ice, 2 mixed |
| Resolution | 10 m native grid — run at native, see constraints |
| Artifact | `app/public/models/river-ice-unet-l.onnx`, 31 MB, opset 17 |
| Test accuracy | 0.923 pixel (confident targets), 0.986 ice-vs-open AUC |
| Photo AUC | 0.819 on held-out spatial blocks |

Checkpoint: `planet_training/models/unet`, 30 epochs. Spatial-block split
(~25 km) so val/test never share a block with train — tiles from one scene
cannot leak across the split.

## Why it is fast

`onnxruntime-web` with WebGPU→WASM negotiation. Measured in headless
Chromium on CPU/WASM:

- **~250–300 ms** per 128×128 tile once the session is warm
- ~1.7 s for the first tile (one-time ORT wasm fetch + session create)
- weights cached in IndexedDB after first load, so a revisit skips the 31 MB

WebGPU, where available, is faster still. The ORT runtime is a lazy
403 kB chunk — the entry bundle pays nothing until a model is actually run.

## The one thing that matters if you touch this

**Preprocessing is compiled into the ONNX graph, not carried in the
manifest.** The dB mean/std standardization (`[-12.113, -18.673]` /
`[8.314, 8.017]`), the validity-mask third channel, and the NaN fill are all
graph nodes.

This is deliberate. SARdine's manifest vocabulary declares a per-band
transform (`none` | `dB` | `power`) and nothing finer, and the ONNX backend
hands the session exactly what the registry transformed — it does **not**
apply `sardine:params.mean/std` (only `builtin-classical` does). Constants
in JSON would therefore sit in a field no backend reads, and a silent
normalization mismatch produces a confident, completely wrong map with no
error at all.

So the graph takes **two** dB channels and builds its own third. A caller
cannot forget the mask channel or supply it inverted.

Three further constraints:

- **Native resolution only — never box-filter the input.** The net reads
  speckle texture, and averaging removes it. Measured on a Yukon reach the
  training labels call 99.9 % ice (2026-05-12, chip s130, 512×506 px):

  | input | water / ice / mixed |
  |:--|:--|
  | native 10 m | 0.42 / 0.58 / 0 |
  | strided 2× (every other pixel) | 0.46 / 0.54 / 0 |
  | 2×2 box mean, power or dB | **1.00 / 0 / 0** |
  | 3×3 box mean | **1.00 / 0 / 0** |

  The manifest declares `sardine:multilook: { max: 1 }` and the app's ROI
  extractor honours it (the default path box-filters any ROI wider than
  384 px, which is exactly the silent failure above — the whole reach
  reads as open water). Native ROIs are allowed up to 2048 px per side;
  the tiled backend handles the size.

- **Tile size must be a multiple of 16.** Four pooling levels floor-divide
  the tile; an odd size makes a skip-connection concat fail outright
  (`Non concat axis dimensions must match`). It errors loudly rather than
  returning a wrong answer, but keep `sardine:tile.size` at 128.
- **L-band only.** This does not transfer to C-band (Sentinel-1) or X-band
  (Capella, ICEYE) imagery.

## Known limitation: it fails on the breakup front

The headline 0.923 pixel accuracy is **mostly the base rate**. Training was
**89.4 % water / 8.6 % ice / 1.9 % mixed** (unweighted soft cross-entropy),
and `mixed` is the largest class in 0.89 % of tiles — so "predict water
everywhere" is close to loss-optimal.

On tiles that contain all three classes at once (ice > 0.15, water > 0.15,
mixed > 0.05 — i.e. the active breakup front, which is the scientifically
interesting case), measured over 40 unique such tiles:

| | |
|:--|:--|
| mean pixel agreement | **0.532** (range 0.217–0.735) |
| mean predicted water | 0.974 |
| mean predicted ice | 0.026 |
| mean predicted mixed | **0.000** |
| tiles predicting zero ice | 27 / 40 |
| tiles > 95 % water | 34 / 40 |

The model **never emits the mixed class**. 0.532 agreement is simply the
water base rate on those tiles.

This is a property of the trained checkpoint, not of the ONNX export: the
PyTorch checkpoint scores identically (0.532 / 0.026 / 0.000) on the same
tiles. The export is faithful.

It does well where one class dominates — ice-dominated tiles 0.83, open
water 1.00 — which is what the aggregate metrics measure. A retrain with
class-balanced or focal loss is the fix.

## Why this is not the lead demo

Beyond the class-imbalance failure, this model is a poor fit for a
first-impression demo, and should sit second in the model list:

- **Valid only on the channel.** Everything outside the river is
  out-of-distribution, so a viewer's first impression is wrong before they
  find the part that is right. A lead demo should look correct across the
  whole ROI without a mask taken on faith.
- **Needs native resolution.** Multilooking silently flips output to all
  water — an invisible constraint for a demo to rest on.
- **Hard to read.** Ice vs. open water on an L-band May scene reads as "the
  dark band is now a lighter band"; it is only legible to the breakup
  community.
- **Provisional granules are not URL-reachable.** The scenes behind it are
  not at ASF, which defeats a paste-a-link story.

Its real job is proving the distribution mechanism: a genuine 31 MB trained
network, exported, cached and run in the browser. For the lead demo, water
vs. not-water on a flood scene is self-evidently right or wrong to anyone,
covers the full ROI, runs fast on a 20 m multilook, and has a precomputed
OPERA DSWx counterpart to agree with.

## Re-exporting

Needs the dedicated pixi env (kept separate so it cannot perturb the
analysis envs):

```bash
pixi global install --environment onnx-export --expose onnx-python=python \
  python=3.12 pytorch-cpu onnx onnxruntime numpy onnxscript

npm run export:model -- \
  --ckpt /mnt/archive/nisar_breakup_2026/planet_training/models/unet/model.pt \
  --out app/public/models/river-ice-unet-l.onnx
```

`-I` matters: a `~/.local` protobuf otherwise shadows the env's own and
onnx fails to import.

The exporter self-verifies and refuses to emit a model that fails:
torch-vs-onnxruntime max-abs-diff (tolerance 1e-4), argmax agreement, a tile
containing NaNs to exercise the mask path, and a second tile size to prove
the dynamic axes. Observed: **3.3e-06** max diff, **1.000000** argmax
agreement.

## Testing

```bash
npm run test:model
```

Drives the real `src/ml/registry.js` path in headless Chromium against two
labelled tiles (an ice-dominated Yukon tile, an open-water Tanana tile) and
asserts agreement with their PlanetScope ground truth. It is separate from
`npm test` because it launches a browser (~40 s).

Current: ice tile 0.829 agreement / 0.992 predicted ice (truth 0.824);
water tile 1.000 agreement / 0.000 false ice.

**Do not replace the fixtures with synthetic tiles.** Flat value + speckle
reads as water at every brightness — the model keys on texture, so uniform
fill tests nothing and will appear to show a broken model.
