---
wave: standalone (viewer; parallel to GPU track)
status: implemented in working tree (2026-07-13) — see Findings
blocked_by: []
branch: (implemented directly in the primary working tree by PI instruction; no worktree branch)
---

# W026 — Optical Peek: viewport detail atlas to provider max resolution

## Objective

The optical peek overlay (`src/layers/OpticalPeekLayer.js`) built one scene-wide
atlas at a fixed zoom capped at 1024 tiles. Provider max resolution (Esri World
Imagery z19 ≈ 0.3 m/px) over a whole NISAR scene is ~10⁵ tiles — four orders of
magnitude past the cap — so zooming into the SAR showed scene-level blur exactly
when the user wants to peek at buildings/field boundaries. Make optical
resolution track the screen up to the provider maximum, and fix the correctness
bugs that become visible at high zoom.

## Existing machinery (do not reinvent)

- Warp-grid reprojection + token/abort rebuild cancellation + FLIP_Y pinning:
  all already in `OpticalPeekLayer.js` — the detail path reuses `buildPeek`,
  `_uploadTextures`, and the token pattern unchanged.
- `SARTiledCOGLayer.js` `shouldUpdateState` shows the viewport-reactive layer
  pattern; deck.gl `changeFlags.somethingChanged` includes `viewportChanged`.
- OrthographicView `viewState.zoom` is log2(screen px per world unit)
  (`src/viewers/SARViewer.jsx`); `viewport.getBounds()` gives the visible
  world rect.

## Scope (as implemented)

1. **Two-level atlas.** Base = scene-wide (as before, coverage guarantee).
   Detail = viewport-tracking atlas rebuilt on debounced (250 ms) viewport
   change at `zDetail = ceil(log2(156543·cos(lat) / metersPerScreenPx))`,
   clamped to per-provider `maxZoom` (new prop, default 19). Fragment shader
   tries detail first, falls back to base. Skipped when `zDetail <= baseZ`
   or the request reproduces the current detail key.
2. **Warp validity fix.** The (-1,-1) invalid-node sentinel was blended by
   hardware LINEAR filtering into positive-but-wrong UVs (and RG32F LINEAR
   needs the optional `OES_texture_float_linear` anyway). The shader now
   texelFetches the 4 corner nodes and interpolates manually, rejecting any
   cell that touches an invalid node. Warp textures are NEAREST.
3. **Web Mercator domain guards.** Nodes beyond ±85.0511° are flagged invalid
   (polar-stereo scenes degrade gracefully instead of requesting nonexistent
   tiles); tile y clamped to [0, 2^z); tile x wrapped modulo 2^z in URLs.
4. **Cap-fitted zoom instead of throwing.** Requested zoom steps down until
   the tile range fits BOTH the 1024-tile total and a 64-tile-per-axis cap
   (a tile row must fit the browser max canvas dimension; the old total-only
   cap allowed long-thin scenes to exceed it).
5. **Tile fetch hygiene.** Module-level LRU ImageBitmap cache (384 entries,
   404s cached as null), in-flight dedupe, bounded concurrency (12), and
   overzoom parent-tile fill (up to 3 levels) where provider coverage ends.
6. **Math extracted to `src/utils/optical-peek-math.js`** (pure, zero-dep) so
   tile/zoom/rect math is node-testable without deck.gl in the import graph.
7. **Status surfacing.** New optional `onStatus(level, message)` layer prop,
   wired to `addStatusLog` in `app/main.jsx`; providers there became
   `{url, maxZoom}` records.

## Out of scope

- Deep-link params for optical peek state (follow DEEP_LINKS.md short/long
  convention if added later).
- Export parity: the overlay still does not composite into GeoTIFF/figure
  exports (pre-existing gap, unchanged by this order).
- Date-stamped imagery providers (NASA GIBS `{Time}` WMTS) — natural next
  order on top of the provider-record change in main.jsx.
- WebGL context-loss recovery (repo-wide gap, AUDIT.md item 6).

## Acceptance criteria

- [x] `node test/unit/optical-peek-math.test.mjs` — 26 tests green (tile math
      ground truth, Mercator domain guards, cap fitting incl. long-thin strip,
      screen-density zoom pick incl. cos(lat), UV rect round-trips).
- [x] `npm test` — full suite green (272 structural + pipeline + 10 unit files).
- [x] `npm run build` — clean.
- [ ] Manual (real data): load a NISAR GCOV granule, enable Optical Peek, zoom
      to a small feature → after ~1 s settle the overlay sharpens to street
      level; status log shows `Optical detail z1x (…tiles)`; pan keeps base
      coverage under the refreshing detail; toggling provider rebuilds both.

## Findings

- Implemented directly in the primary working tree (uncommitted, alongside the
  existing WIP noted in plan README) by PI instruction rather than via a
  worktree branch. Unit + structural + build criteria verified 2026-07-13;
  the real-data manual pass is the remaining open criterion.
- deck.gl 8.9 fact used: `changeFlags.somethingChanged` already includes
  `viewportChanged` (layer.js), so `shouldUpdateState` returning
  `somethingChanged` is sufficient for viewport tracking.
