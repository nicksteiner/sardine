# W015 — Merge to main + release (post-W014)

wave: 1 (closeout)
status: done — released as v1.0.0-beta.5 (2026-07-10). Deviations by PI instruction: ATBD/SPA line (W014) deferred; playwright e2e + /code-review ultra skipped (concurrent browser automation; "dont stop and ask") — run both on the next release.
blocked_by: [W014]
branch: (release PR from optical-peek-georef-fix)

## Objective

Ship Wave 0/1 + the ASF DAAC demo capacity as one release.

## Checklist

1. **W014 integration verified** — demo line merged into `optical-peek-georef-fix`;
   `npm test`, `npm run test:unit`, `npm run build`, and the d106 e2e suite all green;
   deep links / markup save-load / sidecars / GPU histogram confirmed working inside
   `app/pages/GCOVExplorer.jsx`.
2. **Manual real-data pass** (the one thing agents couldn't verify headlessly; doubles
   as demo rehearsal): remote NISAR granule via `?url=` deep link → streams + renders
   → markup drawn, saved, reloaded → GeoTIFF export carries `.tif.json` sidecar with
   identification → page reload hits the IDB chunk cache (network tab) → status log
   shows "histogram: WebGPU" on capable hardware.
3. **Version**: resolve the `package.json` (0.2.2) vs changelog (1.0.0-beta.4) drift —
   decision: continue the changelog line at **1.0.0-beta.5**. Bump `package.json` AND
   `SARDINE_VERSION` in `src/utils/export-sidecar.js` (the drift unit test enforces
   the pair).
4. **Changelog**: retitle `[Unreleased]` → `[1.0.0-beta.5] - <date>`; keep the
   `writeRGBGeoTIFF` export removal called out.
5. **Open the release PR** to `main`; run `/code-review ultra <PR#>` — the single
   review gate for the whole wave (branches merged on acceptance criteria alone).
   Triage findings; fix or explicitly waive each.
6. Merge, tag `v1.0.0-beta.5`, GitHub release with the changelog entry.
7. **Deployment artifacts**: `npm run build`; if the On-Demand/JupyterLab deployment
   is in use, follow `docs/DEPLOYMENT.md` (commit `dist/` on the deployment path).
8. Flip W014/W015 statuses to merged/done; append findings if the release surfaced
   anything.

## Acceptance criteria

- `main` contains the wave + demo line; tag `v1.0.0-beta.5` exists; CI/test chain
  green on main; changelog entry dated; version triplet (package.json, changelog,
  SARDINE_VERSION) consistent.
