# Accessibility baseline (W029)

SARdine targets **WCAG 2.1 AA**. This page records what that means here, what
is enforced automatically, and what was verified by running the app.

## Enforced on every `npm test`

`test/unit/a11y-static.test.mjs` fails the build on any of:

| Check | Rule |
|:---|:---|
| Glyph buttons | a `<button>` that can only render glyphs must carry `aria-label` |
| Form controls | every `input`/`select`/`textarea` must have `aria-label`, `aria-labelledby`, an associated `<label htmlFor>`, or a wrapping `<label>` |
| Click targets | a `div`/`span` with `onClick` must have role + `tabIndex` + `onKeyDown` (the `clickable`/`disclosure`/`option` helpers supply all three) |
| Canvases | every `<canvas>` needs `aria-label` or `aria-hidden` |
| Focus | no bare `outline: none` outside the one sanctioned `:focus:not(:focus-visible)` rule |
| Theme | `:focus-visible` ring exists; a `prefers-reduced-motion` block exists and names all three infinite animations |
| Live regions | polite + assertive regions exist and are wired to the load lifecycle |
| Contrast | `--text-muted` and `--text-disabled` computed against every background in all three themes, ≥ 4.5:1 |

## Verified by running the app

`npm run build && npm run test:a11y` drives the built app in headless Chrome
with the keyboard only. It opens every rail panel, expands every collapsible
section, and Tabs through the whole control surface with a scene loaded,
recording each stop's resolved accessible name and *computed* focus outline.

Result on the current build — a Pacaya-Samiria HH COG streamed from Hugging
Face, the same scene as the README hero:


```
LIVE REGIONS during load:
  polite: Loading Cloud Optimized GeoTIFF
  polite: Cloud Optimized GeoTIFF loaded

KEYBOARD WALK — 85 focus stops

    ok  <button role=tab>              Data
    ok  <button>                       Commands
    ok  <button type=button>           Data Source
    ok  <select>                       Data source
    ok  <button type=button>           Earthdata Login
    ok  <input type=password>          EDL token
    ok  <a>                            Open Earthdata profile →
    ok  <a>                            revoke them anytime
    ok  <button>                       ⟳ Reload
    ok  <button>                       ⊞ Fit View
    ok  <div role=group>               Main viewer
    ok  <div role=application>         SAR image viewer — arrow keys pan, plus and minus zo
    ok  <button>                       Zoom to data extent
    ok  <div role=button>              Show satellite view
    ok  <div role=button>              Show overview map
    ok  <div role=button>              Metadata panel
    ok  <button>                       Redraw histogram
    ok  <button>                       SVG
    ok  <button>                       ×
    ok  <div role=button>              Open the status log, 31 messages
    ok  <a>                            SARdine
    ok  <input type=range>             Decode worker count
    ok  <button role=tab>              Display
    ok  <button type=button>           Display
    ok  <select>                       UI Theme
    ok  <select>                       Colormap
    ok  <input type=checkbox>          Reverse
    ok  <input type=checkbox>          dB Scaling
    ok  <input type=checkbox>          Coordinate Grid
    ok  <input type=checkbox>          Pixel Explorer
    ok  <button type=button>           Contrast
    ok  <button>                       Histogram scope: Global
    ok  <button>                       Histogram scope: Viewport
    ok  <button>                       Auto Stretch (2–98%)
    ok  <span role=button>             contrast minimum decibels, -7.0 dB. Activate to type
    ok  <input type=range>             contrast minimum decibels
    ok  <span role=button>             contrast maximum decibels, -2.0 dB. Activate to type
    ok  <input type=range>             contrast maximum decibels
    ok  <span role=spinbutton>         dB
    ok  <input type=range>             Brightness
    ok  <span role=spinbutton>         min
    ok  <span role=spinbutton>         max
    ok  <select>                       Stretch
    ok  <button role=tab>              Analyze
    ok  <button type=button>           Region of Interest
    ok  <input type=text>              Region of interest as WKT
    ok  <button type=button>           Annotate
    ok  <button>                       Annotation tool: off
    ok  <button>                       Annotation tool: arrow
    ok  <button>                       Annotation tool: text
    ok  <button>                       Annotation size: small
    ok  <button>                       Annotation size: medium
    ok  <button>                       Annotation size: large
    ok  <button>                       Annotation colour: red
    ok  <button>                       Annotation colour: amber
    ok  <button>                       Annotation colour: yellow
    ok  <button>                       Annotation colour: green
    ok  <button>                       Annotation colour: blue
    ok  <button>                       Annotation colour: white
    ok  <button>                       Load Markup
    ok  <button type=button>           Models
    ok  <button>                       Load model…
    ok  <button role=tab>              Layers
    ok  <button type=button>           Overture Maps
    ok  <input type=checkbox>          Enable Overlay
    ok  <button type=button>           Optical Peek
    ok  <button type=button>           Export Settings
    ok  <button>                       None
    ok  <button>                       2×2
    ok  <button>                       4×4
    ok  <button>                       8×8
    ok  <button>                       16×16
    ok  <button>                       Export as Raw
    ok  <button>                       Export as Displayed
    ok  <button type=button>           Export
    ok  <button>                       Export GeoTIFF (Float32)
    ok  <button>                       Save Figure (PNG)
    ok  <button>                       Save Figure (GeoTIFF)
    ok  <button>                       Figure style: Publication
    ok  <button>                       Figure style: Presentation
    ok  <button>                       Figure grid: Lines
    ok  <button>                       Figure grid: Ticks
    ok  <button>                       Figure grid: Off
    ok  <input type=text>              Colorbar label
    ok  <input type=checkbox>          Add attribution to PNG

unnamed: 0   no focus ring: 0   focusable but invisible: 0
```

The walk covers the acceptance path end to end: load a COG (deep link, load
announced), adjust contrast (`contrast minimum decibels` / `contrast maximum
decibels` sliders, the editable min/max spans, Auto Stretch, histogram scope),
draw an ROI (the WKT field and the ROI section), and export (multilook window,
raw vs displayed, GeoTIFF, figure PNG, figure style and grid).

Failure announcement was verified separately against a 404 URL:

```
polite:    Loading Cloud Optimized GeoTIFF
polite:    Cloud Optimized GeoTIFF could not be loaded
assertive: Failed to load COG: Request failed
```

## Design decisions

**Announce transitions, not progress.** The app emits hundreds of status-log
lines per session. Only load start, finish and failure reach the polite
region, debounced by 300 ms; failures also interrupt via `role="alert"`.
Failures are routed from the single `addStatusLog` funnel, which covers every
`catch` block in the app without touching any of them.

**Overlay chrome uses ink + halo, never a flat fill.** No single colour clears
3:1 across a dB greyscale ramp — white and black each bottom out at 1.00:1
somewhere in the range. `--overlay-ink` and `--overlay-halo` must be used
together for anything drawn over imagery.

**The raster is out of the alt model.** The deck.gl canvas is the data, not a
picture of something describable. Its wrapper is a real tab stop (deck.gl's
controller takes the arrow keys), so it is *named* and given a focus ring —
but it gets no alt text, by design. Overlay chrome is in scope; the imagery
is not.

**Colour is never the only channel.** The RGB histogram traces carry a dash
pattern per channel, repeated in the legend swatch — red and green are the
classic deuteranopia confusion pair.

**Motion.** A NISAR load runs for minutes and the spinner and pulse run for
its whole duration. Under `prefers-reduced-motion` all three infinite
animations stop; `!important` is required because two of them are inline
styles.
