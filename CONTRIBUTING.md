# Contributing to SARdine

SARdine is a browser-native SAR analysis tool. The app surface is split
across a family of URL-addressable pages under `app/pages/` that share
loaders, layers, algorithms, and utilities from `src/`. S290 is the
design doc that introduced this structure; S291–S295 track the phased
migration.

Before sending a PR, skim:

- [`CLAUDE.md`](CLAUDE.md) — project guide and coding conventions.
- [`docs/S290_APP_SEPARATION.md`](docs/S290_APP_SEPARATION.md) —
  architecture rules (R1–R8) that CI enforces.

## Local workflow

```bash
npm install
npm run dev            # Vite dev server at http://localhost:5173
npm test               # Node test suite + shared-usage check (R2, R3)
npm run lint           # ESLint, enforces R1 (no src/→app/ imports)
npm run test:e2e       # Playwright route smoke tests (R5)
npm run build          # Production build → dist/
```

## Code-review checklist

A PR that touches multiple pages, any `app/shared/*` file, or any
`src/*` file must have a review comment confirming each box:

- [ ] If this changes a shared component, loader, or utility, every page
      that consumes it still works — verified by `npm run test:e2e`.
- [ ] No new file in `src/` imports from `app/` (R1, caught by
      `npm run lint`).
- [ ] No new file in `app/shared/` has fewer than two callers across
      `app/pages/` (R2, caught by `npm run lint:shared`).
- [ ] No filename pattern suggests a fork — `*For*.jsx` or
      `*.<page>.jsx` is forbidden (R3, caught by `npm run lint:shared`).
      Extend via props, never copy-and-edit.
- [ ] Every loader, exporter, and algorithm has exactly one entry point
      in `src/`. Pages call it with parameters; they do not write thin
      wrappers (R4).
- [ ] Any new prop on a shared component has a sensible default so
      existing callers don't need updating.
- [ ] Every new or changed route has a Playwright smoke test in
      `test/e2e/` (R5).
- [ ] Page-level CSS does not override theme `--*` variables — SARdine
      chrome stays consistent across pages (R7).
- [ ] The build chrome (version + SHA footer) renders on every touched
      route (R8).
- [ ] One build per deploy — no per-route builds (R6).

## Adding a new route

1. Create `app/pages/<Name>.jsx`. Export a default React component.
2. Wire it into `app/main.jsx`'s `<Switch>`.
3. Update the `ROUTES` list in `app/pages/Landing.jsx` so the card
   appears on the chooser.
4. Add a spec under `test/e2e/<slug>.spec.js` that mounts the route
   and asserts at least one piece of meaningful UI.
5. If the page needs new dependencies in `src/`, extend the canonical
   entry points — do not copy-and-edit.

## Promoting code into `app/shared/`

`app/shared/` is for components that render the same way across
multiple pages. The bar is **two pages consume it today**, not "we'll
probably reuse this some day." Until the second consumer exists, keep
the component inlined in its one page. When the second page lands,
move the file and update both imports in the same commit — the
shared-usage check (`npm run lint:shared`) fails otherwise.

## Commit style

- Small, atomic commits. One logical change per commit.
- Commit message format: `<directive>: <imperative summary>`, e.g.
  `S291: hash-routed SPA shell`.
- Co-authored-by trailers when a commit was agent-assisted.
- Do not squash-merge the S291–S295 phase PRs — preserve the atomic
  extraction commits so `git log --follow` on `GCOVExplorer.jsx`
  reaches the original `main.jsx` history.
