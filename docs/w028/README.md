# W028 visual matrix — before / after

Captured with `test/visual-matrix.mjs` (puppeteer + the repo's own
`vite preview` build), so the comparison is reproducible rather than
hand-cropped:

```bash
npm run build && npx vite preview --port 4173 --strictPort &
node test/visual-matrix.mjs http://127.0.0.1:4173 docs/w028/after
```

`before/` is the same script run against `main` (8cc5a9e) in a scratch
worktree on port 4174.

## States

Three themes (`dark`, `sardine`, `light`) × four captures each:

| file | state |
|:--|:--|
| `*-01-nodata.png` | full window, no data loaded |
| `*-02-controlpanel.png` | control panel only, no data |
| `*-03-palette.png` | command palette open |
| `*-04-cog.png` | full window, COG loaded (Pacaya-Samiria HH deep link) |
| `*-05-cog-controlpanel.png` | control panel only, COG loaded |

## What to look at

**The command palette (`*-03`).** Before, it was hardcoded `#0d1620` on
`#e8edf5` and stayed dark navy over the light theme. After, it is a Dialog
built from tokens and follows all three themes.

**The control panel (`*-02`, `*-05`).** Before, `AUTO STRETCH (2–98%)`,
`GLOBAL`, `VIEWPORT`, `RELOAD`, `FIT VIEW` and `CHOOSE FILE...` all render
as solid-accent uppercase CTAs, because the global `button` rule *was* a
primary CTA and every button inherited it. After, they are quiet, and the
accent marks only the one selected segment. That is the whole point of
defaulting `Button` to `secondary`.

**Label typography (`*-05`).** `UI THEME` / `COLORMAP` / `STRETCH` now read
as one family of mono micro-labels, and each one names its control through
a generated `htmlFor`/`id` pair rather than sitting next to it.

## Not captured here

NISAR GCOV and compare-grid states need a local `.h5` chosen through a file
input; the harness drives a public deep link, so it can reach the COG states
but not those two. They were checked by hand. Extending the harness with
`elementHandle.uploadFile` and a small fixture granule is worth doing — it
would make the full 12-state matrix a CI artifact instead of a manual step.
