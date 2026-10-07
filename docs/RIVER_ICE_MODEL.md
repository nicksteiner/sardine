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
| Resolution | 10 m native; trained across 10–30 m |
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

Two further constraints:

- **Tile size must be a multiple of 16.** Four pooling levels floor-divide
  the tile; an odd size makes a skip-connection concat fail outright
  (`Non concat axis dimensions must match`). It errors loudly rather than
  returning a wrong answer, but keep `sardine:tile.size` at 128.
- **L-band only.** This does not transfer to C-band (Sentinel-1) or X-band
  (Capella, ICEYE) imagery.

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
