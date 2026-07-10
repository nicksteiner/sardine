# W012 — Publish the substrate

wave: 4
status: todo
blocked_by: [W010, W011]
branch: w012-publish

## Objective

Convert internal artifacts into the platform layer other people build on.

## Components

1. **h5chunk to npm** — `~/sandbox/sardine-agent/packages/h5chunk/` is the packaging
   point; converge sardine + sardine-agent to import it (ends the copied-loader drift).
   README with the COG-analogy pitch; NISAR + ICESat-2 examples.
2. **Schemas as draft STAC extensions** — SessionState/RenderConfig ("presentation
   state") and the markup/label bundle, published as draft extension repos with
   SARdine as reference implementation.
3. **Public demo instance** — static hosting (no server needed) + a curated set of
   deep links to public NISAR granules; "View in SARdine" snippet for docs/papers.
   COOP/COEP headers if W006 workers need them (verify — plain Workers don't;
   SharedArrayBuffer would).

## Acceptance criteria

- `npm install @sardine/h5chunk` (or chosen scope) works in a fresh project and opens
  a NISAR file in Node.
- Both repos' loaders import the package (no divergent copies remain).
- Demo URL renders a public granule from a cold cache in seconds; deep links from
  W008 work on it.
