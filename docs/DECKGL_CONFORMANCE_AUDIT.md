# deck.gl Conformance Audit

**Date:** 2026-03-04

An audit of SARdine's deck.gl usage against standard patterns used by production geospatial applications (Uber, CARTO, Foursquare/Kepler.gl).

---

## Standard deck.gl Use Cases vs. SARdine

| Use Case | Standard deck.gl App | SARdine |
|----------|---------------------|---------|
| **Data source** | Vector tiles (MVT), GeoJSON, point clouds | HDF5 chunks (h5chunk), COG tiles (geotiff.js) |
| **Layer type** | ScatterplotLayer, GeoJsonLayer, TileLayer | Custom SARGPULayer, SARTileLayer, SARBitmapLayer |
| **Rendering** | Built-in deck.gl shaders | Custom GLSL (dB scale, colormaps, stretch modes) |
| **Data loading** | loaders.gl or fetch + parse | Custom loaders (h5chunk, geotiff.js) |
| **Basemap** | Mapbox GL / MapLibre / Google Maps | MapLibre GL |
| **Interactivity** | Tooltips, picking, brushing | Viewport-driven chunk loading, contrast controls |
| **Export** | Screenshot via preserveDrawingBuffer | GeoTIFF export (raw + rendered), figure PNG |

SARdine follows the same architecture as standard deck.gl apps. The divergence is in data format (HDF5/COG vs. vector tiles) and shader customization (SAR-specific processing). Both are expected patterns — deck.gl is designed for exactly this kind of extension.

---

## Audit Results by Component

### Layer Implementations

#### SARGPULayer.js — COMPLIANT

The primary rendering layer. Follows deck.gl patterns correctly:

- **Lifecycle**: Implements `initializeState()`, `updateState()`, `finalizeState()` — the full deck.gl layer lifecycle
- **Resource cleanup**: Textures explicitly deleted in `finalizeState()` and before reassignment in `updateState()`
- **Context loss**: Registers `webglcontextlost` / `webglcontextrestored` listeners with proper cleanup
- **Shader modules**: Uses `project32` and `picking` modules correctly
- **Static geometry**: Returns `getNumInstances() = 0` — correct for a single-quad layer (not instanced)

**Issues found:**
| Location | Issue | Severity |
|----------|-------|----------|
| `defaultProps` | `compare: false` on Float32Array props requires callers to always create new array references on data change | Low — works correctly but fragile |
| `_createR32FTexture()` | NaN padding for undersized data assumes shader handles NaN — implicit contract | Low — shader does handle it, but undocumented |

---

#### SARGPUBitmapLayer.js — NON-CONFORMANT

Extends BitmapLayer with GPU shader injection. Has several best-practice violations:

| Location | Issue | Severity | Fix |
|----------|-------|----------|-----|
| Line 173-174 | **Props mutation via `Object.assign(props, newProps)`** — modifies the props object directly, which deck.gl does not expect. Can cause stale state and missed updates. | **High** | Create a new props object: `props = {...props, ...newProps}` |
| Line 150-164 | Allocates new `ImageData` (4 MB at 512×512) on every data update | Medium | Reuse ImageData if dimensions haven't changed |
| Missing | No `finalizeState()` — state cleanup relies entirely on GC | Medium | Add explicit cleanup |
| Missing | No `super.initializeState()` call | Low | Add for safety |

---

#### SARBitmapLayer.js — COMPLIANT (with dead code)

Extends BitmapLayer correctly. Minimal custom logic.

| Location | Issue | Severity | Fix |
|----------|-------|----------|-----|
| Lines 54-79 | `_createR32FTexture()` is dead code — defined but never called | Low | Remove |

---

#### SARTileLayer.js — EXCELLENT

Best deck.gl conformance in the codebase. Should be the reference pattern for other layers.

- **updateTriggers**: Correctly configured to force sublayer re-render on visual param changes (colormap, contrast, stretch) without refetching tile data
- **Stable getTileData**: Extracted to an external function, preventing unnecessary tile refetches when visual params change
- **renderSubLayers**: Creates fresh SARGPULayer instances per tile — correct pattern

This is how deck.gl TileLayer should be used: cache raw data in `getTileData`, apply rendering in `renderSubLayers`.

---

#### SARTiledCOGLayer.js — PARTIALLY CONFORMANT

| Location | Issue | Severity | Fix |
|----------|-------|----------|-----|
| Line 38-40 | `shouldUpdateState()` returns `changeFlags.somethingChanged` — always true, triggers updates on every render | **Medium** | Use specific flags: `changeFlags.viewportChanged \|\| changeFlags.propsChanged` |
| Line 366 | Reads `this.context.viewport` directly instead of using deck.gl change detection | Medium | Rely on `shouldUpdateState` + `updateState` pattern |
| Line 33-35 | `finalizeState()` clears caches but doesn't delete textures of rendered tiles | Low | Tiles use SARBitmapLayer which doesn't hold GPU resources directly |

**Positive**: LRU tile cache with concurrent load limit (4) is good resource management.

---

#### OvertureLayer.js — COMPLIANT

Thin wrapper around GeoJsonLayer. No custom lifecycle, no resource concerns. Correct.

---

### Shader Usage (shaders.js)

**Pattern**: GLSL colormap functions exported as string constants, injected into fragment shaders via deck.gl shader hooks (`fs:#decl`, `fs:DECKGL_FILTER_COLOR`).

This is the standard deck.gl shader extension pattern. Well implemented.

| Location | Issue | Severity | Fix |
|----------|-------|----------|-----|
| shaders.js line 44 vs SARGPULayer | `uniform bool uUseDecibels` declared but set as float in some paths | Low | Standardize to `float` everywhere |

---

### Viewer Components

#### SARViewer.jsx — EXCELLENT

- Stable `stableGetTileData` via `useMemo` prevents tile refetching on visual changes
- `glOptions={{ preserveDrawingBuffer: true }}` for canvas capture
- Proper `forwardRef` to expose canvas for figure export
- `redrawTick` state forces layer recreation after canvas capture — functional workaround

#### MapViewer.jsx — COMPLIANT

- MapLibre initialized in `useEffect` with proper cleanup
- View synchronization between MapLibre and DeckGL works correctly
- Uses `MapView` with `repeat: true`

#### ComparisonViewer.jsx — COMPLIANT

- Two isolated DeckGL instances with synchronized viewState
- SwipeComparisonViewer uses `clipPath` + two DeckGL instances — correct approach

---

### Data Loading

SARdine uses **custom loaders** (h5chunk, geotiff.js) rather than loaders.gl. This is appropriate:

- loaders.gl has no HDF5 loader
- loaders.gl's GeoTIFF support doesn't handle the SAR-specific streaming pattern (viewport-aware chunk fetching)
- The loaders correctly separate data concerns from rendering concerns — they return raw Float32Arrays that layers consume

No conformance issues with the loading architecture.

---

## Cross-Cutting Concerns

### Fragment Shader Masking: `alpha = 0` vs `discard`

All fragment shaders use `alpha = 0.0` for NaN/zero masking instead of `discard`:

| File | Line | Pattern |
|------|------|---------|
| shaders.js | 232 | `float alpha = (amplitude == 0.0 \|\| isnan(amplitude)) ? 0.0 : 1.0;` |
| SARGPULayer.js | 116 | `float alpha = anyValid ? 1.0 : 0.0;` (RGB composite) |
| SARGPULayer.js | 154 | `float alpha = (amplitude == 0.0 \|\| isnan(amplitude)) ? 0.0 : 1.0;` |
| SARGPUBitmapLayer.js | 92 | Same pattern |

**deck.gl recommendation**: Use `discard` for early fragment rejection — it's faster and doesn't pollute the depth buffer. The current approach works visually but wastes GPU cycles on transparent pixels.

### React Callback Memoization

Core viewer callbacks are properly wrapped in `useCallback`:
- `SARViewer.jsx:67` — `stableGetTileData`
- `MapViewer.jsx:102` — `handleViewStateChange`
- `app/main.jsx:633` — `addStatusLog`
- `app/main.jsx:1121` — `handleViewStateChange`

However, **~24 inline arrow functions** in `app/main.jsx` are not wrapped. Most are UI event handlers (button clicks, toggles) that don't affect layer rendering directly, so the impact is low. The ones in `ComparisonViewer.jsx:352,369` (`onViewStateChange`) are more concerning since they fire every frame during pan/zoom.

### Layer `id` Props

All layer instantiations have explicit `id` props. No violations found across SARViewer, MapViewer, ComparisonViewer, and SARTileLayer sublayer creation.

### Data Prop Memoization

Layer arrays are consistently memoized with `useMemo` in all viewers:
- `SARViewer.jsx:168` — `const layers = useMemo(() => [...])`
- `MapViewer.jsx:113` — `const layers = useMemo(() => [...])`
- `ComparisonViewer.jsx:147,279,295` — All layer arrays memoized

### Multiple WebGL Contexts

ComparisonViewer creates 2 DeckGL instances (side-by-side and swipe modes). This is inherent to the comparison use case — deck.gl doesn't support split-view rendering within a single context. Risk is low unless multiple comparison viewers are mounted simultaneously (browser limit is typically 8-16 contexts).

### `getShaders()` as Overridable Method

Both custom layers define `getShaders()` correctly:
- `SARGPULayer.js:174` — Returns `{ vs, fs, modules: [project32, picking] }`
- `SARGPUBitmapLayer.js:18` — Extends parent: `const shaders = super.getShaders(); return { ...shaders, inject: {...} }`

---

## Summary

### What SARdine Does Well

1. **SARGPULayer lifecycle** — Full initializeState/updateState/finalizeState with proper resource cleanup and context loss handling
2. **SARTileLayer updateTriggers** — Textbook deck.gl pattern: visual param changes re-render without refetching data
3. **Shader extension** — Uses deck.gl's shader hook system correctly via `getShaders()`
4. **Layer identity** — All layers have explicit `id` props
5. **Data memoization** — Layer arrays consistently wrapped in `useMemo`
6. **Data/rendering separation** — Loaders return raw data, layers handle GPU rendering

### What Needs Fixing

| Priority | Issue | Component | Fix |
|----------|-------|-----------|-----|
| **High** | Props mutation via `Object.assign()` | SARGPUBitmapLayer:173 | `props = {...props, ...newProps}` |
| **Medium** | `shouldUpdateState()` always returns true | SARTiledCOGLayer:38 | Check specific changeFlags |
| **Medium** | `alpha = 0` instead of `discard` in shaders | All fragment shaders | Add `if (alpha == 0.0) discard;` |
| **Medium** | 4 MB ImageData allocation per update | SARGPUBitmapLayer:150 | Reuse if dimensions unchanged |
| **Low** | Inline `onViewStateChange` in ComparisonViewer | ComparisonViewer:352,369 | Wrap in `useCallback` |
| **Low** | Dead code (`_createR32FTexture`) | SARBitmapLayer:54 | Remove |
| **Low** | Bool/float uniform type inconsistency | shaders.js:44 | Standardize to float |

### Conformance Score

- **5 of 6 layers** are compliant or excellent
- **3 of 3 viewers** are compliant or excellent
- **Shader system** follows standard deck.gl patterns (with `discard` optimization opportunity)
- **React integration** follows best practices (memoization, stable callbacks, explicit IDs)
- **Data loading** is appropriately custom (no loaders.gl equivalent exists)

**Overall**: SARdine is a well-structured deck.gl application that follows industry patterns. The architecture matches how Uber, CARTO, and Foursquare build production geospatial apps. The high-priority fix (SARGPUBitmapLayer props mutation) should be addressed to prevent subtle state bugs. The `discard` optimization is a quick win for shader performance. SARTileLayer should be used as the internal reference for how to build deck.gl layers correctly.
