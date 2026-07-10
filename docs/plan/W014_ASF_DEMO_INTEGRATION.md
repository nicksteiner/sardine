# W014 — ASF DAAC demo capacity: track + integrate the D582/D106 line

wave: 1 (external, in progress)
status: deferred — ATBD/SPA integration held out of v1.0.0-beta.5 by PI decision (2026-07-10); d106-work line intact, integrate before the next release
blocked_by: []
branch: d106-work (most advanced; lineage d582-work → d106-work; worktrees under ~/.sardine/worktrees/sardine/)

## What it is

A separate agent (sardine-agent directive system) is building the **ASF DAAC demo
capacity**: a hash-routed SPA shell with a Landing page and ATBD demo apps —
`/inundation` (with **ASF auto-stack streaming**), `/crop`, `/disturbance` — plus
Playwright e2e tests and drift-prevention CI. Key commits on `d106-work`:
`D582/S291` (SPA shell + `app/main.jsx` → `app/pages/GCOVExplorer.jsx` rename),
`D582/S292` (/inundation + ASF auto-stack), `D582/S293` (/crop + /disturbance +
AtbdAppShell), `D289` (Inundation ATBD regression vs JPL reference, 0 mismatches).

This work is **part of Wave 1 in spirit** (it delivers the distribution/demo goals of
PLATFORM_REVIEW.md §6 move 3) but runs outside the W### batch process.

## The integration hazard (why this work order exists)

`d106-work` forked at `a28fc4a` — 46 commits behind current HEAD. It restructures
`app/` (13,307 insertions / 6,610 deletions), moving the monolith to
`app/pages/GCOVExplorer.jsx`, while Wave 0/1 merged main.jsx-touching changes
(W004 markup handlers, W005 sidecar calls, W007 GPU-stats routing, W008 deep-link
guards) plus the July WIP (compare grid, transects). **Git will not auto-reconcile
edits to a renamed-and-heavily-rewritten file.**

## Integration plan (when the demo line is ready)

1. Merge order: bring `d106-work` INTO the wave line (or rebase it), treating
   `app/pages/GCOVExplorer.jsx` as the survivor of main.jsx; manually port the four
   wave diffs (they are small and localized — see each work order's Findings for
   exact touch points; all logic lives in `src/utils/*` modules, only thin handler
   wiring lives in the page).
2. W008 deep links must be re-verified against hash routing (`#/` routes vs `?url=`
   query params — check `deepLinkDevFixPlugin` in vite.config.js still applies).
3. `test/run-tests.js` diverged heavily on both sides (+585 lines on d106) — expect
   the largest conflict there; both sides' checks should union.
4. Re-run the full acceptance chain (`npm test`, `npm run test:unit`, build, e2e).
5. W010's store-extraction plan must target `app/pages/GCOVExplorer.jsx`, not
   `app/main.jsx` — update W010 scope when this lands.

## Acceptance criteria (for the integration, not the demo itself)

- Single branch containing both lines; `npm test` + `npm run test:unit` +
  `npm run build` + d106's e2e suite all green.
- Deep links, markup save/load, export sidecars, and GPU histogram verified working
  inside GCOVExplorer post-merge.
- W010 work order updated to reference the new file layout.
