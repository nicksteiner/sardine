# SARdine Implementation Plan — Work Orders

Machine-executable work orders derived from `docs/PLATFORM_REVIEW.md`. Each `W###_*.md`
is self-contained: an agent (or human) can pick it up with no conversation context.
This mirrors the `.sardine/` directive system in `~/sandbox/sardine-agent` — same
philosophy applied to engineering: explicit acceptance criteria, status tracking,
findings appended when something doesn't work.

## Conventions

- **Frontmatter fields:** `wave`, `status` (`todo | launched | branch-ready | pr-open | merged | blocked | abandoned`), `blocked_by`, `branch`.
- **Acceptance criteria are runnable commands.** A work order is not done until every
  criterion passes. `npm test` and `npm run build` must pass for ALL work orders.
- **One work order → one branch → one PR.** Branch names: `w###-short-name`.
- **Findings:** if an agent cannot complete a work order or discovers the premise is
  wrong, it appends a `## Findings` section (what was tried, why it failed) and sets
  `status: blocked` — never silently abandons. (Same rule as `.sardine/rejected_hypotheses.md`.)
- **Repo ground rules** (from CLAUDE.md): plain JS (no TypeScript in app code), ES
  modules, minimal deps, GPU-first, no server required, export parity.

## The flywheel (why these orders, in this order)

Stream → interpret → adjudicate → learn → propose better. Every wave lands a flywheel
piece, not just hygiene. See `docs/PLATFORM_REVIEW.md` §6–7 for the strategy.

## Wave graph

```
Wave 0 (safety net):        W001 tests   W002 dead-code   W003 abort-fix
                                │                             │
Wave 1 (parallel):          W004 annotation-geojson  W005 export-sidecar
                            W007 gpu-histogram       W008 deep-links
                                                          W006 decode-workers (after W003)
                                                          W009 chunk-cache-L2 (after W006)
Wave 2 (design-gated):      W010 scene/renderconfig/session schema  ← HUMAN SIGN-OFF
                                │  then store extraction (strangler PRs, spawned from W010)
Wave 3 (vertical slice):    W011 flood workflow end-to-end (SAM assist + agent proposals
                                 + accept/reject + STAC-labeled export)
Wave 4 (publish):           W012 h5chunk to npm, schemas as draft STAC extensions,
                                 public demo instance
```

## sardine-agent API ground truth (do not invent APIs)

The companion agent lives at `~/sandbox/sardine-agent` (v0.5.0 — the ACTIVE checkout;
`~/workspace/sardine-agent` is stale).

- **JS API:** `SardineAgent` class (`src/agent/index.js`): `listDatasets(source)`,
  `info(source, opts)`, `open`, `readRegion(source, opts)`, `stats`, `histogram`,
  `sample(source, points, opts)`, `render`, `exportGeoTIFF`, `exportMultiBand`,
  `renderChunk`, `listComposites`, `search`, `rankScenes`, `download`, plus SWOT
  (`swotInfo/swotReadPixels/swotReadWater/swotComputeArea`) and ICESat-2
  (`icesat2Info/icesat2ReadPhotons/icesat2ReadSegments`).
- **MCP tools** (`src/agent/tools.ts`, ~40 tools): `sardine_list_datasets`,
  `sardine_info`, `sardine_stats`, `sardine_histogram`, `sardine_render`,
  `sardine_export`, `sardine_export_multiband`, `sardine_render_chunk`,
  `sardine_batch_stats`, `sardine_search`, `sardine_rank_scenes`,
  `sardine_search_and_rank`, `sardine_download`, `sardine_explore`,
  `sardine_resolve_url`, `sardine_resolve_s3`, `sardine_s3_credentials`,
  `sardine_temporal_stack`, S1 family (`sardine_s1_search`, `sardine_s1_submit_rtc`,
  `sardine_s1_submit_insar`, `sardine_s1_check_jobs`, burst tools), SWOT + ICESat-2
  families, `sardine_report_error`, `sardine_request_feature`.
  **There is no `sardine_annotate` or `sardine_write_mask` yet** — W011 adds them.
- **Sidecar collision warning:** `{filename}.sardine.json` is ALREADY TAKEN — it is the
  NITF scene-geometry sidecar (schema at `~/sandbox/sardine-agent/sardine.json`:
  version/jigger/demSource/mode). Export-provenance sidecars use `{output}.tif.json`.
- **Findings schema** (`.sardine/EXPERIMENT_RULES.md`) fields to stay aligned with:
  `hypothesis, datasets, metrics, outcome (confirmed|rejected|inconclusive|preliminary),
  confidence (0–1), limitations, parent_finding_id, next_questions`.

## Repo state note (July 2026)

The primary working tree (branch `optical-peek-georef-fix`) carries uncommitted work:
compare-grid NISAR support, annotation size presets (`AnnotationOverlay.jsx`,
`annotation-render.js`, `main.jsx`, `stats.js`, `figure-export.js`, `SARViewer.jsx`,
`test/run-tests.js` modified; `ROIProfilePanel.jsx`, `CompareGrid.jsx` untracked).
Worktree agents branch from HEAD and will NOT see these changes. Work orders touching
those files must keep their touch surface minimal (new modules preferred) and expect a
rebase when the WIP lands.
