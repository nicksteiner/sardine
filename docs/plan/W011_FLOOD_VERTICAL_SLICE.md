# W011 — Flood workflow vertical slice (close the flywheel once)

wave: 3
status: todo
blocked_by: [W010]
branch: w011-flood-slice

## Objective

One workflow, fully closed: stream a NISAR granule → GPU threshold + assisted
segmentation proposes water extent → analyst corrects in the viewer → export a
STAC-labeled GeoJSON/mask bundle that is simultaneously a product and a training
example. This is PLATFORM_REVIEW.md Phase 3 made concrete.

## Components (each becomes its own PR; this order is the epic)

1. **Interactive threshold + area readout** — WGSL threshold/count compute pass (or
   CPU fallback) driving a live "flood area: N km²" readout; mask rendered as overlay
   (`docs/MULTI_PRODUCT_ROADMAP.md` Mode 3 thresholds, single-product HH version first).
2. **Mask export** — uint8 COG mask + class table + W005 sidecar + STAC Item with
   label extension fields (`label:classes`, `label:methods: ["manual","gpu-threshold"]`,
   `derived_from`).
3. **Proposal/adjudication states** — markup features (W004 schema) gain
   `observer: "ai" | "human"`, `adjudication: "pending" | "accepted" | "edited" | "rejected"`;
   pending features render dashed; accept/edit/reject UI updates provenance.
4. **Agent write-back** — NEW MCP tools in `~/sandbox/sardine-agent/src/agent/tools.ts`
   following its existing tool patterns (Zod schema, SardineAgent method):
   `sardine_annotate` (emit W004-schema GeoJSON features for a scene) and
   `sardine_write_mask` (emit classified mask GeoTIFF + STAC label metadata). The
   agent's existing `readRegion`/`stats`/`renderChunk` methods supply the analysis;
   these tools only standardize the OUTPUT format. Viewer loads the file the agent
   wrote (shared-schema handoff — no live socket needed for the slice).
5. **In-browser assist (stretch)** — SAM-class encoder via ONNX Runtime Web
   (WebGPU backend, WASM fallback) for click-to-segment on the current viewport,
   emitting proposals in the same schema.

## Acceptance criteria (slice-level)

- Demo script in PR: real NISAR GCOV flood scene → threshold → agent proposal file
  loaded → one polygon edited → accepted → exported bundle contains mask COG +
  GeoJSON where the accepted feature records both `observer: "ai"` and the human
  adjudication with timestamps.
- All exports validate against W010 schemas; `npm test` green in both repos.
