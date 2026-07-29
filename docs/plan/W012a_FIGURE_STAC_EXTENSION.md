# W012a — `sardine-figure` STAC extension (design gate)

wave: 4
status: design
parent: W012 (§2 "schemas as draft STAC extensions")
branch: w012a-figure-stac
depends_on_facts: W005 (export sidecar), W008/W016/W017 (deep links), cog-loader class-map path

## Why this exists (the premise)

We need to hand off a set of raster **figures** (labeled class-map COGs — confusion
maps, C-vs-L agreement, raw dark-water comparisons) so that a *fresh session* or an
external collaborator can:

1. find them (bbox / date / truth / arm),
2. understand them **without downloading the raster** (class table + census baked in),
3. open the exact interactive view in SARdine with one click, and
4. trust their provenance (which model arm, which truth, which input scenes).

Committing TIFFs into the app repo answers none of these — it answers only "where are
the bytes." The state-of-the-art answer is three separable layers:

```
S3 (bytes, CORS+Range)  ←  STAC Item (description + link)  ←  ?cog= deep link (the view)
```

This doc designs the **middle layer**: a minimal STAC extension, `sardine-figure`, that
turns each self-describing class-map COG into a self-describing STAC Item whose links
resolve to a live SARdine view. It is the concrete first cut of W012 §2.

**Non-goals:** this is not the SessionState/RenderConfig extension (that is W010's
schema, published separately under the same W012 §2). This extension describes a
*published raster figure*, not an app session. They share the deep-link vocabulary and
nothing else.

## Design constraints (verified against the code, not assumed)

| # | Constraint | Source of truth |
|:--|:--|:--|
| C1 | Must **subsume** the W005 sidecar, not duplicate it. The sidecar's `derived_from` / `identification` / `georeference` / `render` already exist and are tested. | `src/utils/export-sidecar.js`; `test/unit/export-sidecar.test.mjs` |
| C2 | Must round-trip to the viewer **without the raster**: the class table the loader reads from internal `GDAL_METADATA` must also live in the Item, so a catalog browser can render the legend before a byte of imagery loads. | `extractClassNames` / `extractColorTable`, `cog-loader.js:64,749-756` |
| C3 | Naming must not collide. `{output}.tif.json` = W005 sidecar. `{file}.sardine.json` = reserved (NITF). The STAC Item needs a **third, unambiguous** name. | `docs/plan/README.md:104-106`; `export-sidecar.js:9-13` |
| C4 | The "View in SARdine" link is the payload, not an afterthought — it is a first-class `link` with a defined `rel`, carrying `?cog=` + optional `bbox=`/AOI. | `docs/DEEP_LINKS.md`; W008/W016/W017 |
| C5 | Lean on GDAL's own STAC output for projection/raster fields rather than hand-rolling. `gdalinfo -json` already emits `proj:epsg`, band color interpretation, corner coords. | verified: `proj:epsg=32736`, Palette band w/ color table |
| C6 | Reuse **existing** STAC extensions where one fits; only invent fields that are genuinely SARdine-specific. | STAC best practice |

## Reuse-first: which fields come from where

The extension is deliberately **thin**. Most of what a figure Item needs already has a
standard home:

| Concern | Extension used | Not reinvented |
|:--|:--|:--|
| CRS, epsg, shape, transform, bbox in native CRS | **`proj`** (`proj:epsg`, `proj:shape`, `proj:transform`, `proj:bbox`) | ✅ from `gdalinfo -json` |
| Per-class value → label → color → count | **`classification`** (`classification:classes[]` with `value`,`name`,`title`,`color_hint`,`percentage`,`count`) | ✅ this is exactly what our `.csv` + color table hold |
| Asset roles, media type, band description | core `assets` (`roles: ["data"]`, `type: image/tiff; application=geotiff; profile=cloud-optimized`) | ✅ |
| Datetime / date range of the observation | core `properties.datetime` (or `start_/end_datetime`) | ✅ |
| Nominal ground sample distance | core `gsd` | ✅ 20 m |

**Only these are actually new** (the `sardine:` namespace):

```
sardine:figure_kind    enum  confusion | agreement | dark_water | dynamics | errmap | feature
sardine:arm            enum  arm0 | arm1 | arm3 | arm4 | null   (which model arm; null for obs/feature maps)
sardine:band           enum  C | L | CvsL | null                (SAR wavelength(s) compared)
sardine:truth          object { name, kind(optical|sar|ems), date, coverage_note }
sardine:derived_from   array  of input scene refs (band, date, geometry, manifest path) — promotes W005 derived_from to a list
sardine:census_asset   string href to the per-class .csv (count/km²/%/top-3 WorldCover)
sardine:caveats        array  free-text carried caveats (e.g. "tree-cover IoU not quotable; optical truth canopy-blind")
```

Rule of thumb enforced in review: **if a field has a home in `proj`,
`classification`, or STAC core, it does not get a `sardine:` twin.**

## The "View in SARdine" link (C4)

Each Item carries, in `links[]`:

```json
{
  "rel": "visualize",
  "type": "text/html",
  "title": "Open in SARdine",
  "href": "https://nicksteiner.github.io/sardine/?cog=<asset-href>&bbox=<w,s,e,n>",
  "sardine:render": { "mode": "single" }
}
```

- `rel: "visualize"` is the STAC-community convention for "human-viewable rendering of
  this item" — we adopt it rather than minting `sardine:view`.
- The `href` is built from the data asset's own href, so it is **correct by
  construction** (no drift between the file we published and the link we advertise).
- Class-maps need **no render params** — the COG's internal color table drives the
  legend. Feature dB rasters (if ever published as figures) get
  `db=1&cmap=…&min=…&max=…` folded into the href, sourced from the sidecar `render`
  block. That is the *only* reason `render` params ever appear here.
- Optional `bbox=` pins the AOI for the region figures (W/E/O windows) so the link
  opens *on the story*, not the full 16560×16020 frame.

## Naming (C3) — the third artifact

```
figure.tif            the COG (bytes)                                → S3
figure.tif.json       W005 export sidecar (unchanged, browser-written) — MAY be absent for
                      script-emitted figures; the STAC item carries the same lineage
figure.csv/.qml/.clr  existing sidecars (census + QGIS/ArcGIS styles) → S3, referenced as assets
figure.stac.json      NEW — the STAC Item for this figure                → S3 + catalog
```

Decision: **`{output}.stac.json`**, not `{output}.json` (ambiguous vs the `.tif.json`
sidecar under some tooling) and not `{output}.sardine.json` (reserved). One collection
manifest `collection.json` + one root `catalog.json` sit alongside. This naming rule is
appended to `docs/plan/README.md` on acceptance so the collision table stays complete.

## Relationship to the W005 sidecar (C1)

The sidecar is **not replaced or rewritten**. The emitter reads the sidecar when present
and *promotes* its fields into STAC:

| sidecar field | → STAC location |
|:--|:--|
| `derived_from` / `identification` | `properties.sardine:derived_from[]` + `sardine:truth` |
| `georeference.crs/bounds/width/height` | `proj:epsg` / `proj:bbox` / `proj:shape` (cross-checked against `gdalinfo`) |
| `render` (rendered exports only) | folded into the `visualize` link href, nowhere else |
| `software` / `created` | `properties.processing:software` (processing ext) / `properties.created` |

For script-emitted figures with no browser sidecar, the same fields come from the
emitter's own knowledge of the run (arm defs from `arm_ladder.py`, truth from the
filename convention `*_vs_<truth>.tif`). The Item is authoritative either way.

## Emitter (the implementation this design gates — NOT built yet)

`scripts/D688/emit_figure_stac.py` (proposed):

```
for each *.tif in labeled_cogs/ (+ older labeled COGs):
    gi        = gdalinfo -json          # proj:*, bands, color table, corners  (C5)
    classes   = merge(color table RGB, .csv rows[value,name,km²,%,top-cover])  (C2)
    sidecar   = read {tif}.tif.json if present                                 (C1)
    item      = build STAC Item(id, bbox4326, datetime, proj:*, classification:classes,
                                assets{data,census,qml,clr}, links{self,collection,visualize})
    write {tif}.stac.json
build collection.json + catalog.json over all items
```

Memory/parity notes carried from `write_labeled_cogs.py`: this only reads headers +
the tiny CSV, so no streaming needed; `GDAL_CACHEMAX` irrelevant.

## Acceptance criteria (runnable)

1. **Schema validates.** Every emitted `*.stac.json` passes `stac-validator` against
   STAC 1.0 core + the `proj` and `classification` extension schemas, and against the
   `sardine-figure` fragment schema (published under `docs/stac/sardine-figure/`).
2. **Legend without raster.** A catalog browser (or `test/unit/figure-stac.test.mjs`)
   reconstructs the class legend (value→name→color→%) for
   `agreement_CvsL_vs_planet_jan29` from the Item alone — no `.tif` fetched — and it
   matches `extractClassNames`/`extractColorTable` on the actual COG (C2 round-trip).
3. **Link opens the right view.** The `visualize` href resolves to the same asset it
   describes; loading it in SARdine renders the class-map with its internal color table;
   for a region item the `bbox=` fits the AOI (C4).
4. **No field duplication.** Lint asserts no `sardine:` key restates a value available
   in `proj`/`classification`/core (C6). Fails the build if violated.
5. **Naming rule documented.** `docs/plan/README.md` collision table lists
   `{output}.stac.json` alongside `.tif.json` and `.sardine.json` (C3).
6. **Deep-link parity.** The `visualize` links round-trip through
   `deep-link.js` parse→serialize unchanged (extends `test/unit/deep-link.test.mjs`).

## Decisions (resolved in review 2026-07-13)

- **Q1 — RESOLVED: in-repo.** The `sardine-figure` fragment schema lives under
  `docs/stac/sardine-figure/` in the sardine repo. Split into its own draft-extension
  repo only when a second consumer appears (no premature repo-splitting).
- **Q2 — RESOLVED: `rel: "visualize"`.** Adopt the community rel; do not mint
  `sardine:view`.
- **Q3 — RESOLVED: one collection.** A single `c-vs-l-flood-figures` collection with
  `sardine:truth` as a queryable facet on each Item (not three per-truth collections).
- **Q4 — PENDING (user supplying).** Absolute hrefs require the real bucket. Awaiting:
  `bucket name` · `region` · `key prefix` · access model (public-read vs
  website-hosted) · optional custom domain. Target layout:
  `s3://<bucket>/<prefix>/{cogs,stac,png}/…`, catalog root at
  `s3://<bucket>/<prefix>/catalog.json`. Emitter is blocked on these five values.
- **Q5 — GATED ON Q4.** If the bucket serves permissive CORS, add its host to the
  `directOK` allowlist (`src/utils/proxy.js:55`) so hosted-build loads skip the EDL
  proxy/token path — same zero-config as same-origin. One-line app change, applied once
  the bucket host is known.
```
