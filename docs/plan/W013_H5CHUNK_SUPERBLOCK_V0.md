# W013 — h5chunk superblock v0/v1 root-group address bug

wave: 1
status: launched
blocked_by: [W001]
branch: w013-superblock-v0

## Objective

Fix `parseSuperblock` in `src/loaders/h5chunk.js`: the v0/v1 path reads the root-group
symbol-table entry's first field (`linkNameOffset`, always 0) as `rootGroupAddress`,
so any default-libver h5py file fails dataset discovery ("Unknown object header
version: 137" — it's parsing offset 0). Discovered by W001 while building the synthetic
fixture (see its Findings and the comments in
`test/unit/fixtures/generate-synthetic-h5.py`).

## Why it matters

Production NISAR files are superblock v2/v3 (paged aggregation) and unaffected — but
"drop any HDF5 in the browser" fails on the most common h5py default output, which is
exactly what casual/first-time users will try. Cheap fix, real funnel impact.

## Scope

- Correct the v0/v1 symbol-table-entry parse to read the object header address field
  (per the layout in `docs/HDF5_FILE_FORMAT.md` §6 — the STE is
  linkNameOffset(O) → objectHeaderAddress(O) → cacheType(4) → reserved(4) → scratch(16)).
- Add a second committed fixture generated with default h5py settings (superblock v0)
  and extend `test/unit/h5chunk-synthetic.test.mjs` to discover + read it.

## Out of scope

- B-tree v2 / any other h5chunk feature work.

## Acceptance criteria

- `npm test` and `npm run test:unit` pass; the new v0 fixture round-trips
  (discovery, readChunk, readRegion values match the generator's known pattern).
- Existing v2 fixture tests unchanged.
