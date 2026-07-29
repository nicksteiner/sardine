# SESSION_SCHEMA — SARScene / RenderConfig / SessionState (W010 design)

Status: **DRAFT for PI review** · schemas in `src/schemas/*.schema.json` · examples
validated by `node src/schemas/validate-examples.mjs` (no-dep)

This is the W010 design gate deliverable: a reviewable spec, NOT a refactor. No
runtime code changes accompany it. On approval, spawn W010a (loaders return
SARScene), W010b (exports consume RenderConfig), W010c+ (store extraction), and
unblock W011.

Decisions marked **[PI-RESOLVED]** were settled in review 2026-07-29, rounds 1
(Q1–Q8) and 2 (compare, multiLookFactor, geometry, estimator split, vocabulary).
No open items remain — §8 is the round-2 decision log.

---

## 1. The three objects

```text
SessionState  (.sardine-session.json)
├── scene:          SARScene        — what is loaded (source, geometry, capabilities)
├── renderConfig:   RenderConfig    — how it is displayed (no viewport, no UI)
├── compare?:       [{label, scene, renderConfig?}] — max 4, write-now/restore-later
├── view:           { center, zoom, aoi? }
├── ui?:            non-normative viewer prefs (grid, pixel explorer, histogram)
├── markup:         GeoJSON FeatureCollection (markup schema v2 — Appendix A)
└── analysisArtifacts[]: by-reference artifacts (models, masks, bundles,
                         calibration records) — href + sha256, inline < 100 KB
```

Deep links (W008/W016/W017), PNG-embedded state, and the render-state clipboard
become **projections** of SessionState (§5). The markdown state format is
**killed** (§5.4) [PI-RESOLVED Q7: hard cutover, no adapter machinery — there is
no deployed user base to migrate].

### File naming (extends the collision table in docs/plan/README.md)

| Suffix | Meaning | Owner |
|:--|:--|:--|
| `{name}.sardine-session.json` | SessionState | **this doc** |
| `{name}.sardine-model.json` | model manifest | W025 |
| `{output}.tif.json` | export sidecar | W005 |
| `{file}.sardine.json` | NITF scene-geometry sidecar | reserved |
| `{output}.stac.json` | published-figure STAC Item | W012a |
| `{name}.sardine-calibration.json` | label calibration record | **Appendix B** |

---

## 2. SARScene (`src/schemas/sar-scene.schema.json`)

Replaces the opaque `LoadedSource.meta`. Everything a consumer needs to reason
about a loaded scene without re-opening the file.

| Field | Type | Req | Notes |
|:--|:--|:--|:--|
| `sardine:scene` | int = 1 | ✔ | schema version |
| `source.href` | string (URL) | ✔ | portable ref [PI-RESOLVED Q6: URLs, not local paths] |
| `source.type` | `nisar \| cog \| nitf` | ✔ | mirrors `inferDataTypeFromUrl` routing |
| `source.sha256` | string | – | content integrity when known |
| `source.sizeBytes` | int | – | enables CurlFile-style streaming without HEAD |
| `productType` | string | ✔ | `GCOV/GUNW/GOFF/COG/SICD/...` (W005 `inferProductType` rules) |
| `crs` | string `EPSG:nnnn` | ✔ | native CRS (UTM / PS / 4326) |
| `bounds` | [w,s,e,n] | ✔ | native-CRS bounds |
| `bounds4326` | [w,s,e,n] | – | precomputed geographic bounds when loader has them |
| `width`, `height` | int | ✔ | full-resolution raster dims |
| `gsd` | number | – | nominal ground sample distance, m |
| `datetime` | {start, end} ISO 8601 | – | observation window (start=end for single epoch) |
| `capabilities` | object | ✔ | what the UI can offer: `frequencies[]`, `polarizations{}`, `layers[]`, `hasColorTable`, `classNames{}` |
| `identification` | object \| null | ✔ | **opaque pass-through**, same rule as W005 sidecar — never hand-picked |

## 3. RenderConfig (`src/schemas/render-config.schema.json`)

The one versioned render state consumed by viewer, exports, serializers.
Superset of `serializeRenderState()` v1 (main.jsx:4832) **minus** viewport and
UI-overlay fields, which move to `view` / `ui` (§4). Grouped where v1 was flat:

| Group | Fields | v1 origin |
|:--|:--|:--|
| mode | `displayMode` (`single\|composite`), `compositeId` | flat |
| dataset | `dataset.frequency`, `dataset.polarization` | `selectedFrequency/selectedPolarization` |
| single-band | `colormap`, `colormapReversed`, `useDecibels`, `contrastMin`, `contrastMax`, `gamma`, `stretchMode` | flat (`colormapReversed` was deep-link-only `rev` — gap now closed) |
| rgb | `rgb.contrastLimits`, `rgb.saturation`, `colorblindMode` | `rgbContrastLimits`, `rgbSaturation` |
| masks | `masks.invalid`, `masks.layoverShadow`, `masks.incidenceAngle{enabled,min,max}`, `masks.coherence{enabled,threshold}` | `maskInvalid`, `maskLayoverShadow`, `useIncidenceAngleMask`, `incAngleMin/Max`, `useCoherenceMask`, `coherenceThreshold` |
| speckle | `speckle.type`, `speckle.kernelSize` | flat |
| multilook | `multiLook` (boolean — viewer auto-ML toggle, the control surface); `multiLookFactor` (int, **advisory/derived**) | flat; factor is new [PI-RESOLVED r2] |

`multiLookFactor` records the EFFECTIVE looks at save time. It is an output,
not an input, and is never read back as a control — its purpose is that a
published figure and its live deep link cannot silently diverge if the
auto-selection heuristic changes; the factor is the only record of what the
figure actually showed.
| gunw | `gunw.losDisplacement`, `gunw.verticalDisplacement` | flat |

Envelope: `sardine:render_config: 1`. Readers apply fields with per-field type
checks (the `applyRenderState` pattern) so partial payloads degrade gracefully.

## 4. SessionState (`src/schemas/session-state.schema.json`)

| Field | Type | Req | Notes |
|:--|:--|:--|:--|
| `sardine:session` | int = 1 | ✔ | |
| `created`, `software` | ISO 8601, string | ✔ | same convention as W005 sidecar |
| `scene` | SARScene | ✔ | primary scene |
| `renderConfig` | RenderConfig | ✔ | |
| `compare` | array ≤ 4 of `{label, scene, renderConfig?}` | – | [PI-RESOLVED r2] **write now, restore later**: the serializer WRITES it whenever compare mode is active (panel state is already in memory — unwritten compare state is lost forever). Restore is deferred: a loader that cannot restore `compare` warns, loads the primary scene, and does not fail — unrestored state is recoverable later without a version bump. |
| `view` | `{center:[lon,lat], zoom, aoi?}` | ✔ | `aoi` = `{bbox}` or `{wkt}` (W016/W017 vocabulary) |
| `ui` | object | – | non-normative; viewers may ignore: `showGrid`, `pixelExplorer`, `pixelWindowSize`, `showHistogramOverlay`, `histogramScope` |
| `markup` | FeatureCollection (markup v2) | – | Appendix A |
| `analysisArtifacts` | array | – | see below |

### analysisArtifacts[] entry

[PI-RESOLVED Q6] By-reference with integrity; inline permitted only for small
payloads (trained logistic heads fit; rasters never do).

| Field | Type | Req | Notes |
|:--|:--|:--|:--|
| `id` | string | ✔ | unique within session |
| `kind` | `model \| mask \| figure \| roi-profile \| training-bundle \| calibration-record` | ✔ | |
| `href` | string (URL) | ◐ | required unless `inline` present |
| `sha256` | string | ◐ | required with `href` when the artifact is immutable |
| `inline` | object | ◐ | serialized JSON ≤ 100 KB (validator-enforced) |
| `mediaType` | string | ✔ | e.g. `application/json`, `image/tiff; ...cloud-optimized` |
| `created`, `label`, `derived_from` | – | – | provenance chain |

---

## 5. Mapping table — where every legacy field lands

### 5.1 Deep link (`src/utils/deep-link.js` KEYS)

| Param | Destination |
|:--|:--|
| `url/cog/nisar/nitf` | `scene.source.href` + `scene.source.type` |
| `cmap, rev, db, min, max, stretch, gamma` | `renderConfig` single-band group |
| `pol, freq` | `renderConfig.dataset` |
| `comp, mode` | `renderConfig.compositeId / displayMode` |
| `ml` | `renderConfig.multiLook` (coercion: `0`→off, else on). The numeric factor is not a control input, but the *effective* looks are recorded on save in `renderConfig.multiLookFactor` (advisory, §3) |
| `c, z` | `view.center`, `view.zoom` |
| `bbox, wkt` | `view.aoi` |
| `compare` | `SessionState.compare[]` (`label~url` grammar → `{label, scene.source.href}`; write-now/restore-later per §4) |
| `t, col` | **dropped-because** discovery-time resolution params (W017), not session state — they select a scene, they don't describe one |

### 5.2 Render-state clipboard (`serializeRenderState` v1)

All fields land in `renderConfig` / `view` / `ui` per §3–§4. Envelope
`__sardine:'render-state', version:1` → superseded by `sardine:session`.
Clipboard copy/paste becomes a SessionState projection (scene + renderConfig +
view; markup/artifacts omitted).

### 5.3 PNG tEXt embedding (`png-state.js`, keyword `SARdine-State`)

Mechanism unchanged; payload upgrades from render-state v1 to full SessionState.
Extractor accepts both during v1 (type-checked field application makes the old
payload degrade gracefully); emitter writes only SessionState.

### 5.4 Markdown state (`parseMarkdownState` / `generateMarkdownState`, main.jsx:113/213) — **KILLED**

[PI-RESOLVED Q7] Removed outright, no adapter. Field disposition: `source`,
`file`, `dataset`, `contrast*`, `colormap`, `useDecibels`, `view` all duplicate
render-state fields (destinations per §5.2). `toneMapEnabled/Method/Gamma/
Strength` — **dropped-because** legacy tone-mapping superseded by
`stretchMode`+`gamma`; no authoring UI ships them.

### 5.5 Export sidecar (W005) — unchanged

The sidecar remains the export-time record. SessionState references exports via
`analysisArtifacts` (`kind:'mask'|'figure'`, href to the .tif; the `.tif.json`
travels alongside by naming convention). No field duplication.

---

## 6. Versioning & migration policy

- Integer versions per object (`sardine:scene`, `sardine:render_config`,
  `sardine:session`, markup `sardine:schema`, `sardine:calibration`).
- **Additive** changes within a version; readers apply known fields with
  per-field type checks and preserve unknown fields on round-trip (W004
  precedent — `__geojsonProps` pass-through).
- **Breaking** changes bump the integer. Migration is forward-only
  (vN → vN+1 functions); an unknown *higher* version is refused loudly with the
  version named — never best-effort parsed.
- No adapters for pre-schema formats beyond §5 (hard cutover).

## 7. Alignment notes

- **sardine-agent findings schema** (`.sardine/EXPERIMENT_RULES.md`):
  `findings.confidence` is *analyst credence in a scientific claim*;
  markup `confidence` is *P(label correct)* (Appendix A). Same word, disjoint
  semantics, never merged. `analysisArtifacts.derived_from` may carry directive
  ids (`D###`) linking bundles to the experiment log.
- **W025 model manifests**: `analysisArtifacts` with `kind:'model'` point at
  `.sardine-model.json`; trained-head provenance lives in the manifest, not the
  session.
- **W012a figures**: a published figure's `{output}.stac.json` may link back to
  the authoring session (`rel:"derived_from"`, href to `.sardine-session.json`).

## 8. Round-2 decision log **[PI-RESOLVED 2026-07-29]**

1. **Compare-grid sessions — write now, restore later.** Deferral rejected: Q7
   YAGNI does not transfer (deleting code for nonexistent users is free; a
   schema hole costs a breaking bump later), and compare mode is the NISAR
   Science Team demo (C vs L side by side) with W012a publishing labeled
   C-vs-L COGs. Optional `compare[]` (max 4) added to v1; serializer writes it
   whenever compare mode is active; restore deferred with warn-and-load-primary
   semantics. Unwritten compare state is lost forever; unrestored compare state
   is recoverable later without a version bump.
2. **`ml` coercion accepted; `multiLookFactor` added** as an advisory/derived
   output field (§3) so published figures record what they actually showed.
3. **`label-region` geometry**: `MultiPoint | Polygon | MultiPolygon`;
   `GeometryCollection` explicitly excluded (unbounded for the sampler);
   multipart sampling MUST be area-weighted across parts (Appendix A.2/C).
4. **Adjudication of `insitu`/`model` labels allowed, never pooled** with
   audit-derived rates: calibration records carry `estimator: audit |
   adjudication`; adjudication-derived rates are SAR-correlated and not
   directly usable as training weights; rejecting an insitu label requires a
   reason code (Appendix A.1/B).
5. **Class vocabulary declared**: collection-level `sardine:classes` +
   `sardine:scheme` (`nwi | worldcover | custom`) (Appendix A.4).

---

# Appendix A — Markup schema v2 (labels as training examples)

`src/schemas/markup-v2.schema.json`. Bumps `SARDINE_MARKUP_SCHEMA_VERSION` 1→2.
v1 files import cleanly (all new fields optional with defaults; unknown-field
pass-through unchanged).

## A.1 New/changed feature properties

| Property | Type | Change | Semantics |
|:--|:--|:--|:--|
| `observer` | enum `human \| ai \| insitu \| model` | widened from free string | [PI-RESOLVED Q2] `insitu` = sensor-derived (gauge, tide); `model` = hydro-model/reanalysis-derived (GloFAS et al.) — they stratify differently in training |
| `method` | string | unchanged | specifics: `manual`, `gpu-threshold`, `sam-click`, `gauge-discharge`, `glofas-reanalysis`, ... |
| `confidence` | null \| number 0–1 | semantics defined | [PI-RESOLVED Q1] **P(label is correct)**. Used for filtering, subset selection, reporting ONLY. **Never a training weight** — training consumes class-conditional noise rates from calibration records (Appendix B). `null` = authoritative (human). |
| `class` | string | new | training class name (distinct from display `label`) |
| `sardine:valid` | `{start, end}` ISO 8601 | new | [PI-RESOLVED Q4] label validity interval; a training pair is admissible only if the acquisition datetime falls inside. Phase (`rising/at_peak/...`) stays in `measurements` — promote only if the trainer ever stratifies on it. |
| `adjudication` | object | new | `{status: pending \| accepted \| edited \| rejected, by, at, reason?}` — absent means not subject to adjudication. [PI-RESOLVED Q5] `by` recorded now; single-analyst assumption otherwise. [PI-RESOLVED r2] Adjudicating `insitu`/`model` labels is ALLOWED (free signal) but tallies into `estimator:'adjudication'` calibration rows, never pooled with audit rates (Appendix B). Rejecting an `insitu`/`model` label REQUIRES `reason` (validator-enforced) — a stronger claim than rejecting an AI proposal, it must be attributable. |

## A.2 New kind: `label-region`

[PI-RESOLVED Q3] `sardine:kind: "label-region"` — geometry-agnostic training
label, one class per feature:

- **Geometry:** `MultiPoint` (sparse SAM-style prompts, analyst confirms/flips
  per point) **or** `Polygon`/`MultiPolygon` (gauge-consistent extents; NWI is
  frequently multipart and splitting at import would break the
  one-feature-per-site-per-interval grain). `GeometryCollection` is
  **explicitly excluded** — it makes the sampler unbounded. World CRS per W004
  convention (`sardine:crs` collection-level).
- **Sampling is the export layer's job:** points pass through as sparse
  supervision; polygons are rasterized/sampled at training time. Multipart
  sampling MUST be **area-weighted across parts** — without this a 1 ha
  fragment and a 1000 ha part contribute equally and the training set
  overweights slivers.
- **Trainer contract line (binding on W025/tuner):** sparse supervision MUST be
  consumed via masked loss — never rasterize points to single pixels.
- Legacy `class-region` (null-geometry, dB-feature-space scatter selection) is
  **left alone** and the scatter classifier is dropped from the roadmap; no new
  authoring of `class-region` features.

## A.3 Adjudication → labels

[PI-RESOLVED Q5] Rejected features **survive export**. A rejected AI proposal
maps to the **negative class with human-authoritative weight** (`confidence`
becomes null-equivalent via the adjudicating human). Every adjudication event
also appends a tally row to the session's calibration record for the
`(observer:'ai', method)` pair — adjudication is both a label and an estimate
of the proposer's noise rate.

## A.4 Declared class vocabulary

[PI-RESOLVED r2] The markup collection carries `sardine:classes` (string[]) and
`sardine:scheme` (`nwi | worldcover | custom`). Every `label-region` `class`
MUST appear in `sardine:classes` (validator-enforced; required whenever any
label-region feature is present) — this catches misspellings at save/validate
time instead of at training time. The declared list cannot catch *semantic*
drift (`water` spelled correctly can still mean different things across
sessions); `sardine:scheme` exists so the trainer can decide whether two
sessions' classes are the same class **before** pooling them. MARB work is NWI
codes throughout, so `scheme:"nwi"` costs nothing there and makes cross-site
pooling checkable.

# Appendix B — Calibration record (`src/schemas/calibration-record.schema.json`)

[PI-RESOLVED Q1] The training-facing statement of label quality: class-
conditional noise rates per **observer × method × class**, with estimation
provenance. Stored as `{name}.sardine-calibration.json`, referenced from
sessions/bundles as `analysisArtifacts` (`kind:'calibration-record'`). The W025
trainer contract reads noise rates from here — not from per-row `confidence`
(which would soft-delete rare classes like PFO under confidence weighting).

| Field | Type | Req | Notes |
|:--|:--|:--|:--|
| `sardine:calibration` | int = 1 | ✔ | |
| `id`, `created` | string, ISO 8601 | ✔ | |
| `estimated_by` | `{kind: human\|agent\|directive, ref}` | ✔ | e.g. `{kind:'directive', ref:'D###'}` |
| `scope` | `{observer, method, region?, campaign?}` | ✔ | which labels these rates govern |
| `direction` | `true_given_label \| label_given_true` | ✔ | which conditional the rows state (gauge-audit precision estimates are `true_given_label`; adjudication tallies of a proposer are `label_given_true`) |
| `estimator` | `audit \| adjudication` | ✔ | [PI-RESOLVED r2] how the rates were obtained. **Adjudication-derived rates are SAR-correlated** — an analyst rejecting a gauge polygon because the SAR looks dry is making a judgment correlated with the features the model trains on; pooled with the audit they would contaminate it and produce a falsely tight rate. They are NOT directly usable as training weights. The trainer MUST NOT average across `estimator` values: agreement between the two estimators is a reportable result, a silent mean is a bug. |
| `classes` | string[] | ✔ | class vocabulary |
| `rates[]` | `{given, outcome, rate, n, ci95?}` | ✔ | P(outcome-class \| given-class), sample size, optional CI |
| `estimation` | `{procedure, data_ref, date}` | ✔ | how the rates were estimated (e.g. gauge-blocked precision calibration; adjudication tally) |

# Appendix C — Training-bundle export (W011 component 2, gated here)

One review gates the whole label path [PI-RESOLVED scope]. The bundle is a STAC
Item + assets; its full schema lands with the W011 PR, but the binding design is:

```text
bundle/
├── item.stac.json      STAC Item: label extension (label:classes,
│                       label:methods, label:tasks), derived_from → input
│                       scenes, datetime = acquisition
├── labels.geojson      markup v2 FeatureCollection — accepted, edited AND
│                       rejected features (rejected = hard negatives, §A.3)
├── mask.tif            optional uint8 COG (class table in GDAL_METADATA,
│                       W005 sidecar alongside) — rasterized polygons only
└── calibration/*.sardine-calibration.json   every record whose scope covers
                        any (observer, method) present in labels.geojson
```

Consumption rules (binding on W025 trainer / sardine-tuner):
1. Filter/subset by per-row `confidence` if desired — then **discard it**.
2. Look up noise rates by `(observer, method, class)` from the shipped
   calibration records; unmatched labels are an error, not a silent weight=1.
3. Respect `estimator`: use `audit`-derived rates for training;
   `adjudication`-derived rates are SAR-correlated diagnostics — report
   agreement/disagreement with audit rates, never average the two (§B).
4. Sparse (`MultiPoint`) labels via masked loss (§A.2).
5. Polygon/MultiPolygon sampling is area-weighted across parts (§A.2).
6. Admissibility: acquisition ∈ `sardine:valid` interval (§A.1).
7. Pooling across sessions requires matching `sardine:scheme` (§A.4); pooling
   `custom` vocabularies is a deliberate act, not a default.

Publishing (Q8): staging is local; eventual layout is one public-read CORS
bucket, key prefix per directive (`d688/...`), no custom domain. Bucket name is
an implementation-time value — nothing in these schemas depends on it.
