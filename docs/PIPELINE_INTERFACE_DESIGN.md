# Pipeline Interface Design: Flow Graph vs Code Editor

## The Question

How should SARdine expose GPU inference and model composition — as a ComfyUI-style
node graph or an Earth Engine-style code editor — given the expectation that an
agent will be the primary operator?

## Recommendation: Flow Graph (DAG), Schema-First

**Use the flow graph model, but build the JSON schema first, not the visual editor.**

The visual canvas is a nice-to-have for human inspection. The primary interface is
a typed, serializable graph that an agent manipulates via structured operations.

## Why Not Earth Engine

Earth Engine's model is a lazy computation DSL:

```js
var ratio = ee.Image('NISAR/GCOV/...').select('HHHH')
  .divide(ee.Image('NISAR/GCOV/...').select('HVHV'))
  .log10().multiply(10);
```

This is elegant for humans who write code. But:

1. **"Coding won't matter"** — this is literally a code editor. The interface IS
   writing code. An agent generating EE-style code is just an LLM producing
   strings that happen to parse. No structural guarantee of correctness.

2. **Infinite action space** — the agent can produce any valid (or invalid)
   JavaScript. Every token is a decision. A graph editor constrains the space
   to: which node types exist, which ports are compatible, which parameters
   are valid ranges.

3. **Partial modification is fragile** — to change one step the agent must
   rewrite or splice code. Line edits break easily. A graph operation is
   atomic: `setParam(nodeId, key, value)` or `connect(src, dst)`.

4. **Intermediate inspection requires instrumentation** — in EE you evaluate
   the whole chain. In a graph, every node output is independently observable.
   An agent needs this to evaluate whether its actions worked.

The EE model makes coding efficient. We're designing for a world where the
operator doesn't code.

## Why Flow Graph

### It matches the GPU execution model

SARdine's current rendering pipeline is already a fixed-function chain of GPU
operations encoded in a single monolithic fragment shader:

```
R32F texture → dB scale → normalize → stretch → colormap → RGBA
```

Each of these is logically a separate render pass. The flow graph makes this
explicit. Each node becomes a shader program + framebuffer object (FBO). Edges
are textures. This is how GPU compute pipelines actually work — the graph IS
the execution plan.

### Current pipeline mapped to nodes

```
┌──────────┐    ┌─────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
│ LoadNode │───→│ dBNode  │───→│StretchNode│───→│ColorNode │───→│ Display  │
│ R32F out │    │ R32F→R32F│    │ R32F→R32F │    │ R32F→RGBA│    │ RGBA     │
└──────────┘    └─────────┘    └───────────┘    └──────────┘    └──────────┘
```

To add inference (e.g. flood detection), an agent inserts a node:

```
LoadNode → dBNode → [FloodModelNode] → ThresholdNode → MaskOverlay → Display
                         ↑
                    ONNX Runtime Web
                    (WebGPU backend)
```

No code written. The agent's action is:
```json
{
  "action": "insertNode",
  "after": "dBNode",
  "type": "inference",
  "params": {
    "model": "flood-detection-v2",
    "backend": "webgpu"
  }
}
```

### Structured action space for agents

An agent operating on a flow graph has a finite, typed set of operations:

| Operation | Parameters | Validation |
|-----------|-----------|------------|
| `addNode` | `type`, `params` | Type must be in registry |
| `removeNode` | `nodeId` | Cannot remove source/sink |
| `connect` | `srcNode:port → dstNode:port` | Port types must match (R32F↔R32F, RGBA↔RGBA) |
| `disconnect` | `edgeId` | Edge must exist |
| `setParam` | `nodeId`, `key`, `value` | Value must be in valid range |
| `getOutput` | `nodeId` | Returns thumbnail or stats for inspection |

This is a well-defined action space. The agent explores a graph of valid states,
not an infinite string space. Type constraints on ports eliminate entire
categories of invalid pipelines.

### Observable intermediate state

An agent needs to evaluate whether its actions worked. In a flow graph, it can:

1. Sample the output texture of any node (thumbnail, histogram, stats)
2. Compare before/after when a parameter changes
3. Identify where a pipeline breaks (which node produces NaN/black)

This is critical for autonomous operation. The agent doesn't just produce a
pipeline — it iterates on it, using intermediate observations to refine.

### Inference nodes map naturally

Browser-native ML inference options:

| Runtime | Backend | Tensor Format | SARdine Compat |
|---------|---------|---------------|----------------|
| ONNX Runtime Web | WebGPU | Float32Array / GPUBuffer | Direct — same as R32F textures |
| TensorFlow.js | WebGPU | tf.Tensor (Float32) | Copy via `.data()` |
| Transformers.js | ONNX (WebGPU) | Float32Array | Direct |
| Custom WebGPU compute | Compute shaders | GPUBuffer | Direct (requires WebGPU migration path) |

All of these consume and produce Float32 buffers — exactly what flows between
SARdine's existing pipeline stages. An inference node is:

```
Input:  R32F texture (read back to Float32Array or share GPUBuffer)
Process: model.run({ input: tensor })
Output: R32F texture (upload result as texture for next node)
```

The 256×256 tile size is manageable for lightweight models. For heavier models
(U-Net, SegFormer), batch tiles and run inference asynchronously, displaying
a progressive result like the existing refinement system (nisar-loader.js:4060).

## What ComfyUI Gets Wrong (for our case)

ComfyUI is visual-first. The graph is something a human drags and drops. For
SARdine, the graph is something an agent constructs programmatically. Key
differences:

1. **No layout engine needed** — the agent doesn't care about x,y positions of
   nodes on a canvas. The graph is topological, not spatial.

2. **No widget UI per node** — parameter controls are for the agent to set via
   structured operations, not for a human to twiddle with sliders. (A human
   override panel can exist, but it's not the primary interface.)

3. **Execution is real-time, not batch** — ComfyUI queues a generation and
   waits. SARdine renders at 60fps. The graph executes every frame (or on
   parameter change). This means nodes must be GPU-fast or async with caching.

4. **Tile-based execution** — SARdine processes 256×256 tiles, not full images.
   The graph executes per-tile. This is important for memory and for progressive
   rendering.

## Concrete Schema

The pipeline graph as a JSON document:

```json
{
  "nodes": {
    "load": {
      "type": "nisar-gcov",
      "params": { "dataset": "HHHH", "frequency": "frequencyA" }
    },
    "db": {
      "type": "decibel",
      "params": {}
    },
    "flood": {
      "type": "inference",
      "params": {
        "model": "flood-sar-unet-v2",
        "runtime": "onnx",
        "threshold": 0.5
      }
    },
    "render": {
      "type": "colormap",
      "params": {
        "map": "flood",
        "stretch": "sigmoid",
        "gamma": 0.8,
        "min": -25,
        "max": 0
      }
    }
  },
  "edges": [
    ["load:out", "db:in"],
    ["db:out", "flood:in"],
    ["flood:mask", "render:mask"],
    ["db:out", "render:in"]
  ]
}
```

The agent produces this. The engine executes it. The visual editor (if built)
renders it. The chat interface translates "show me flooding" into graph mutations.

## Node Type Registry

Each node type declares its ports, parameters, and execution function:

```js
const nodeTypes = {
  'nisar-gcov': {
    ports: { out: 'r32f' },
    params: {
      dataset: { type: 'enum', values: ['HHHH','HVHV','VHVH','VVVV'] },
      frequency: { type: 'enum', values: ['frequencyA','frequencyB'] },
    },
    execute: async (params, inputs, tile) => { /* getTile() */ },
  },
  'decibel': {
    ports: { in: 'r32f', out: 'r32f' },
    params: {},
    execute: (params, inputs) => { /* 10*log10 shader or CPU */ },
  },
  'inference': {
    ports: { in: 'r32f', mask: 'r32f', out: 'r32f' },
    params: {
      model: { type: 'string' },
      runtime: { type: 'enum', values: ['onnx', 'tfjs', 'webgpu'] },
      threshold: { type: 'float', min: 0, max: 1 },
    },
    execute: async (params, inputs, tile) => { /* ONNX Runtime Web */ },
  },
  'colormap': {
    ports: { in: 'r32f', mask: 'r32f?', out: 'rgba' },
    params: {
      map: { type: 'enum', values: ['grayscale','viridis','inferno','flood'] },
      stretch: { type: 'enum', values: ['linear','sqrt','gamma','sigmoid'] },
      gamma: { type: 'float', min: 0.1, max: 5.0 },
      min: { type: 'float' },
      max: { type: 'float' },
    },
    execute: (params, inputs) => { /* fragment shader */ },
  },
};
```

The agent can query this registry to discover what's available. Port types
enforce valid connections. Parameter schemas enable the agent to enumerate
valid values rather than guess.

## Migration Path from Current Architecture

SARdine's current monolithic fragment shader (SARGPULayer.js:33–165) does
dB + stretch + colormap in a single pass. This is efficient. The migration
doesn't break this — it wraps it:

**Phase 1: Schema + engine (no visual editor)**
- Define the graph JSON schema and node type registry
- The existing `SARGPULayer` fragment shader becomes the default "fast path"
  for the common `load → dB → stretch → colormap` chain (fused into one pass)
- The graph engine detects this common subgraph and delegates to the existing
  shader. No performance regression.
- Non-standard graphs (with inference nodes, branches, custom ops) execute as
  multi-pass FBO chains.

**Phase 2: Agent interface**
- Chat/prompt interface translates natural language into graph mutations
- "Show me VV/VH ratio in viridis" → agent constructs graph with ratio node
- "Run flood detection" → agent inserts inference node
- Agent can inspect intermediate outputs to validate

**Phase 3: Visual editor (optional)**
- Render the graph as a node canvas for human inspection/override
- Not the primary interface — the agent is

**Phase 4: WebGPU migration**
- Replace WebGL2 FBO chain with WebGPU compute pipeline
- Inference nodes share GPUBuffers directly with render nodes (zero-copy)
- Compute shaders replace fragment shaders for non-display processing

## What This Means for the Existing Code

| File | Change |
|------|--------|
| `shaders.js` | Break monolithic shader into composable shader fragments per node type |
| `SARGPULayer.js` | Becomes the "fused fast path" executor for common subgraphs |
| `sar-composites.js` | Composite presets become pre-built graph templates |
| `nisar-loader.js` | `getTile()` becomes the `execute` function of `LoadNode` |
| `colormap.js`, `stretch.js` | Each becomes a node type's parameter schema + execute function |
| New: `graph-engine.js` | Topological sort, FBO management, per-tile execution |
| New: `node-registry.js` | Node type definitions, port types, parameter schemas |
| New: `inference-node.js` | ONNX Runtime Web wrapper as a graph node |

## Summary

| Criterion | Earth Engine (code) | Flow Graph (DAG) |
|-----------|-------------------|-----------------|
| Agent action space | Infinite (strings) | Finite (typed ops) |
| Validation | Runtime errors | Schema + port types |
| Intermediate inspection | Requires eval | Every node observable |
| GPU mapping | Opaque (lazy eval) | Direct (node = render pass) |
| Inference integration | Library call in code | Typed node with ports |
| Human override | Edit code | Visual editor or param panel |
| Coding required | Yes (the interface IS code) | No |
| Composability | Unlimited but unconstrained | Constrained by type system |

The flow graph wins on every axis that matters for agent-first operation.
Build the schema and execution engine. The visual editor is Phase 3.
