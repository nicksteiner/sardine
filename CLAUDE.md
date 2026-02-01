# SARdine - Claude Code Project Guide

This document provides context for Claude Code (or any AI coding assistant) to understand the SARdine project goals, architecture, and development phases.

## Project Overview

**SARdine** is a prompt-driven geospatial analysis tool for SAR (Synthetic Aperture Radar) imagery. The goal is to create an intuitive interface where users can:

1. Load and visualize SAR imagery (Cloud Optimized GeoTIFFs)
2. Adjust visualization parameters through natural language
3. Eventually run processing pipelines and compare results

The project is being developed in **7 phases**, each fully functional before moving to the next.

## Tech Stack

| Technology | Purpose |
|------------|---------|
| **React 18** | UI framework |
| **deck.gl 8.9** | WebGL map/image rendering |
| **geotiff.js** | Load Cloud Optimized GeoTIFFs (COGs) |
| **MapLibre GL** | Basemap rendering (Phase 4+) |
| **Vite** | Build tool and dev server |

### Key Design Decisions

- **No Viv dependency** - We use geotiff.js directly for COG loading
- **Minimal dependencies** - Keep the bundle lean
- **State as Markdown** - Human-readable state representation
- **COGs on S3** - Works with remote files, no special backend needed (until Phase 5)

## Project Structure

```
sardine/
├── app/                      # Main SARdine application
│   ├── index.html           # Entry HTML
│   └── main.jsx             # React app with Phase 1-2 features
├── src/                      # Core library (reusable components)
│   ├── index.js             # Main exports
│   ├── loaders/
│   │   └── cog-loader.js    # geotiff.js wrapper for COGs
│   ├── layers/
│   │   ├── SARTileLayer.js  # deck.gl layer with dB shader
│   │   └── shaders.js       # GLSL for dB scaling, colormaps
│   ├── viewers/
│   │   ├── SARViewer.jsx    # Basic orthographic viewer
│   │   ├── ComparisonViewer.jsx  # Side-by-side (Phase 6)
│   │   └── MapViewer.jsx    # With basemap (Phase 4)
│   └── utils/
│       ├── stats.js         # Histogram, auto-contrast
│       └── colormap.js      # Grayscale, viridis, etc.
├── examples/                 # Example usage
│   └── basic/
├── package.json
├── vite.config.js           # Main app config
└── vite.example.config.js   # Examples config
```

## Development Phases

### Phase 1: Basic Viewer ✅ COMPLETE

**Goal**: Load a COG and adjust contrast with sliders.

**Features**:
- Load COG from URL via geotiff.js
- Render with deck.gl TileLayer
- dB scaling shader (toggle on/off)
- Contrast limit sliders (min/max in dB)
- Grayscale + viridis colormap
- Auto-fit view to image bounds

**Key Files**: `app/main.jsx`, `src/loaders/cog-loader.js`, `src/layers/SARTileLayer.js`

---

### Phase 2: State as Markdown ✅ COMPLETE

**Goal**: Edit markdown to control the viewer.

**Features**:
- Visible state panel showing current state as markdown
- State updates live as you interact
- State is editable — change the markdown, viewer updates
- Bidirectional sync between UI and markdown

**State Format**:
```markdown
## State
- **File:** s3://bucket/flood.tif
- **Contrast:** -22 to -3 dB
- **Colormap:** grayscale
- **dB Mode:** on
- **View:** [lat, lon], zoom 12
```

**Key Files**: `app/main.jsx` (parseMarkdownState, generateMarkdownState functions)

---

### Phase 3: Chat Input 🔜 PLANNED

**Goal**: Type "increase contrast" and it does.

**Features**:
- Chat box for natural language input
- LLM sees current state markdown, returns updated state
- No code generation — just state changes
- Examples: "brighten it up", "show me just the dark areas", "zoom to the river"

**Implementation Notes**:
- Will need LLM API integration (OpenAI, Anthropic, or local)
- State changes only, no autonomy
- Prompt: `current_state + user_message → updated_state`

---

### Phase 4: Basemap + Annotations 🔜 PLANNED

**Goal**: Draw on the map and reference drawings in chat.

**Features**:
- Add MapLibre basemap under SAR layer
- User can draw polygons
- Polygons added to state with labels
- Chat can reference annotations: "ignore areas like poly_2"

**State Addition**:
```markdown
## Annotations
- poly_1: "flood" [geojson]
- poly_2: "false positive - building" [geojson]
```

**Key Files**: `src/viewers/MapViewer.jsx` (already exists, needs drawing tools)

---

### Phase 5: Processing Backend Hook 🔜 PLANNED

**Goal**: Say "lower the threshold" → backend reruns → see new result.

**Features**:
- Connect to processing backend (Nextflow or Python script)
- State includes `## Parameters` section
- Chat can modify parameters
- "Rerun" button triggers backend
- Backend outputs new COG, viewer auto-loads it

**State Addition**:
```markdown
## Parameters
| param | value |
|-------|-------|
| vv_threshold | -15 dB |
| min_area | 500 px |
```

---

### Phase 6: Comparison Mode 🔜 PLANNED

**Goal**: Compare two results and talk about differences.

**Features**:
- Side-by-side view (before/after or two dates)
- Linked pan/zoom
- Chat understands both: "the left one is better near the river"
- Diff mode: highlight changes between outputs

**Key Files**: `src/viewers/ComparisonViewer.jsx` (already exists, needs enhancement)

---

### Phase 7: History + Rollback 🔜 PLANNED

**Goal**: Undo via chat or timeline scrubber.

**Features**:
- Every state change saved with timestamp
- Can scrub through history
- "Go back to when the river looked right"
- Export state history as reproducibility log

---

## Development Commands

```bash
# Install dependencies
npm install

# Start dev server (main app)
npm run dev

# Start example viewer
npm run example

# Build for production
npm run build
```

## Coding Guidelines

### When Adding Features

1. **Phase-by-phase** - Each phase ships standalone. No "I'll need this later" scaffolding.
2. **Minimal changes** - Keep diffs small and focused.
3. **State is human-readable** - No hidden config. Everything in markdown.
4. **Test with real COGs** - Use actual SAR imagery for testing.

### Code Style

- React functional components with hooks
- ES modules (import/export)
- No TypeScript (keeping it simple for now)
- JSX for React components (.jsx extension)

### Key Patterns

**State Management** (Phase 2):
```javascript
// Parse markdown → object
const state = parseMarkdownState(markdown);

// Object → markdown
const markdown = generateMarkdownState(state);
```

**COG Loading**:
```javascript
const { getTile, bounds } = await loadCOG(url);
```

**Viewer Component**:
```jsx
<SARViewer
  getTile={getTile}
  bounds={bounds}
  contrastLimits={[min, max]}
  useDecibels={true}
  colormap="viridis"
/>
```

## Success Criteria

After Phase 5, a user should be able to:

1. Load a SAR scene
2. Say "detect flooding, ignore urban areas"
3. See result
4. Say "too aggressive on the edges"
5. See updated result
6. Export final product

**Without writing code. Without opening QGIS. Without touching a config file.**

## Future Ideas (Not Yet Planned)

- Multi-user sessions (share with collaborator)
- Voice input
- Agent suggests changes proactively
- Fine-tune model on user corrections
- Generalize beyond SAR (any raster analysis)
