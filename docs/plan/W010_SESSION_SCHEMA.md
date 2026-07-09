# W010 — SARScene / RenderConfig / SessionState schemas (DESIGN GATE)

wave: 2
status: todo
blocked_by: [W001, W004, W005]
branch: w010-session-schema

## Objective

Design (as a reviewable doc + JSON Schema, NOT yet a refactor) the three canonical
objects that unify the four serialization formats and the loader contract:

- **SARScene** — source ref, format, CRS, bounds, dims, full identification metadata,
  capabilities (what layers/pols exist). Replaces the opaque `LoadedSource.meta`.
- **RenderConfig** — the one versioned render state consumed by viewer, exports, and
  serializers (superset of the render-state clipboard, `main.jsx` serializeRenderState).
- **SessionState** — `{version, scene, renderConfig, view, markup (W004 GeoJSON),
  analysisArtifacts}` — the `.sardine-session.json` save/load format AND the GSPS
  analog. Deep links (W008) and PNG embedding become projections of this one object.

## Deliverable

`docs/plan/design/SESSION_SCHEMA.md` + `src/schemas/*.schema.json` (JSON Schema files,
no runtime code changes yet). Must include: field tables, versioning/migration policy,
mapping table showing where each existing serializer's fields land, alignment notes
with sardine-agent's findings schema and `sardine.json` sidecar, and the annotation
object's dual role as a training example (label/observer/adjudication fields).

## Human gate

**PI review required before any implementation PRs.** After approval, spawn follow-up
work orders: W010a (loaders return SARScene), W010b (RenderConfig consumed by exports),
W010c+ (store extraction, one main.jsx state cluster per PR, strangler pattern).

## Acceptance criteria

- Schemas validate example instances (`node` + a no-dep validator or hand assertions).
- Every field of the four existing formats (share-link, png-state, markdown,
  clipboard) has a documented destination or an explicit "dropped because" note.
